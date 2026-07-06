/**
 * Ephemeral, in-memory registry of pane ids that just arrived via cross-Mac
 * sync (see useTabsSyncSubscription). It exists so the terminal lifecycle hooks
 * can tell a *synced-from-peer* pane apart from a normal same-machine pane at
 * the point where they would auto-resume a Claude session.
 *
 * For synced panes we STAGE the `claude --resume <id>` command into the prompt
 * but do NOT press Enter — the user decides when to continue the conversation.
 * Same-machine cold-restore / reboot behavior is left untouched (it still
 * auto-runs), because the user is fine with that flow.
 *
 * This is deliberately module-level state, mirroring the `skipNextTabsPersist`
 * flag in `renderer/lib/trpc-storage.ts`. It is NOT part of the persisted Pane
 * schema, so the marker never echoes back across Syncthing.
 */

const syncedPaneIds = new Set<string>();

/** Mark a pane as having arrived from a peer Mac via sync. */
export function markSyncedPane(paneId: string): void {
	syncedPaneIds.add(paneId);
}

/**
 * Returns true if the pane arrived via sync, consuming the marker so it only
 * affects the first auto-resume attempt for that pane. After this returns true
 * once, subsequent calls for the same pane return false (normal behavior).
 */
export function consumeSyncedPane(paneId: string): boolean {
	return syncedPaneIds.delete(paneId);
}
