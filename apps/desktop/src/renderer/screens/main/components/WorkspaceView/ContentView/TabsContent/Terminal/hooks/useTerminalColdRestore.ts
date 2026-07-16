import type { AgentRuntime } from "@superset/local-db";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useRef, useState } from "react";
import { electronTrpcClient as trpcClient } from "renderer/lib/trpc-client";
import {
	preparePaneResumeInput,
	restorePaneResumeMarkerAfterWriteFailure,
} from "renderer/stores/tabs/syncedPaneRegistry";
import { buildAgentResumeCommand } from "shared/agent-session-recovery";
import { coldRestoreState } from "../state";
import type {
	CreateOrAttachMutate,
	CreateOrAttachResult,
	TerminalStreamEvent,
} from "../types";
import { scrollToBottom } from "../utils";

export interface UseTerminalColdRestoreOptions {
	paneId: string;
	tabId: string;
	workspaceId: string;
	agentRuntime?: AgentRuntime;
	subscriptionProfileId?: string | null;
	xtermRef: React.MutableRefObject<XTerm | null>;
	fitAddonRef: React.MutableRefObject<FitAddon | null>;
	isStreamReadyRef: React.MutableRefObject<boolean>;
	isExitedRef: React.MutableRefObject<boolean>;
	wasKilledByUserRef: React.MutableRefObject<boolean>;
	isFocusedRef: React.MutableRefObject<boolean>;
	didFirstRenderRef: React.MutableRefObject<boolean>;
	pendingInitialStateRef: React.MutableRefObject<CreateOrAttachResult | null>;
	pendingEventsRef: React.MutableRefObject<TerminalStreamEvent[]>;
	createOrAttachRef: React.MutableRefObject<CreateOrAttachMutate>;
	setConnectionError: (error: string | null) => void;
	setExitStatus: (status: "killed" | "exited" | null) => void;
	maybeApplyInitialState: () => void;
	flushPendingEvents: () => void;
	resetModes: () => void;
}

export interface UseTerminalColdRestoreReturn {
	isRestoredMode: boolean;
	restoredCwd: string | null;
	setIsRestoredMode: (value: boolean) => void;
	setRestoredCwd: (value: string | null) => void;
	handleRetryConnection: () => void;
	handleStartShell: () => void;
}

/**
 * Hook to manage cold restore (reboot recovery) functionality.
 *
 * Handles:
 * - Retry connection after service loss
 * - Starting new shell from restored scrollback
 * - Managing cold restore overlay state
 */
