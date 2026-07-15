import { EventEmitter } from "node:events";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { type AgentRuntime, workspaces } from "@superset/local-db";
import { track } from "main/lib/analytics";
import { appState } from "main/lib/app-state";
import { localDb } from "main/lib/local-db";
import {
	releaseSubscriptionProfilePane,
	releaseSubscriptionProfileWorkspace,
} from "main/lib/subscription-profiles";
import pidtree from "pidtree";
import { isValidAgentSessionId } from "shared/agent-session-recovery";
import {
	cleanupTerminalHistoryForWorkspace,
	HistoryReader,
	truncateUtf8ToLastBytes,
	writeAgentSessionToHistory,
} from "../../terminal-history";
import {
	disposeTerminalHostClient,
	getTerminalHostClient,
	type TerminalHostClient,
} from "../../terminal-host/client";
import { PID_PATH } from "../../terminal-host/paths";
import type { ListSessionsResponse } from "../../terminal-host/types";
import { treeKillWithEscalation } from "../../tree-kill";
import { buildTerminalEnv, getDefaultShell } from "../env";
import { TerminalKilledError } from "../errors";
import { portManager } from "../port-manager";
import type { CreateSessionParams, SessionResult } from "../types";
import {
	CREATE_OR_ATTACH_CONCURRENCY,
	DEBUG_TERMINAL,
	KILL_EXIT_WAIT_MS,
	MAX_KILLED_SESSION_TOMBSTONES,
	MAX_SCROLLBACK_BYTES,
	SESSION_CLEANUP_DELAY_MS,
} from "./constants";
import { HistoryManager, scanAgentSessionOutput } from "./history-manager";
import { PrioritySemaphore } from "./priority-semaphore";
import type { ColdRestoreInfo, SessionInfo } from "./types";

const MIGRATION_PROCESS_EXIT_TIMEOUT_MS = 7000;
const MIGRATION_PROCESS_POLL_INTERVAL_MS = 50;

export interface SubscriptionProfileMigrationShutdownDependencies {
	enumerateProcessTree?: (pid: number) => Promise<number[]>;
	terminateProcessTree?: (
		pid: number,
	) => Promise<{ success: boolean; error?: string }>;
	isProcessAlive?: (pid: number) => boolean;
	hostPidArtifactExists?: () => boolean;
	readHostPid?: () => number | null;
	sleep?: (durationMs: number) => Promise<void>;
	timeoutMs?: number;
}

function isProcessAliveForMigration(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function readTerminalHostPidForMigration(): number | null {
	if (!existsSync(PID_PATH)) return null;
	try {
		if (lstatSync(PID_PATH).isSymbolicLink()) {
			throw new Error("Refusing a linked terminal host PID file");
		}
		const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
		return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function waitForMigrationProcessesToExit({
	pids,
	label,
	isProcessAlive,
	sleep,
	timeoutMs,
}: {
	pids: ReadonlySet<number>;
	label: string;
	isProcessAlive: (pid: number) => boolean;
	sleep: (durationMs: number) => Promise<void>;
	timeoutMs: number;
}): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (![...pids].some((pid) => isProcessAlive(pid))) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`${label} did not stop before provider storage migration`,
			);
		}
		await sleep(MIGRATION_PROCESS_POLL_INTERVAL_MS);
	}
}

export class ServiceTerminalManager extends EventEmitter {
	private client!: TerminalHostClient;
	private sessions = new Map<string, SessionInfo>();
	private pendingSessions = new Map<string, Promise<SessionResult>>();
	private pendingSessionWorkspaceIds = new Map<string, string>();
	private pendingSessionGenerations = new Map<string, number>();
	private stoppedWorkspacePaneIds = new Map<string, Set<string>>();
	private paneLifecycleGenerations = new Map<string, number>();
	private killedSessionTombstones = new Map<string, number>();
	private deletedHistoryTombstones = new Map<string, number>();
	private agentSessionPersistenceTails = new Map<string, Promise<void>>();
	private createOrAttachLimiter = new PrioritySemaphore(
		CREATE_OR_ATTACH_CONCURRENCY,
	);
	private serviceAliveSessionIds = new Set<string>();
	private serviceSessionIdsHydrated = false;

	private historyManager = new HistoryManager();

	private coldRestoreInfo = new Map<string, ColdRestoreInfo>();
	private cleanupTimeouts = new Map<string, NodeJS.Timeout>();

	constructor() {
		super();
		this.initializeClient();
	}

	private recordKilledSession(paneId: string): void {
		this.killedSessionTombstones.delete(paneId);
		this.killedSessionTombstones.set(paneId, Date.now());
		if (this.killedSessionTombstones.size > MAX_KILLED_SESSION_TOMBSTONES) {
			const oldest = this.killedSessionTombstones.keys().next().value;
			if (oldest) {
				this.killedSessionTombstones.delete(oldest);
			}
		}

		const session = this.sessions.get(paneId);
		if (session) {
			session.exitReason = "killed";
			session.killedByUserAt = Date.now();
		}
	}

	private isSessionKilled(paneId: string): boolean {
		return this.killedSessionTombstones.has(paneId);
	}

	private clearKilledSession(paneId: string): void {
		this.killedSessionTombstones.delete(paneId);
	}

	private recordDeletedHistory(paneId: string): void {
		this.deletedHistoryTombstones.delete(paneId);
		this.deletedHistoryTombstones.set(paneId, Date.now());
		if (this.deletedHistoryTombstones.size > MAX_KILLED_SESSION_TOMBSTONES) {
			const oldest = this.deletedHistoryTombstones.keys().next().value;
			if (oldest) this.deletedHistoryTombstones.delete(oldest);
		}
	}

