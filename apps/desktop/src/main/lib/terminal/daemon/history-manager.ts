import type { AgentRuntime } from "@superset/local-db";
import { extractAgentSessionId } from "shared/agent-session-recovery";
import {
	containsClearScrollbackSequence,
	extractContentAfterClear,
} from "../../terminal-escape-filter";
import {
	HistoryReader,
	HistoryWriter,
	truncateUtf8ToLastBytes,
	writeAgentSessionToHistory,
} from "../../terminal-history";
import { MAX_HISTORY_SCROLLBACK_BYTES } from "./constants";
import type { SessionInfo } from "./types";

const AGENT_SESSION_SCAN_TAIL_CHARS = 512;

export function scanAgentSessionOutput(
	runtime: AgentRuntime,
	previousTail: string,
	data: string,
): { tail: string; sessionId?: string } {
	const tail =
		`${previousTail.slice(-AGENT_SESSION_SCAN_TAIL_CHARS)}${data.slice(
			-AGENT_SESSION_SCAN_TAIL_CHARS,
		)}`.slice(-AGENT_SESSION_SCAN_TAIL_CHARS);
	return {
		tail,
		sessionId: extractAgentSessionId(runtime, tail),
	};
}

type HistoryWriterFactory = (
	workspaceId: string,
	paneId: string,
	cwd: string,
	cols: number,
	rows: number,
	runtime?: AgentRuntime | null,
) => HistoryWriter;

interface PendingHookSession {
	workspaceId: string;
	runtime: AgentRuntime;
	sessionId: string;
}

interface HistoryInitParams {
	paneId: string;
	workspaceId: string;
	cwd: string;
	cols: number;
	rows: number;
	initialScrollback?: string;
	runtime?: AgentRuntime | null;
}

export class HistoryManager {
	private historyWriters = new Map<string, HistoryWriter>();
	private closingHistoryWriters = new Map<string, HistoryWriter>();
	private closingHistoryWriterPromises = new Map<string, Promise<void>>();
	private historyInitPromises = new Map<string, Promise<void>>();
	private historyGenerations = new Map<string, number>();
	private pendingHistoryData = new Map<string, string[]>();
	private historyInitializing = new Set<string>();
	private agentIdScanTails = new Map<string, string>();
	private pendingHookSessions = new Map<string, PendingHookSession>();

	constructor(
		private readonly createHistoryWriter: HistoryWriterFactory = (
			workspaceId,
			paneId,
			cwd,
			cols,
			rows,
			runtime,
		) => new HistoryWriter(workspaceId, paneId, cwd, cols, rows, runtime),
	) {}

	private nextHistoryGeneration(paneId: string): number {
		const generation = (this.historyGenerations.get(paneId) ?? 0) + 1;
		this.historyGenerations.set(paneId, generation);
		return generation;
	}

	private isCurrentHistoryGeneration(
		paneId: string,
		generation: number,
	): boolean {
		return this.historyGenerations.get(paneId) === generation;
	}

	async initHistoryWriter(params: HistoryInitParams): Promise<void> {
		const { paneId } = params;
		const previousInit = this.historyInitPromises.get(paneId);
		const generation = this.nextHistoryGeneration(paneId);
		const initialization = (async () => {
			if (previousInit) await previousInit;
			const previousClose = this.closingHistoryWriterPromises.get(paneId);
			if (previousClose) await previousClose;
			if (!this.isCurrentHistoryGeneration(paneId, generation)) return;
			await this.initializeHistoryWriter(params, generation);
		})();

		this.historyInitPromises.set(paneId, initialization);
		try {
			await initialization;
		} finally {
			if (this.historyInitPromises.get(paneId) === initialization) {
				this.historyInitPromises.delete(paneId);
			}
		}
	}

