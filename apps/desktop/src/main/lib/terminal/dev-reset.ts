import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SUPERSET_HOME_DIR } from "main/lib/app-environment";
import { enqueueAppStateMutation, getDeviceId } from "main/lib/app-state";
import { createDefaultAppState } from "main/lib/app-state/schemas";
import {
	disposeTerminalHostClient,
	getTerminalHostClient,
} from "main/lib/terminal-host/client";

const TERMINAL_STATE_PATHS = [
	"terminal-history",
	"terminal-host.sock",
	"terminal-host.token",
	"terminal-host.pid",
	"terminal-host.spawn.lock",
	"terminal-host.mtime",
	"service.log",
] as const;

export async function resetTerminalStateDev(): Promise<void> {
	console.log("[dev/reset-terminal-state] Resetting terminal state…");

	try {
		const client = getTerminalHostClient();
		await client.shutdownIfRunning({ killSessions: true });
	} catch (error) {
		console.warn(
			"[dev/reset-terminal-state] Failed to shutdown service (best-effort):",
			error,
		);
	} finally {
		disposeTerminalHostClient();
	}

	for (const relativePath of TERMINAL_STATE_PATHS) {
		const fullPath = join(SUPERSET_HOME_DIR, relativePath);
		await rm(fullPath, { recursive: true, force: true }).catch((error) => {
			console.warn(
				"[dev/reset-terminal-state] Failed to remove state path:",
				fullPath,
				error,
			);
		});
	}

	// Clear tabs/panes so we don't immediately try to restore a large terminal set.
	try {
		await enqueueAppStateMutation(
			"recovery.dev-reset-terminal-state",
			(draft) => {
				draft.tabsState = createDefaultAppState().tabsState;
				draft.sync.deviceId = getDeviceId();
				draft.sync.lastWrittenAt = Date.now();
			},
		);
	} catch (error) {
		console.warn(
			"[dev/reset-terminal-state] Failed to persist app state reset:",
			error,
		);
	}

	console.log("[dev/reset-terminal-state] Done.");
}