	private getPaneLifecycleGeneration(paneId: string): number {
		return this.paneLifecycleGenerations.get(paneId) ?? 0;
	}

	private advancePaneLifecycle(paneId: string): number {
		const generation = this.getPaneLifecycleGeneration(paneId) + 1;
		this.paneLifecycleGenerations.set(paneId, generation);
		return generation;
	}

	private isPaneLifecycleCurrent(paneId: string, generation: number): boolean {
		return (
			this.getPaneLifecycleGeneration(paneId) === generation &&
			!this.isSessionKilled(paneId)
		);
	}

	private assertPaneLifecycleCurrent(paneId: string, generation: number): void {
		if (!this.isPaneLifecycleCurrent(paneId, generation)) {
			throw new TerminalKilledError();
		}
	}

	private async discardStaleCreatedSession(
		paneId: string,
		workspaceId: string,
	): Promise<void> {
		const deleteHistory = this.deletedHistoryTombstones.has(paneId);
		this.serviceAliveSessionIds.delete(paneId);
		this.cancelPendingCleanup(paneId);
		const session = this.sessions.get(paneId);
		if (session) {
			session.isAlive = false;
			session.pid = null;
			this.sessions.delete(paneId);
		}
		portManager.unregisterServiceSession(paneId);

		try {
			await this.client.kill({ sessionId: paneId, deleteHistory });
		} catch (error) {
			console.warn(
				`[ServiceTerminalManager] Failed to kill stale created session ${paneId}:`,
				error,
			);
		} finally {
			if (deleteHistory) {
				await this.historyManager.cleanupHistory(paneId, workspaceId);
			} else {
				await this.historyManager.closeHistoryWriter(paneId, 0);
			}
		}
	}

	private initializeClient(): void {
		this.client = getTerminalHostClient();
		this.setupClientEventHandlers();
	}

	async reconcileOnStartup(): Promise<void> {
		try {
			const response = await this.client.listSessions();
			if (response.sessions.length === 0) {
				this.serviceAliveSessionIds.clear();
				this.serviceSessionIdsHydrated = true;
				return;
			}

			console.log(
				`[ServiceTerminalManager] Found ${response.sessions.length} sessions from previous run`,
			);

			const validWorkspaceIds = new Set(
				localDb
					.select({ id: workspaces.id })
					.from(workspaces)
					.all()
					.map((w) => w.id),
			);

			let orphanedCount = 0;
			for (const session of response.sessions) {
				if (!validWorkspaceIds.has(session.workspaceId)) {
					console.log(
						`[ServiceTerminalManager] Killing orphaned session ${session.sessionId} (workspace deleted)`,
					);
					await this.client.kill({ sessionId: session.sessionId });
					orphanedCount++;
				}
			}

			// Cache the service session inventory so createOrAttach can fast-path
			// existing sessions without touching disk (cold restore check only
			// applies when the service does not have a session).
			const preservedSessions = response.sessions.filter(
				(session) =>
					validWorkspaceIds.has(session.workspaceId) && session.isAlive,
			);
			this.serviceAliveSessionIds = new Set(
				preservedSessions.map((session) => session.sessionId),
			);
			this.serviceSessionIdsHydrated = true;

			// Enable port scanning before user opens terminal tabs
			for (const session of preservedSessions) {
				if (session.hidden) continue;
				portManager.upsertServiceSession(
					session.paneId,
					session.workspaceId,
					session.pid,
				);
			}

			const preservedCount = response.sessions.length - orphanedCount;
			if (preservedCount > 0) {
				console.log(
					`[ServiceTerminalManager] Preserving ${preservedCount} sessions for reattach`,
				);
			}
		} catch (error) {
			console.warn(
				"[ServiceTerminalManager] Failed to reconcile sessions:",
				error,
			);
		}
	}

	private async ensureServiceSessionIdsHydrated(): Promise<void> {
		if (this.serviceSessionIdsHydrated) return;

		try {
			const response = await this.client.listSessions();
			this.serviceAliveSessionIds = new Set(
				response.sessions.filter((s) => s.isAlive).map((s) => s.sessionId),
			);
			this.serviceSessionIdsHydrated = true;
		} catch (error) {
			console.warn(
				"[ServiceTerminalManager] Failed to list service sessions:",
				error,
			);
		}
	}

