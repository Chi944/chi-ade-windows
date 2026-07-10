import { getWorkspaceCoordinationToken } from "main/lib/coordination/auth";
import {
	getProviderRuntimeEnvironment,
	setSubscriptionProfileEnvironmentResolver,
} from "main/lib/provider-keys";
import {
	getSubscriptionProfileEnvironment,
	getSubscriptionProfileEnvironmentForPane,
} from "main/lib/subscription-profiles";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import type { ListSessionsResponse } from "main/lib/terminal-host/types";
import {
	prewarmTerminalEnv,
	setCoordinationTokenResolver,
	setProviderEnvironmentResolver,
} from "./env";
import {
	RECONCILE_STARTUP_TIMEOUT_MS,
	reconcileWithTimeout,
} from "./reconcile";
import { getServiceTerminalManager, ServiceTerminalManager } from "./service";

// Wire the encrypted key store into buildTerminalEnv from the main process. This
// import lives here (main-only) rather than in env.ts, which is also loaded by
// the terminal-host subprocess and must stay free of localDb/electron.
setProviderEnvironmentResolver((context) =>
	getProviderRuntimeEnvironment(context),
);
setCoordinationTokenResolver(getWorkspaceCoordinationToken);
setSubscriptionProfileEnvironmentResolver((provider, paneId, workspaceId) =>
	paneId
		? getSubscriptionProfileEnvironmentForPane(provider, paneId, workspaceId)
		: getSubscriptionProfileEnvironment(provider),
);

export { ServiceTerminalManager, getServiceTerminalManager };
export type {
	CreateSessionParams,
	SessionResult,
	TerminalDataEvent,
	TerminalEvent,
	TerminalExitEvent,
} from "./types";

const DEBUG_TERMINAL = process.env.SUPERSET_TERMINAL_DEBUG === "1";
let prewarmInFlight: Promise<void> | null = null;

/**
 * Reconcile service sessions on app startup.
 * Cleans up stale sessions from previous app runs and preserves sessions
 * that can be retained. Bounded by a hard timeout so a wedged service can never
 * brick boot — reconcileOnStartup runs before the main window is created (see
 * reconcileWithTimeout). `timeoutMs` is injectable for tests.
 */
export async function reconcileServiceSessions(
	timeoutMs: number = RECONCILE_STARTUP_TIMEOUT_MS,
): Promise<void> {
	await reconcileWithTimeout(getServiceTerminalManager(), timeoutMs);
}

/**
 * Restart the terminal service. Kills all sessions, shuts down the service,
 * and resets the manager so a fresh service spawns on next use.
 */
export async function restartService(): Promise<{ success: boolean }> {
	console.log("[restartService] Starting service restart...");

	try {
		const client = getTerminalHostClient();
		const connected = await client.tryConnectAndAuthenticate();

		if (connected) {
			const { sessions } = await client.listSessions();
			const aliveCount = sessions.filter((s) => s.isAlive).length;
			console.log(
				`[restartService] Shutting down service with ${aliveCount} alive sessions`,
			);

			await client.shutdownIfRunning({ killSessions: true });
		} else {
			console.log("[restartService] Service was not running");
		}
	} catch (error) {
		console.warn("[restartService] Error during shutdown (continuing):", error);
	}

	const manager = getServiceTerminalManager();
	manager.reset();

	console.log("[restartService] Complete");

	return { success: true };
}

export async function tryListExistingServiceSessions(): Promise<{
	sessions: ListSessionsResponse["sessions"];
}> {
	try {
		const client = getTerminalHostClient();
		const result = await client.listSessions();
		return { sessions: result.sessions };
	} catch (error) {
		console.warn(
			"[TerminalManager] Failed to list existing service sessions (getTerminalHostClient/client.listSessions):",
			error,
		);
		if (DEBUG_TERMINAL) {
			console.log(
				"[TerminalManager] Failed to list existing service sessions:",
				error,
			);
		}
		return { sessions: [] };
	}
}

/**
 * Best-effort terminal runtime warmup.
 * Runs in the background to reduce latency for the first user-opened terminal:
 * - precomputes locale/env fallback
 * - ensures service control/stream channels are established
 */
export function prewarmTerminalRuntime(): void {
	if (prewarmInFlight) return;

	prewarmInFlight = (async () => {
		try {
			prewarmTerminalEnv();
		} catch (error) {
			if (DEBUG_TERMINAL) {
				console.warn(
					"[TerminalManager] Failed to prewarm terminal env:",
					error,
				);
			}
		}

		try {
			await getTerminalHostClient().ensureConnected();
		} catch (error) {
			if (DEBUG_TERMINAL) {
				console.warn(
					"[TerminalManager] Failed to prewarm terminal service connection:",
					error,
				);
			}
		}
	})().finally(() => {
		prewarmInFlight = null;
	});
}