export function useTerminalColdRestore({
	paneId,
	tabId,
	workspaceId,
	agentRuntime,
	subscriptionProfileId,
	xtermRef,
	fitAddonRef,
	isStreamReadyRef,
	isExitedRef,
	wasKilledByUserRef,
	isFocusedRef,
	didFirstRenderRef,
	pendingInitialStateRef,
	pendingEventsRef,
	createOrAttachRef,
	setConnectionError,
	setExitStatus,
	maybeApplyInitialState,
	flushPendingEvents,
	resetModes,
}: UseTerminalColdRestoreOptions): UseTerminalColdRestoreReturn {
	const [isRestoredMode, setIsRestoredMode] = useState(false);
	const [restoredCwd, setRestoredCwd] = useState<string | null>(null);

	// Ref for restoredCwd to use in callbacks
	const restoredCwdRef = useRef(restoredCwd);
	restoredCwdRef.current = restoredCwd;

	const handleRetryConnection = useCallback(() => {
		setConnectionError(null);
		const xterm = xtermRef.current;
		if (!xterm) return;

		isStreamReadyRef.current = false;
		pendingInitialStateRef.current = null;

		createOrAttachRef.current(
			{
				paneId,
				tabId,
				workspaceId,
				cols: xterm.cols,
				rows: xterm.rows,
				runtime: agentRuntime,
				subscriptionProfileId,
			},
			{
				onSuccess: (result: CreateOrAttachResult) => {
					const currentXterm = xtermRef.current;
					if (!currentXterm) return;

					setConnectionError(null);
					currentXterm.writeln("\x1b[90m[Reconnected]\x1b[0m");

					if (result.isColdRestore) {
						const scrollback =
							result.snapshot?.snapshotAnsi ?? result.scrollback;
						coldRestoreState.set(paneId, {
							isRestored: true,
							cwd: result.previousCwd || null,
							scrollback,
							claudeSessionId: result.claudeSessionId || null,
							agentRuntime: result.agentRuntime ?? agentRuntime ?? null,
							agentSessionId:
								result.agentSessionId ?? result.claudeSessionId ?? null,
						});
						setIsRestoredMode(true);
						setRestoredCwd(result.previousCwd || null);

						currentXterm.clear();
						if (scrollback) {
							currentXterm.write(scrollback, () => {
								requestAnimationFrame(() => {
									if (xtermRef.current !== currentXterm) return;
									scrollToBottom(currentXterm);
								});
							});
						}

						didFirstRenderRef.current = true;
						return;
					}

					pendingInitialStateRef.current = result;
					maybeApplyInitialState();

					if (isFocusedRef.current) {
						currentXterm.focus();
					}
				},
				onError: (error: { message?: string }) => {
					if (error.message?.includes("TERMINAL_SESSION_KILLED")) {
						wasKilledByUserRef.current = true;
						isExitedRef.current = true;
						isStreamReadyRef.current = false;
						setExitStatus("killed");
						setConnectionError(null);
						return;
					}
					setConnectionError(error.message || "Connection failed");
					isStreamReadyRef.current = true;
					flushPendingEvents();
				},
			},
		);
	}, [
		paneId,
		tabId,
		workspaceId,
		agentRuntime,
		subscriptionProfileId,
		xtermRef,
		isStreamReadyRef,
		isExitedRef,
		wasKilledByUserRef,
		isFocusedRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		createOrAttachRef,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
	]);

	const handleStartShell = useCallback(() => {
		const xterm = xtermRef.current;
		const fitAddon = fitAddonRef.current;
		if (!xterm || !fitAddon) return;

		// Capture provider metadata before clearing cold restore state.
		const savedColdState = coldRestoreState.get(paneId);
		const claudeSessionId = savedColdState?.claudeSessionId;
		const runtime =
			savedColdState?.agentRuntime ??
			agentRuntime ??
			(claudeSessionId ? "claude" : undefined);
		const agentSessionId =
			savedColdState?.agentSessionId ?? claudeSessionId ?? undefined;
		console.log(
			"[ColdRestore] handleStartShell",
			JSON.stringify({
				paneId,
				savedColdStateExists: !!savedColdState,
				claudeSessionId,
				fullState: savedColdState
					? {
							isRestored: savedColdState.isRestored,
							hasCwd: !!savedColdState.cwd,
							hasScrollback: !!savedColdState.scrollback,
							claudeSessionId: savedColdState.claudeSessionId,
						}
					: null,
			}),
		);

		// Drop any queued events from the pre-restore session
		pendingEventsRef.current = [];

		// Acknowledge cold restore to main process
		trpcClient.terminal.ackColdRestore.mutate({ paneId }).catch((error) => {
			console.warn("[Terminal] Failed to acknowledge cold restore:", {
				paneId,
				error: error instanceof Error ? error.message : String(error),
			});
		});

		// Add visual separator
		xterm.write("\r\n\x1b[90m─── Session Contents Restored ───\x1b[0m\r\n\r\n");

		// Reset state for new session
		isStreamReadyRef.current = false;
		isExitedRef.current = false;
		wasKilledByUserRef.current = false;
		setExitStatus(null);
		pendingInitialStateRef.current = null;
		resetModes();

		// Create new session with previous cwd
		createOrAttachRef.current(
			{
				paneId,
				tabId,
				workspaceId,
				cols: xterm.cols,
				rows: xterm.rows,
				cwd: restoredCwdRef.current || undefined,
				skipColdRestore: true,
				allowKilled: true,
				runtime,
				subscriptionProfileId,
			},
			{
				onSuccess: (result: CreateOrAttachResult) => {
					pendingInitialStateRef.current = result;
					maybeApplyInitialState();

					setIsRestoredMode(false);
					coldRestoreState.delete(paneId);

					const resumeCommand = buildAgentResumeCommand({
						runtime,
						sessionId: agentSessionId,
					});
					if (resumeCommand) {
						// Synced-from-peer panes stage the command without pressing Enter.
						const terminalInput = preparePaneResumeInput(paneId, resumeCommand);
						setTimeout(() => {
							trpcClient.terminal.write
								.mutate({
									paneId,
									data: terminalInput,
								})
								.catch((err) => {
									restorePaneResumeMarkerAfterWriteFailure(
										paneId,
										terminalInput,
									);
									console.warn(
										"[Terminal] Failed to auto-resume Claude session:",
										err,
									);
								});
						}, 500);
					}

					setTimeout(() => {
						const currentXterm = xtermRef.current;
						if (currentXterm) {
							currentXterm.focus();
						}
					}, 0);
				},
				onError: (error: { message?: string }) => {
					console.error("[Terminal] Failed to start shell:", error);
					setConnectionError(error.message || "Failed to start shell");
					setIsRestoredMode(false);
					coldRestoreState.delete(paneId);
					isStreamReadyRef.current = true;
					flushPendingEvents();
				},
			},
		);
	}, [
		paneId,
		tabId,
		workspaceId,
		agentRuntime,
		subscriptionProfileId,
		xtermRef,
		fitAddonRef,
		isStreamReadyRef,
		isExitedRef,
		wasKilledByUserRef,
		pendingInitialStateRef,
		pendingEventsRef,
		createOrAttachRef,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
	]);

	return {
		isRestoredMode,
		restoredCwd,
		setIsRestoredMode,
		setRestoredCwd,
		handleRetryConnection,
		handleStartShell,
	};
}
