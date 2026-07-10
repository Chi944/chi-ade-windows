import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import {
	remoteHosts,
	remoteWorkspaceBindings,
	workspaces,
} from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "../local-db";
import { getDaemonTerminalManager } from "../terminal";
import { buildSshTunnelLaunch } from "./ssh";

export type SshTunnelState =
	| "stopped"
	| "connecting"
	| "connected"
	| "retrying"
	| "error";

export interface SshTunnelStatus {
	workspaceId: string;
	state: SshTunnelState;
	updatedAt: number;
	error?: string;
}

const MAX_ERROR_LENGTH = 500;
// biome-ignore lint/complexity/useRegexLiterals: string form avoids a literal control character
const ANSI_ESCAPE = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g");

export function sshTunnelPaneId(workspaceId: string): string {
	const suffix = createHash("sha256")
		.update(workspaceId)
		.digest("hex")
		.slice(0, 24);
	return `remote-tunnel-${suffix}`;
}

class SshTunnelManager extends EventEmitter {
	private readonly terminal = getDaemonTerminalManager();
	private readonly statuses = new Map<string, SshTunnelStatus>();
	private readonly paneWorkspaces = new Map<string, string>();
	private readonly retries = new Map<string, number>();
	private readonly retryTimers = new Map<string, NodeJS.Timeout>();
	private readonly stableTimers = new Map<string, NodeJS.Timeout>();
	private readonly inFlight = new Map<string, Promise<SshTunnelStatus>>();
	private readonly outputListeners = new Set<string>();
	private readonly lastOutput = new Map<string, string>();

	constructor() {
		super();
		this.terminal.on("terminalExit", (event: unknown) => {
			const paneId = (event as { paneId?: string }).paneId;
			if (!paneId) return;
			const workspaceId = this.paneWorkspaces.get(paneId);
			if (!workspaceId) return;
			void this.handleUnexpectedExit(workspaceId);
		});
	}

	getStatus(workspaceId: string): SshTunnelStatus {
		return (
			this.statuses.get(workspaceId) ?? {
				workspaceId,
				state: "stopped",
				updatedAt: Date.now(),
			}
		);
	}

	async ensure(workspaceId: string): Promise<SshTunnelStatus> {
		const pending = this.inFlight.get(workspaceId);
		if (pending) return pending;

		const promise = this.ensureNow(workspaceId).finally(() => {
			if (this.inFlight.get(workspaceId) === promise) {
				this.inFlight.delete(workspaceId);
			}
		});
		this.inFlight.set(workspaceId, promise);
		return promise;
	}

	async restart(workspaceId: string): Promise<SshTunnelStatus> {
		await this.stop(workspaceId);
		return this.ensure(workspaceId);
	}

	async stop(workspaceId: string): Promise<SshTunnelStatus> {
		this.clearRetry(workspaceId);
		this.clearStableTimer(workspaceId);
		this.retries.delete(workspaceId);
		const paneId = sshTunnelPaneId(workspaceId);
		try {
			await this.terminal.kill({
				paneId,
				workspaceId,
				deleteHistory: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`[SshTunnelManager] Could not stop ${workspaceId}: ${message}`,
			);
			this.setStatus(workspaceId, "error", message);
			throw error;
		}
		this.paneWorkspaces.delete(paneId);
		return this.setStatus(workspaceId, "stopped");
	}

	async reconcileEnabled(): Promise<void> {
		const enabled = localDb
			.select({ workspaceId: remoteWorkspaceBindings.workspaceId })
			.from(remoteWorkspaceBindings)
			.where(eq(remoteWorkspaceBindings.tunnelEnabled, true))
			.all();
		const expectedPaneIds = new Set(
			enabled.map(({ workspaceId }) => sshTunnelPaneId(workspaceId)),
		);
		try {
			const { sessions } = await this.terminal.listDaemonSessions();
			const orphaned = sessions.filter(
				(session) =>
					session.isAlive &&
					session.hidden &&
					session.paneId.startsWith("remote-tunnel-") &&
					!expectedPaneIds.has(session.paneId),
			);
			await Promise.allSettled(
				orphaned.map((session) => this.stop(session.workspaceId)),
			);
		} catch (error) {
			console.warn(
				"[SshTunnelManager] Could not reconcile orphaned tunnels:",
				error,
			);
		}
		await Promise.allSettled(
			enabled.map(({ workspaceId }) => this.ensure(workspaceId)),
		);
	}

	private async ensureNow(workspaceId: string): Promise<SshTunnelStatus> {
		const binding = localDb
			.select()
			.from(remoteWorkspaceBindings)
			.where(eq(remoteWorkspaceBindings.workspaceId, workspaceId))
			.get();
		if (!binding?.tunnelEnabled) return this.setStatus(workspaceId, "stopped");
		if (binding.portForwards.length === 0) {
			return this.setStatus(
				workspaceId,
				"error",
				"Add at least one port forward before starting the tunnel",
			);
		}

		const profile = localDb
			.select()
			.from(remoteHosts)
			.where(eq(remoteHosts.id, binding.remoteHostId))
			.get();
		const workspace = localDb
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();
		if (!profile || !workspace) {
			await this.stop(workspaceId);
			localDb
				.delete(remoteWorkspaceBindings)
				.where(eq(remoteWorkspaceBindings.workspaceId, workspaceId))
				.run();
			return this.setStatus(
				workspaceId,
				"error",
				"Remote workspace binding is incomplete",
			);
		}

		this.setStatus(workspaceId, "connecting");
		const paneId = sshTunnelPaneId(workspaceId);
		this.paneWorkspaces.set(paneId, workspaceId);
		this.lastOutput.delete(workspaceId);
		this.captureTunnelOutput(paneId, workspaceId);
		let launch: ReturnType<typeof buildSshTunnelLaunch>;
		try {
			launch = buildSshTunnelLaunch(profile, binding.portForwards);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return this.setStatus(workspaceId, "error", message);
		}
		const create = () =>
			this.terminal.createOrAttach({
				paneId,
				tabId: "remote-tunnel",
				workspaceId,
				workspaceName: workspace.name,
				cwd: os.homedir(),
				cols: 80,
				rows: 24,
				skipColdRestore: true,
				allowKilled: true,
				launch,
			});

		let failure: unknown;
		try {
			await create();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("transport changed")) {
				try {
					await this.terminal.kill({
						paneId,
						workspaceId,
						deleteHistory: true,
					});
					await create();
				} catch (replacementError) {
					failure = replacementError;
				}
			} else {
				failure = error;
			}
		}
		if (failure) {
			const message =
				failure instanceof Error ? failure.message : String(failure);
			this.scheduleRetry(workspaceId);
			return this.setStatus(workspaceId, "error", message);
		}

		this.clearRetry(workspaceId);
		this.markStableAfterDelay(workspaceId);
		return this.setStatus(workspaceId, "connected");
	}