	private async initializeHistoryWriter(
		{
			paneId,
			workspaceId,
			cwd,
			cols,
			rows,
			initialScrollback,
			runtime,
		}: HistoryInitParams,
		generation: number,
	): Promise<void> {
		this.historyInitializing.add(paneId);
		this.pendingHistoryData.set(paneId, []);
		this.agentIdScanTails.delete(paneId);

		let safeScrollback = initialScrollback;
		if (initialScrollback !== undefined) {
			if (typeof initialScrollback !== "string") {
				console.warn(
					`[HistoryManager] initialScrollback for ${paneId} is not a string, ignoring`,
				);
				safeScrollback = undefined;
			} else {
				const initialScrollbackBytes = Buffer.byteLength(
					initialScrollback,
					"utf8",
				);
				if (initialScrollbackBytes > MAX_HISTORY_SCROLLBACK_BYTES) {
					console.warn(
						`[HistoryManager] initialScrollback for ${paneId} too large (${initialScrollbackBytes} bytes), truncating to ${MAX_HISTORY_SCROLLBACK_BYTES}`,
					);
					safeScrollback = truncateUtf8ToLastBytes(
						initialScrollback,
						MAX_HISTORY_SCROLLBACK_BYTES,
					);
				}
			}
		}

		try {
			const writer = this.createHistoryWriter(
				workspaceId,
				paneId,
				cwd,
				cols,
				rows,
				runtime,
			);
			await writer.init(safeScrollback);
			if (!this.isCurrentHistoryGeneration(paneId, generation)) {
				await writer.close().catch((error) => {
					console.warn(
						`[HistoryManager] Failed to close superseded writer for ${paneId}:`,
						error,
					);
				});
				return;
			}
			this.historyWriters.set(paneId, writer);
			const pendingHook = this.pendingHookSessions.get(paneId);
			if (pendingHook && this.isCurrentHistoryGeneration(paneId, generation)) {
				await writer.updateAgentSessionFromHook(
					pendingHook.runtime,
					pendingHook.sessionId,
				);
				this.pendingHookSessions.delete(paneId);
			}
			this.captureAgentSessionId(paneId, safeScrollback, runtime, writer);

			const buffered = this.pendingHistoryData.get(paneId) || [];
			this.historyInitializing.delete(paneId);
			this.pendingHistoryData.delete(paneId);
			for (const data of buffered) {
				writer.write(data);
				this.captureAgentSessionId(paneId, data, runtime, writer);
			}
		} catch (error) {
			console.error(
				`[HistoryManager] Failed to init history writer for ${paneId}:`,
				error,
			);
			const pendingHook = this.pendingHookSessions.get(paneId);
			if (pendingHook && this.isCurrentHistoryGeneration(paneId, generation)) {
				await writeAgentSessionToHistory(
					pendingHook.workspaceId,
					paneId,
					pendingHook.runtime,
					pendingHook.sessionId,
				).catch((persistError) => {
					console.warn(
						`[HistoryManager] Failed to persist pending hook for ${paneId}:`,
						persistError,
					);
				});
				this.pendingHookSessions.delete(paneId);
			}
		} finally {
			if (this.isCurrentHistoryGeneration(paneId, generation)) {
				this.historyInitializing.delete(paneId);
				this.pendingHistoryData.delete(paneId);
			}
		}
	}

	/**
	 * Route provider hooks through the in-memory writer so its later close cannot
	 * overwrite the authoritative id. Hooks arriving during init are applied
	 * before any fallback scrollback scan.
	 */
	async updateAgentSessionFromHook({
		paneId,
		workspaceId,
		runtime,
		sessionId,
	}: PendingHookSession & { paneId: string }): Promise<boolean> {
		const writer =
			this.historyWriters.get(paneId) ?? this.closingHistoryWriters.get(paneId);
		if (writer) {
			await writer.updateAgentSessionFromHook(runtime, sessionId);
			return true;
		}
		if (this.historyInitializing.has(paneId)) {
			this.pendingHookSessions.set(paneId, {
				workspaceId,
				runtime,
				sessionId,
			});
			return true;
		}
		return false;
	}

	writeToHistory(
		paneId: string,
		data: string,
		getSession: () => SessionInfo | undefined,
	): void {
		if (this.historyInitializing.has(paneId)) {
			const buffer = this.pendingHistoryData.get(paneId);
			if (buffer) {
				buffer.push(data);
			}
			return;
		}

		const writer = this.historyWriters.get(paneId);
		if (!writer) {
			return;
		}

		if (containsClearScrollbackSequence(data)) {
			const session = getSession();
			if (session) {
				const contentAfterClear = extractContentAfterClear(data);
				void this.closeHistoryWriter(paneId)
					.then(() => {
						if (getSession() !== session || !session.isAlive) return;
						return this.initHistoryWriter({
							paneId,
							workspaceId: session.workspaceId,
							cwd: session.cwd,
							cols: session.cols,
							rows: session.rows,
							initialScrollback: contentAfterClear || undefined,
							runtime: session.runtime,
						});
					})
					.catch((error) => {
						console.warn(
							`[HistoryManager] Failed to reinitialize history writer for ${paneId}:`,
							error,
						);
					});
			}
			return;
		}

		writer.write(data);

		// Capture stable provider conversation IDs as the CLI exposes them.
		this.captureAgentSessionId(paneId, data, getSession()?.runtime, writer);
	}

	private captureAgentSessionId(
		paneId: string,
		data: string | undefined,
		runtime: AgentRuntime | null | undefined,
		writer: HistoryWriter,
	): void {
		if (!runtime || !data) return;
		const scan = scanAgentSessionOutput(
			runtime,
			this.agentIdScanTails.get(paneId) ?? "",
			data,
		);
		this.agentIdScanTails.set(paneId, scan.tail);
		writer.updateAgentSession(runtime, scan.sessionId);
	}

	async closeHistoryWriter(paneId: string, exitCode?: number): Promise<void> {
		const pendingInit = this.historyInitPromises.get(paneId);
		if (pendingInit) await pendingInit;

		const existingClose = this.closingHistoryWriterPromises.get(paneId);
		if (existingClose) return existingClose;

		const writer = this.historyWriters.get(paneId);
		this.historyInitializing.delete(paneId);
		this.pendingHistoryData.delete(paneId);
		this.agentIdScanTails.delete(paneId);
		if (!writer) return;

		this.historyWriters.delete(paneId);
		this.closingHistoryWriters.set(paneId, writer);
		const closeOperation: Promise<void> = writer
			.close(exitCode)
			.catch((error) => {
				console.error(
					`[HistoryManager] Failed to close history writer for ${paneId}:`,
					error,
				);
			});
		this.closingHistoryWriterPromises.set(paneId, closeOperation);
		void closeOperation.finally(() => {
			if (this.closingHistoryWriters.get(paneId) === writer) {
				this.closingHistoryWriters.delete(paneId);
			}
			if (this.closingHistoryWriterPromises.get(paneId) === closeOperation) {
				this.closingHistoryWriterPromises.delete(paneId);
			}
		});
		return closeOperation;
	}