	private setupClientEventHandlers(): void {
		this.client.on("data", (sessionId: string, data: string) => {
			const paneId = sessionId;
			if (DEBUG_TERMINAL) {
				const listenerCount = this.listenerCount(`data:${paneId}`);
				console.log(
					`[ServiceTerminalManager] Received data from service: paneId=${paneId}, bytes=${data.length}, listeners=${listenerCount}`,
				);
			}

			const session = this.sessions.get(paneId);
			if (session) {
				session.lastActive = Date.now();
			}

			if (!session?.hidden) {
				portManager.checkOutputForHint(data, paneId);
				this.historyManager.writeToHistory(paneId, data, () =>
					this.sessions.get(paneId),
				);
			}
			this.emit(`data:${paneId}`, data);
		});

		this.client.on(
			"exit",
			(sessionId: string, exitCode: number, signal?: number) => {
				const paneId = sessionId;
				this.serviceAliveSessionIds.delete(paneId);

				const session = this.sessions.get(paneId);
				if (session) {
					session.isAlive = false;
					session.pid = null;
				}

				portManager.unregisterServiceSession(paneId);
				this.historyManager.closeHistoryWriter(paneId, exitCode);
				const reason =
					session?.exitReason ??
					(this.isSessionKilled(paneId) ? "killed" : "exited");
				if (session) {
					session.exitReason = reason;
				}
				this.emit(`exit:${paneId}`, exitCode, signal, reason);
				this.emit("terminalExit", { paneId, exitCode, signal, reason });

				const timeoutId = setTimeout(() => {
					this.sessions.delete(paneId);
					this.cleanupTimeouts.delete(paneId);
				}, SESSION_CLEANUP_DELAY_MS);
				timeoutId.unref();
				this.cleanupTimeouts.set(paneId, timeoutId);
			},
		);

		this.client.on("disconnected", () => {
			console.warn("[ServiceTerminalManager] Disconnected from service");
			const activeSessionCount = Array.from(this.sessions.values()).filter(
				(s) => s.isAlive,
			).length;
			track("terminal_service_disconnected", {
				active_session_count: activeSessionCount,
			});
			this.serviceAliveSessionIds.clear();
			this.serviceSessionIdsHydrated = false;
			for (const [paneId, session] of this.sessions.entries()) {
				if (session.isAlive) {
					this.emit(
						`disconnect:${paneId}`,
						"Connection to terminal service lost",
					);
				}
			}
		});

		this.client.on("error", (error: Error) => {
			console.error("[ServiceTerminalManager] Client error:", error.message);
			this.serviceAliveSessionIds.clear();
			this.serviceSessionIdsHydrated = false;
			for (const [paneId, session] of this.sessions.entries()) {
				if (session.isAlive) {
					this.emit(`disconnect:${paneId}`, error.message);
				}
			}
		});

		this.client.on(
			"terminalError",
			(sessionId: string, error: string, code?: string) => {
				const paneId = sessionId;
				console.error(
					`[ServiceTerminalManager] Terminal error for ${paneId}: ${code ?? "UNKNOWN"}: ${error}`,
				);

				if (error.includes("Session not found")) {
					this.serviceAliveSessionIds.delete(paneId);
					const session = this.sessions.get(paneId);
					if (session) {
						session.isAlive = false;
					}
					console.log(
						`[ServiceTerminalManager] Session ${paneId} lost - will trigger cold restore on next attach`,
					);
				}

				this.emit(`error:${paneId}`, { error, code });
			},
		);
	}

	async createOrAttach(params: CreateSessionParams): Promise<SessionResult> {
		const { paneId } = params;

		if (this.isSessionKilled(paneId)) {
			if (params.allowKilled) {
				this.clearKilledSession(paneId);
			} else {
				throw new TerminalKilledError();
			}
		}

		const generation = this.getPaneLifecycleGeneration(paneId);
		while (true) {
			const pending = this.pendingSessions.get(paneId);
			if (!pending) break;
			if (this.pendingSessionGenerations.get(paneId) === generation) {
				return pending;
			}
			await pending.catch(() => {});
			this.assertPaneLifecycleCurrent(paneId, generation);
		}

		const creationPromise = this.doCreateOrAttach(params, generation);
		this.pendingSessions.set(paneId, creationPromise);
		this.pendingSessionWorkspaceIds.set(paneId, params.workspaceId);
		this.pendingSessionGenerations.set(paneId, generation);

		try {
			return await creationPromise;
		} finally {
			if (this.pendingSessions.get(paneId) === creationPromise) {
				this.pendingSessions.delete(paneId);
				this.pendingSessionWorkspaceIds.delete(paneId);
				this.pendingSessionGenerations.delete(paneId);
			}
		}
	}

	async listServiceSessions(): Promise<ListSessionsResponse> {
		const response = await this.client.listSessions();
		this.serviceAliveSessionIds = new Set(
			response.sessions.filter((s) => s.isAlive).map((s) => s.sessionId),
		);
		this.serviceSessionIdsHydrated = true;
		return response;
	}