	private async handleUnexpectedExit(workspaceId: string): Promise<void> {
		this.clearStableTimer(workspaceId);
		const binding = localDb
			.select({ enabled: remoteWorkspaceBindings.tunnelEnabled })
			.from(remoteWorkspaceBindings)
			.where(eq(remoteWorkspaceBindings.workspaceId, workspaceId))
			.get();
		if (!binding?.enabled) {
			this.setStatus(workspaceId, "stopped");
			return;
		}
		this.setStatus(workspaceId, "retrying", this.lastOutput.get(workspaceId));
		this.scheduleRetry(workspaceId);
	}

	private captureTunnelOutput(paneId: string, workspaceId: string): void {
		if (this.outputListeners.has(paneId)) return;
		this.outputListeners.add(paneId);
		this.terminal.on(`data:${paneId}`, (data: unknown) => {
			if (typeof data !== "string") return;
			const plain = data.replace(ANSI_ESCAPE, "").trim();
			if (!plain) return;
			const previous = this.lastOutput.get(workspaceId) ?? "";
			this.lastOutput.set(
				workspaceId,
				`${previous}\n${plain}`.trim().slice(-MAX_ERROR_LENGTH),
			);
		});
	}

	private scheduleRetry(workspaceId: string): void {
		if (this.retryTimers.has(workspaceId)) return;
		const attempt = (this.retries.get(workspaceId) ?? 0) + 1;
		this.retries.set(workspaceId, attempt);
		const delay = Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000);
		const timer = setTimeout(() => {
			this.retryTimers.delete(workspaceId);
			void this.ensure(workspaceId);
		}, delay);
		timer.unref();
		this.retryTimers.set(workspaceId, timer);
	}

	private clearRetry(workspaceId: string): void {
		const timer = this.retryTimers.get(workspaceId);
		if (timer) clearTimeout(timer);
		this.retryTimers.delete(workspaceId);
	}

	private markStableAfterDelay(workspaceId: string): void {
		this.clearStableTimer(workspaceId);
		const timer = setTimeout(() => {
			this.stableTimers.delete(workspaceId);
			this.retries.delete(workspaceId);
		}, 10_000);
		timer.unref();
		this.stableTimers.set(workspaceId, timer);
	}

	private clearStableTimer(workspaceId: string): void {
		const timer = this.stableTimers.get(workspaceId);
		if (timer) clearTimeout(timer);
		this.stableTimers.delete(workspaceId);
	}

	private setStatus(
		workspaceId: string,
		state: SshTunnelState,
		error?: string,
	): SshTunnelStatus {
		const status: SshTunnelStatus = {
			workspaceId,
			state,
			updatedAt: Date.now(),
			...(error ? { error: error.slice(0, MAX_ERROR_LENGTH) } : {}),
		};
		this.statuses.set(workspaceId, status);
		this.emit("status", status);
		return status;
	}
}

let tunnelManager: SshTunnelManager | null = null;

export function getSshTunnelManager(): SshTunnelManager {
	if (!tunnelManager) tunnelManager = new SshTunnelManager();
	return tunnelManager;
}

export async function reconcileSshTunnels(): Promise<void> {
	await getSshTunnelManager().reconcileEnabled();
}