	async cleanupHistory(paneId: string, workspaceId: string): Promise<void> {
		// Invalidate initialization before waiting for it. A writer that finishes
		// meanwhile sees the generation change, closes itself, and is never installed.
		this.nextHistoryGeneration(paneId);
		this.historyInitializing.delete(paneId);
		this.pendingHistoryData.delete(paneId);
		this.agentIdScanTails.delete(paneId);
		this.pendingHookSessions.delete(paneId);
		const pendingInit = this.historyInitPromises.get(paneId);
		if (pendingInit) await pendingInit;
		await this.closeHistoryWriter(paneId);

		try {
			const reader = new HistoryReader(workspaceId, paneId);
			await reader.cleanup();
		} catch (error) {
			console.error(
				`[HistoryManager] Failed to cleanup history for ${paneId}:`,
				error,
			);
		}
	}

	getHistoryWriter(paneId: string): HistoryWriter | undefined {
		return this.historyWriters.get(paneId);
	}

	async resetAll(sessions: Map<string, SessionInfo>): Promise<void> {
		const initPromises = [...this.historyInitPromises.values()];
		for (const paneId of this.historyInitPromises.keys()) {
			this.nextHistoryGeneration(paneId);
		}
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();
		await Promise.all(initPromises);

		const closePromises: Promise<void>[] = [
			...this.closingHistoryWriterPromises.values(),
		];
		for (const [paneId, writer] of this.historyWriters.entries()) {
			closePromises.push(
				writer.close().catch((error) => {
					console.warn(
						`[HistoryManager] Failed to close history for ${paneId}:`,
						error,
					);
				}),
			);
		}
		await Promise.all(closePromises);
		this.historyWriters.clear();
		this.closingHistoryWriters.clear();
		this.closingHistoryWriterPromises.clear();
		this.historyInitPromises.clear();
		this.historyGenerations.clear();
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();

		const restartPromises: Promise<void>[] = [];
		for (const [paneId, session] of sessions.entries()) {
			if (!session.isAlive) continue;
			restartPromises.push(
				this.initHistoryWriter({
					paneId,
					workspaceId: session.workspaceId,
					cwd: session.cwd,
					cols: session.cols,
					rows: session.rows,
					initialScrollback: undefined,
					runtime: session.runtime,
				}).catch((error) => {
					console.warn(
						`[HistoryManager] Failed to reinitialize history for ${paneId}:`,
						error,
					);
				}),
			);
		}
		await Promise.all(restartPromises);
	}

	async cleanup(): Promise<void> {
		const initPromises = [...this.historyInitPromises.values()];
		for (const paneId of this.historyInitPromises.keys()) {
			this.nextHistoryGeneration(paneId);
		}
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();
		await Promise.all(initPromises);

		const closePromises: Promise<void>[] = [
			...this.closingHistoryWriterPromises.values(),
		];
		for (const [paneId, writer] of this.historyWriters.entries()) {
			closePromises.push(
				writer.close().catch((error) => {
					console.error(
						`[HistoryManager] Failed to close history for ${paneId}:`,
						error,
					);
				}),
			);
		}
		await Promise.all(closePromises);
		this.historyWriters.clear();
		this.closingHistoryWriters.clear();
		this.closingHistoryWriterPromises.clear();
		this.historyInitPromises.clear();
		this.historyGenerations.clear();
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();
	}

	async forceCloseAll(): Promise<void> {
		const initPromises = [...this.historyInitPromises.values()];
		for (const paneId of this.historyInitPromises.keys()) {
			this.nextHistoryGeneration(paneId);
		}
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();
		await Promise.all(initPromises);
		await Promise.all(this.closingHistoryWriterPromises.values());
		for (const writer of this.historyWriters.values()) {
			await writer.close().catch((error) => {
				console.warn(
					"[HistoryManager] Failed to close history writer during forceKillAll:",
					error,
				);
			});
		}
		this.historyWriters.clear();
		this.closingHistoryWriters.clear();
		this.closingHistoryWriterPromises.clear();
		this.historyInitPromises.clear();
		this.historyGenerations.clear();
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();
	}

	closeAllSync(): void {
		for (const paneId of this.historyInitPromises.keys()) {
			this.nextHistoryGeneration(paneId);
		}
		for (const paneId of this.historyWriters.keys()) {
			void this.closeHistoryWriter(paneId);
		}
		this.historyInitializing.clear();
		this.pendingHistoryData.clear();
		this.agentIdScanTails.clear();
		this.pendingHookSessions.clear();
	}
}