	private async doCreateOrAttach(
		params: CreateSessionParams,
		generation: number,
	): Promise<SessionResult> {
		const releaseCreateOrAttach = await this.createOrAttachLimiter.acquire(
			this.getCreateOrAttachPriority(params),
		);
		const {
			paneId,
			tabId,
			workspaceId,
			workspaceName,
			workspacePath,
			rootPath,
			cwd,
			cols = 80,
			rows = 24,
			skipColdRestore,
			themeType,
			runtime,
			launch,
		} = params;

		try {
			this.assertPaneLifecycleCurrent(paneId, generation);
			if (!skipColdRestore) {
				const stickyRestore = this.coldRestoreInfo.get(paneId);
				if (stickyRestore) {
					return {
						isNew: false,
						scrollback: stickyRestore.scrollback,
						wasRecovered: true,
						isColdRestore: true,
						previousCwd: stickyRestore.previousCwd,
						claudeSessionId: stickyRestore.claudeSessionId,
						agentRuntime: stickyRestore.agentRuntime,
						agentSessionId: stickyRestore.agentSessionId,
						resumeAvailable: isValidAgentSessionId(
							stickyRestore.agentRuntime,
							stickyRestore.agentSessionId,
						),
						transportKind: launch?.kind,
						snapshot: {
							snapshotAnsi: stickyRestore.scrollback,
							rehydrateSequences: "",
							cwd: stickyRestore.previousCwd || null,
							modes: {},
							cols: stickyRestore.cols,
							rows: stickyRestore.rows,
							scrollbackLines: 0,
						},
					};
				}
			}

			if (skipColdRestore) {
				this.coldRestoreInfo.delete(paneId);
			}

			await this.ensureServiceSessionIdsHydrated();
			this.assertPaneLifecycleCurrent(paneId, generation);
			const serviceHasSession = this.serviceAliveSessionIds.has(paneId);

			if (!serviceHasSession && !skipColdRestore) {
				const coldRestoreResult = await this.attemptColdRestore({
					paneId,
					workspaceId,
					cols,
					rows,
					runtime,
					transportKind: launch?.kind,
				});
				this.assertPaneLifecycleCurrent(paneId, generation);
				if (coldRestoreResult) {
					return coldRestoreResult;
				}
			}

			if (!serviceHasSession && skipColdRestore) {
				await this.historyManager.cleanupHistory(paneId, workspaceId);
				this.assertPaneLifecycleCurrent(paneId, generation);
			}

			const previousMetadataCandidate = launch?.hidden
				? null
				: await new HistoryReader(workspaceId, paneId).readMetadata();
			this.assertPaneLifecycleCurrent(paneId, generation);

			const shell = launch?.executable ?? getDefaultShell();
			const env =
				launch?.env ??
				buildTerminalEnv({
					shell,
					paneId,
					tabId,
					workspaceId,
					workspaceName,
					workspacePath,
					rootPath,
					themeType,
					runtime,
				});

			if (DEBUG_TERMINAL) {
				console.log(
					"[ServiceTerminalManager] Calling service createOrAttach:",
					{
						paneId,
						shell,
						cwd,
						cols,
						rows,
					},
				);
			}

			const response = await this.client.createOrAttach({
				sessionId: paneId,
				paneId,
				tabId,
				workspaceId,
				workspaceName,
				workspacePath,
				rootPath,
				cols,
				rows,
				cwd,
				env,
				shell,
				launch,
			});
			if (!this.isPaneLifecycleCurrent(paneId, generation)) {
				await this.discardStaleCreatedSession(paneId, workspaceId);
				throw new TerminalKilledError();
			}
			const previousMetadata = response.isNew
				? previousMetadataCandidate
				: null;
			const previousRuntime =
				previousMetadata?.agentRuntime ??
				(previousMetadata?.claudeSessionId ? "claude" : undefined);
			const effectiveRuntime = runtime ?? previousRuntime;
			const previousSessionId =
				previousRuntime !== undefined && previousRuntime === effectiveRuntime
					? (previousMetadata?.agentSessionId ??
						previousMetadata?.claudeSessionId)
					: undefined;

			this.serviceAliveSessionIds.add(paneId);

			const sessionCwd = response.snapshot.cwd || cwd || "";
			const effectiveCols = response.snapshot.cols || cols;
			const effectiveRows = response.snapshot.rows || rows;

			this.cancelPendingCleanup(paneId);

			this.sessions.set(paneId, {
				paneId,
				workspaceId,
				isAlive: true,
				lastActive: Date.now(),
				cwd: sessionCwd,
				pid: response.pid,
				cols: effectiveCols,
				rows: effectiveRows,
				runtime: effectiveRuntime,
				hidden: launch?.hidden,
			});

			if (!launch?.hidden) {
				portManager.upsertServiceSession(paneId, workspaceId, response.pid);
			}

			const snapshotAnsi = response.snapshot.snapshotAnsi || "";
			const snapshotAnsiBytes = Buffer.byteLength(snapshotAnsi, "utf8");
			const initialScrollback =
				snapshotAnsiBytes > MAX_SCROLLBACK_BYTES
					? truncateUtf8ToLastBytes(snapshotAnsi, MAX_SCROLLBACK_BYTES)
					: snapshotAnsi;

			if (!launch?.hidden && effectiveCols >= 1 && effectiveRows >= 1) {
				await this.historyManager
					.initHistoryWriter({
						paneId,
						workspaceId,
						cwd: sessionCwd,
						cols: effectiveCols,
						rows: effectiveRows,
						initialScrollback,
						runtime: effectiveRuntime,
					})
					.catch((error) => {
						console.error(
							`[ServiceTerminalManager] Failed to init history for ${paneId}:`,
							error,
						);
					});
			} else {
				console.warn(
					`[ServiceTerminalManager] Skipping history init for ${paneId}: invalid dimensions ${effectiveCols}x${effectiveRows}`,
				);
			}
			if (!this.isPaneLifecycleCurrent(paneId, generation)) {
				await this.discardStaleCreatedSession(paneId, workspaceId);
				throw new TerminalKilledError();
			}
			// A live, successfully initialized service session is the only event that
			// retires a permanent history-deletion tombstone. A concurrent kill marks
			// the session dead and keeps stale provider hooks blocked.
			if (this.sessions.get(paneId)?.isAlive && !this.isSessionKilled(paneId)) {
				this.deletedHistoryTombstones.delete(paneId);
			}

			if (response.wasRecovered) {
				track("terminal_warm_attached", {
					workspace_id: workspaceId,
					pane_id: paneId,
					snapshot_bytes: response.snapshot.snapshotAnsi
						? Buffer.byteLength(response.snapshot.snapshotAnsi, "utf8")
						: 0,
				});
			}

			return {
				isNew: response.isNew,
				scrollback: "",
				wasRecovered: response.wasRecovered,
				claudeSessionId:
					effectiveRuntime === "claude" ? previousSessionId : undefined,
				agentRuntime: effectiveRuntime ?? undefined,
				agentSessionId: previousSessionId,
				resumeAvailable:
					response.isNew &&
					isValidAgentSessionId(effectiveRuntime, previousSessionId),
				transportKind: launch?.kind,
				snapshot: {
					snapshotAnsi: response.snapshot.snapshotAnsi,
					rehydrateSequences: response.snapshot.rehydrateSequences,
					cwd: response.snapshot.cwd,
					modes: response.snapshot.modes as unknown as Record<string, boolean>,
					cols: response.snapshot.cols,
					rows: response.snapshot.rows,
					scrollbackLines: response.snapshot.scrollbackLines,
					debug: response.snapshot.debug,
				},
			};
		} finally {
			releaseCreateOrAttach();
		}
	}

	private async attemptColdRestore({
		paneId,
		workspaceId,
		cols,
		rows,
		runtime,
		transportKind,
	}: {
		paneId: string;
		workspaceId: string;
		cols: number;
		rows: number;
		runtime?: AgentRuntime | null;
		transportKind?: "ssh" | "ssh-tunnel";
	}): Promise<SessionResult | null> {
		const historyReader = new HistoryReader(workspaceId, paneId);
		const metadata = await historyReader.readMetadata();
		const wasUncleanShutdown = !!metadata && !metadata.endedAt;

		if (!wasUncleanShutdown) {
			return null;
		}

		const rawScrollback = await historyReader.readScrollback();
		if (rawScrollback === null) {
			await historyReader.cleanup();
			return null;
		}

		const rawScrollbackBytes = Buffer.byteLength(rawScrollback, "utf8");
		const scrollback =
			rawScrollbackBytes > MAX_SCROLLBACK_BYTES
				? truncateUtf8ToLastBytes(rawScrollback, MAX_SCROLLBACK_BYTES)
				: rawScrollback;
		const scrollbackBytes = Buffer.byteLength(scrollback, "utf8");

		const metadataRuntime =
			metadata.agentRuntime ??
			(metadata.claudeSessionId ? "claude" : undefined);
		const agentRuntime = runtime ?? metadataRuntime;
		const storedSessionId =
			metadataRuntime !== undefined && metadataRuntime === agentRuntime
				? (metadata.agentSessionId ?? metadata.claudeSessionId)
				: undefined;
		const agentSessionId =
			storedSessionId ??
			(agentRuntime
				? scanAgentSessionOutput(agentRuntime, "", scrollback).sessionId
				: undefined);
		const claudeSessionId =
			agentRuntime === "claude" ? agentSessionId : undefined;

		this.coldRestoreInfo.set(paneId, {
			scrollback,
			previousCwd: metadata.cwd,
			claudeSessionId,
			agentRuntime,
			agentSessionId,
			cols: metadata.cols || cols,
			rows: metadata.rows || rows,
		});

		track("terminal_cold_restored", {
			workspace_id: workspaceId,
			pane_id: paneId,
			scrollback_bytes: scrollbackBytes,
			has_claude_session: !!claudeSessionId,
		});

		return {
			isNew: false,
			scrollback,
			wasRecovered: true,
			isColdRestore: true,
			previousCwd: metadata.cwd,
			claudeSessionId,
			agentRuntime,
			agentSessionId,
			resumeAvailable: isValidAgentSessionId(agentRuntime, agentSessionId),
			transportKind,
			snapshot: {
				snapshotAnsi: scrollback,
				rehydrateSequences: "",
				cwd: metadata.cwd,
				modes: {},
				cols: metadata.cols || cols,
				rows: metadata.rows || rows,
				scrollbackLines: 0,
			},
		};
	}

	private getCreateOrAttachPriority(params: CreateSessionParams): number {
		try {
			const tabsState = appState.data?.tabsState;
			const activeTabId = tabsState?.activeTabIds?.[params.workspaceId];
			const focusedPaneId =
				activeTabId && tabsState?.focusedPaneIds?.[activeTabId];

			const isActiveFocusedPane =
				activeTabId === params.tabId && focusedPaneId === params.paneId;

			return isActiveFocusedPane ? 0 : 1;
		} catch {
			return 1;
		}
	}

	persistAgentSessionFromHook(params: {
		paneId: string;
		workspaceId: string;
		runtime: AgentRuntime;
		sessionId: string;
	}): Promise<void> {
		const { paneId } = params;
		const previous =
			this.agentSessionPersistenceTails.get(paneId) ?? Promise.resolve();
		const operation = previous.then(() =>
			this.persistAgentSessionFromHookNow(params),
		);
		const tail = operation.then(
			() => {},
			() => {},
		);
		this.agentSessionPersistenceTails.set(paneId, tail);
		void tail.finally(() => {
			if (this.agentSessionPersistenceTails.get(paneId) === tail) {
				this.agentSessionPersistenceTails.delete(paneId);
			}
		});
		return operation;
	}

	private async persistAgentSessionFromHookNow({
		paneId,
		workspaceId,
		runtime,
		sessionId,
	}: {
		paneId: string;
		workspaceId: string;
		runtime: AgentRuntime;
		sessionId: string;
	}): Promise<void> {
		if (
			this.deletedHistoryTombstones.has(paneId) ||
			!isValidAgentSessionId(runtime, sessionId)
		) {
			return;
		}
		const handledByWriter = await this.historyManager
			.updateAgentSessionFromHook({
				paneId,
				workspaceId,
				runtime,
				sessionId,
			})
			.catch((error) => {
				console.warn(
					`[ServiceTerminalManager] Live hook persistence failed for ${paneId}:`,
					error,
				);
				return false;
			});
		if (handledByWriter) return;
		if (this.deletedHistoryTombstones.has(paneId)) return;
		await writeAgentSessionToHistory(workspaceId, paneId, runtime, sessionId);
	}

	write(params: { paneId: string; data: string }): void {
		const { paneId, data } = params;

		const session = this.sessions.get(paneId);
		if (!session || !session.isAlive) {
			throw new Error(`Terminal session ${paneId} not found or not alive`);
		}

		this.client.writeNoAck({ sessionId: paneId, data });
	}

	ackColdRestore(paneId: string): void {
		this.coldRestoreInfo.delete(paneId);
	}

	resize(params: { paneId: string; cols: number; rows: number }): void {
		const { paneId, cols, rows } = params;

		if (
			!Number.isInteger(cols) ||
			!Number.isInteger(rows) ||
			cols <= 0 ||
			rows <= 0
		) {
			console.warn(
				`[ServiceTerminalManager] Invalid resize geometry for ${paneId}: cols=${cols}, rows=${rows}`,
			);
			return;
		}

		this.client.resize({ sessionId: paneId, cols, rows }).catch((error) => {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (!errorMsg.includes("not found")) {
				console.error(
					`[ServiceTerminalManager] Resize failed for ${paneId}:`,
					error,
				);
			}
		});

		const session = this.sessions.get(paneId);
		if (session) {
			session.lastActive = Date.now();
			session.cols = cols;
			session.rows = rows;
		}
	}

	signal(params: { paneId: string; signal?: string }): void {
		const { paneId, signal = "SIGINT" } = params;
		const session = this.sessions.get(paneId);

		if (!session || !session.isAlive) {
			console.warn(
				`Cannot signal terminal ${paneId}: session not found or not alive`,
			);
			return;
		}

		this.client.signal({ sessionId: paneId, signal }).catch((error) => {
			console.warn(
				`[ServiceTerminalManager] Failed to send signal ${signal} to ${paneId}:`,
				error,
			);
		});
	}

	async kill(params: {
		paneId: string;
		deleteHistory?: boolean;
		workspaceId?: string;
	}): Promise<void> {
		const { paneId, deleteHistory = false, workspaceId } = params;
		this.advancePaneLifecycle(paneId);
		this.serviceAliveSessionIds.delete(paneId);
		this.recordKilledSession(paneId);
		if (deleteHistory) {
			this.recordDeletedHistory(paneId);
			this.coldRestoreInfo.delete(paneId);
		}

		const session = this.sessions.get(paneId);
		const exitWait = session?.isAlive
			? new Promise<void>((resolve) => {
					let timeout: NodeJS.Timeout;
					const onExit = () => {
						clearTimeout(timeout);
						resolve();
					};
					this.once(`exit:${paneId}`, onExit);
					timeout = setTimeout(() => {
						this.removeListener(`exit:${paneId}`, onExit);
						resolve();
					}, KILL_EXIT_WAIT_MS);
					timeout.unref();
				})
			: null;
		if (session?.isAlive) {
			session.isAlive = false;
			session.pid = null;
		}

		portManager.unregisterServiceSession(paneId);

		const historyWorkspaceId = session?.workspaceId ?? workspaceId;
		const historyClose = !deleteHistory
			? this.historyManager.closeHistoryWriter(paneId, 0)
			: null;

		try {
			await this.client.kill({ sessionId: paneId, deleteHistory });
			if (exitWait) await exitWait;
		} finally {
			try {
				if (historyClose) await historyClose;
				if (deleteHistory) {
					const pendingHook = this.agentSessionPersistenceTails.get(paneId);
					if (pendingHook) await pendingHook;
				}
				if (deleteHistory && historyWorkspaceId) {
					// The exit handler closes the writer. cleanupHistory awaits that close so
					// a final metadata flush cannot recreate files after deletion.
					await this.historyManager.cleanupHistory(paneId, historyWorkspaceId);
				} else if (deleteHistory) {
					await this.historyManager.closeHistoryWriter(paneId, 0);
				}
			} finally {
				if (deleteHistory) {
					try {
						releaseSubscriptionProfilePane(paneId);
					} catch (error) {
						console.warn(
							`[ServiceTerminalManager] Failed to release provider home for ${paneId}:`,
							error,
						);
					}
				}
			}
		}
	}

	detach(params: { paneId: string }): void {
		const { paneId } = params;

		const session = this.sessions.get(paneId);

		this.client.detach({ sessionId: paneId }).catch((error) => {
			console.error(
				`[ServiceTerminalManager] Detach failed for ${paneId}:`,
				error,
			);
		});

		if (session) {
			session.lastActive = Date.now();
		}
	}

	async clearScrollback(params: { paneId: string }): Promise<void> {
		const { paneId } = params;

		await this.client.clearScrollback({ sessionId: paneId });

		const session = this.sessions.get(paneId);
		if (session) {
			session.lastActive = Date.now();

			const writer = this.historyManager.getHistoryWriter(paneId);
			if (writer) {
				await this.historyManager.closeHistoryWriter(paneId);
				if (this.sessions.get(paneId) !== session || !session.isAlive) return;
				try {
					await this.historyManager.initHistoryWriter({
						paneId,
						workspaceId: session.workspaceId,
						cwd: session.cwd,
						cols: session.cols,
						rows: session.rows,
						initialScrollback: undefined,
						runtime: session.runtime,
					});
				} catch (error) {
					console.warn(
						`[ServiceTerminalManager] Failed to reinitialize history writer for ${paneId}:`,
						error,
					);
				}
			}
		}
	}

	async resetHistoryPersistence(): Promise<void> {
		await this.historyManager.resetAll(this.sessions);
	}

	getSession(
		paneId: string,
	): { isAlive: boolean; cwd: string; lastActive: number } | null {
		const session = this.sessions.get(paneId);
		if (!session) {
			return null;
		}

		return {
			isAlive: session.isAlive,
			cwd: session.cwd,
			lastActive: session.lastActive,
		};
	}

	private async purgeWorkspaceStorage(workspaceId: string): Promise<void> {
		try {
			await cleanupTerminalHistoryForWorkspace(workspaceId);
		} catch (error) {
			console.warn(
				`[ServiceTerminalManager] Failed to purge terminal history for workspace ${workspaceId}:`,
				error,
			);
		}
		try {
			releaseSubscriptionProfileWorkspace(workspaceId);
		} catch (error) {
			console.warn(
				`[ServiceTerminalManager] Failed to release provider homes for workspace ${workspaceId}:`,
				error,
			);
		}
	}

	async killByWorkspaceId(
		workspaceId: string,
		options: { deleteHistory: boolean },
	): Promise<{ killed: number; failed: number }> {
		const { deleteHistory } = options;
		const paneIdsToKill = new Set<string>();

		try {
			const response = await this.client.listSessions();
			for (const session of response.sessions) {
				if (session.workspaceId === workspaceId) {
					paneIdsToKill.add(session.paneId);
				}
			}
		} catch (error) {
			console.warn(
				"[ServiceTerminalManager] Failed to query service for sessions:",
				error,
			);
		}
		for (const [paneId, session] of this.sessions.entries()) {
			if (session.workspaceId === workspaceId) paneIdsToKill.add(paneId);
		}
		for (const [
			paneId,
			pendingWorkspaceId,
		] of this.pendingSessionWorkspaceIds.entries()) {
			if (pendingWorkspaceId === workspaceId) paneIdsToKill.add(paneId);
		}
		for (const paneId of this.stoppedWorkspacePaneIds.get(workspaceId) ?? []) {
			paneIdsToKill.add(paneId);
		}

		if (paneIdsToKill.size === 0) {
			if (deleteHistory) {
				await this.purgeWorkspaceStorage(workspaceId);
				this.stoppedWorkspacePaneIds.delete(workspaceId);
			}
			return { killed: 0, failed: 0 };
		}

		console.log(
			`[ServiceTerminalManager] Killing ${paneIdsToKill.size} sessions for workspace ${workspaceId}`,
		);

		const results = await Promise.allSettled(
			Array.from(paneIdsToKill).map(async (paneId) => {
				await this.kill({ paneId, workspaceId, deleteHistory });
			}),
		);

		const killed = results.filter((r) => r.status === "fulfilled").length;
		const failed = results.filter((r) => r.status === "rejected").length;
		if (deleteHistory) {
			await this.purgeWorkspaceStorage(workspaceId);
			this.stoppedWorkspacePaneIds.delete(workspaceId);
		} else {
			this.stoppedWorkspacePaneIds.set(workspaceId, paneIdsToKill);
		}

		if (failed > 0) {
			console.warn(
				`[ServiceTerminalManager] killByWorkspaceId: killed=${killed}, failed=${failed}`,
			);
		}

		return { killed, failed };
	}

	async getSessionCountByWorkspaceId(workspaceId: string): Promise<number> {
		try {
			const response = await this.client.listSessions();
			return response.sessions.filter(
				(s) => s.workspaceId === workspaceId && s.isAlive,
			).length;
		} catch (error) {
			console.warn(
				"[ServiceTerminalManager] Failed to query service for session count:",
				error,
			);
			return Array.from(this.sessions.values()).filter(
				(session) => session.workspaceId === workspaceId && session.isAlive,
			).length;
		}
	}

	refreshPromptsForWorkspace(workspaceId: string): void {
		for (const [paneId, session] of this.sessions.entries()) {
			if (session.workspaceId === workspaceId && session.isAlive) {
				this.client.writeNoAck({ sessionId: paneId, data: "\r" });
			}
		}
	}

	detachAllListeners(): void {
		for (const event of this.eventNames()) {
			const name = String(event);
			if (
				name.startsWith("data:") ||
				name.startsWith("exit:") ||
				name.startsWith("disconnect:") ||
				name.startsWith("error:") ||
				name === "terminalExit"
			) {
				this.removeAllListeners(event);
			}
		}
	}

	private cancelPendingCleanup(paneId: string): void {
		const timeout = this.cleanupTimeouts.get(paneId);
		if (timeout) {
			clearTimeout(timeout);
			this.cleanupTimeouts.delete(paneId);
		}
	}

	async cleanup(): Promise<void> {
		for (const timeout of this.cleanupTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.cleanupTimeouts.clear();
		for (const paneId of this.pendingSessions.keys()) {
			this.advancePaneLifecycle(paneId);
		}

		await this.historyManager.cleanup();

		this.sessions.clear();
		this.pendingSessionWorkspaceIds.clear();
		this.pendingSessionGenerations.clear();
		this.stoppedWorkspacePaneIds.clear();
		this.serviceAliveSessionIds.clear();
		this.serviceSessionIdsHydrated = false;
		this.coldRestoreInfo.clear();
		this.killedSessionTombstones.clear();
		this.deletedHistoryTombstones.clear();
		this.agentSessionPersistenceTails.clear();
		this.removeAllListeners();
		disposeTerminalHostClient();
	}

	async forceKillAll(): Promise<void> {
		const response = await this.client.listSessions().catch(() => ({
			sessions: [],
		}));
		const sessionIds = response.sessions.map((s) => s.sessionId);
		for (const paneId of this.pendingSessions.keys()) {
			this.advancePaneLifecycle(paneId);
			this.recordKilledSession(paneId);
		}

		for (const session of response.sessions) {
			if (!session.isAlive) continue;
			this.recordKilledSession(session.sessionId);

			const localSession = this.sessions.get(session.sessionId);
			if (localSession?.isAlive) {
				localSession.isAlive = false;
				localSession.pid = null;
			}
		}

		for (const timeout of this.cleanupTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.cleanupTimeouts.clear();

		await this.historyManager.forceCloseAll();

		await this.client.killAll({});
		for (const paneId of sessionIds) {
			portManager.unregisterServiceSession(paneId);
		}
		this.serviceAliveSessionIds.clear();
		this.serviceSessionIdsHydrated = true;
		this.coldRestoreInfo.clear();
		this.sessions.clear();
		this.pendingSessionWorkspaceIds.clear();
		this.stoppedWorkspacePaneIds.clear();
	}

	/**
	 * Stops every process that could retain a provider credential path, then
	 * proves both the captured descendants and terminal host have exited.
	 */
	async shutdownForSubscriptionProfileMigration(
		dependencies: SubscriptionProfileMigrationShutdownDependencies = {},
	): Promise<void> {
		const enumerateProcessTree =
			dependencies.enumerateProcessTree ??
			((pid: number) => pidtree(pid, { root: true }));
		const terminateProcessTree =
			dependencies.terminateProcessTree ??
			((pid: number) => treeKillWithEscalation({ pid, signal: "SIGKILL" }));
		const isProcessAlive =
			dependencies.isProcessAlive ?? isProcessAliveForMigration;
		const readHostPid =
			dependencies.readHostPid ?? readTerminalHostPidForMigration;
		const hostPidArtifactExists =
			dependencies.hostPidArtifactExists ?? (() => existsSync(PID_PATH));
		const sleep =
			dependencies.sleep ??
			((durationMs: number) =>
				new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
		const timeoutMs =
			dependencies.timeoutMs ?? MIGRATION_PROCESS_EXIT_TIMEOUT_MS;
		const hasHostPidArtifact = hostPidArtifactExists();
		const hostPid = readHostPid();
		const connected = await this.client.tryConnectAndAuthenticate();

		if (!connected) {
			if (hasHostPidArtifact) {
				throw new Error(
					"An unreachable terminal host left a PID artifact, so descendant shutdown cannot be proven for provider storage migration",
				);
			}
			return;
		}
		if (!hostPid || !isProcessAlive(hostPid)) {
			throw new Error(
				"The terminal host process identity is unavailable for provider storage migration",
			);
		}

		const { sessions } = await this.client.listSessions();
		const processRoots = new Set<number>();
		const capturedProcesses = new Set<number>();
		try {
			for (const processPid of await enumerateProcessTree(hostPid)) {
				if (
					processPid !== hostPid &&
					Number.isSafeInteger(processPid) &&
					processPid > 0
				) {
					capturedProcesses.add(processPid);
				}
			}
		} catch (error) {
			throw new Error(
				"Could not inventory terminal host descendants before provider storage migration",
				{ cause: error },
			);
		}
		for (const session of sessions) {
			const pid = session.pid;
			if (!pid || !Number.isSafeInteger(pid) || pid <= 0) continue;
			processRoots.add(pid);
			try {
				for (const processPid of await enumerateProcessTree(pid)) {
					if (Number.isSafeInteger(processPid) && processPid > 0) {
						capturedProcesses.add(processPid);
					}
				}
				capturedProcesses.add(pid);
			} catch (error) {
				if (isProcessAlive(pid)) {
					throw new Error(
						"Could not inventory a provider terminal process tree before storage migration",
						{ cause: error },
					);
				}
			}
		}

		for (const pid of processRoots) {
			if (!isProcessAlive(pid)) continue;
			const result = await terminateProcessTree(pid);
			if (!result.success) {
				throw new Error(
					"A provider terminal process tree could not be stopped before storage migration",
				);
			}
		}
		for (const pid of capturedProcesses) {
			if (!isProcessAlive(pid)) continue;
			const result = await terminateProcessTree(pid);
			if (!result.success) {
				throw new Error(
					"A provider terminal process could not be stopped before storage migration",
				);
			}
		}
		await waitForMigrationProcessesToExit({
			pids: capturedProcesses,
			label: "A provider terminal process",
			isProcessAlive,
			sleep,
			timeoutMs,
		});

		await this.client.shutdownIfRunning({ killSessions: true });
		await waitForMigrationProcessesToExit({
			pids: new Set([hostPid]),
			label: "The terminal host process",
			isProcessAlive,
			sleep,
			timeoutMs,
		});
		if ([...capturedProcesses].some((pid) => isProcessAlive(pid))) {
			throw new Error(
				"A provider terminal process restarted during storage migration shutdown",
			);
		}
	}

	reset(): void {
		console.log("[ServiceTerminalManager] Resetting...");

		for (const timeout of this.cleanupTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.cleanupTimeouts.clear();
		this.client.removeAllListeners();
		for (const paneId of this.pendingSessions.keys()) {
			this.advancePaneLifecycle(paneId);
		}

		this.sessions.clear();
		this.pendingSessionWorkspaceIds.clear();
		this.stoppedWorkspacePaneIds.clear();
		this.serviceAliveSessionIds.clear();
		this.serviceSessionIdsHydrated = false;
		this.coldRestoreInfo.clear();
		this.killedSessionTombstones.clear();
		this.deletedHistoryTombstones.clear();
		this.agentSessionPersistenceTails.clear();

		this.historyManager.closeAllSync();
		this.createOrAttachLimiter.reset();

		disposeTerminalHostClient();
		this.initializeClient();

		console.log("[ServiceTerminalManager] Reset complete");
	}
}
