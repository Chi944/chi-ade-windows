/**
 * UI state schemas (persisted from renderer zustand stores)
 */
import { createDefaultHotkeysState, type HotkeysState } from "shared/hotkeys";
import type { BaseTabsState } from "shared/tabs-types";
import type { Theme } from "shared/themes";

// Re-export for convenience
export type { BaseTabsState as TabsState, Pane } from "shared/tabs-types";

export interface ThemeState {
	activeThemeId: string;
	customThemes: Theme[];
}

/**
 * Cross-Mac sync envelope. Sidecar metadata that lets peer Macs
 * resolve workspace references when this file syncs in via Syncthing.
 *
 * The `tabs`/`panes` themselves still use local workspace UUIDs — the
 * canonical hashes here are the bridge. See sync/workspace-identity.ts.
 */
export interface AppStateSyncEnvelope {
	/** Per-machine UUID, persisted at `~/.ade/device-id`. */
	deviceId: string;
	/** Wall-clock ms of the most recent write by ANY workspace. */
	lastWrittenAt: number;
	/**
	 * Per-canonical-workspace last-writer info. Used by the renderer
	 * merge logic for per-workspace last-writer-wins.
	 */
	perWorkspaceWrittenAt: Record<string, { deviceId: string; at: number }>;
	/**
	 * Workspace metadata keyed by canonical hash so peers can resolve /
	 * auto-create missing local workspace rows.
	 */
	workspaceMetadata: Record<
		string,
		{ mainRepoPath: string; branch: string; type: string }
	>;
	/**
	 * Reverse map: writer's local workspace UUID → canonical hash. Lets
	 * peers translate `tabsState.tabs[].workspaceId` (which is the writer's
	 * LOCAL UUID on disk) → canonical → peer's local UUID via workspaceMetadata.
	 * Repopulated on every tabs.set write.
	 */
	localToCanonical: Record<string, string>;
	/**
	 * Per-pane Claude session id, carried cross-Mac because terminal-history
	 * is excluded from Syncthing. Keyed by paneId (paneIds are stable across
	 * Macs — they live in the synced tabs/panes state).
	 */
	paneClaudeSessions: Record<string, string>;
}

export interface AppState {
	tabsState: BaseTabsState;
	themeState: ThemeState;
	hotkeysState: HotkeysState;
	sync?: AppStateSyncEnvelope;
}

export const defaultAppState: AppState = {
	tabsState: {
		tabs: [],
		panes: {},
		activeTabIds: {},
		focusedPaneIds: {},
		tabHistoryStacks: {},
	},
	themeState: {
		activeThemeId: "dark",
		customThemes: [],
	},
	hotkeysState: createDefaultHotkeysState(),
	sync: {
		deviceId: "",
		lastWrittenAt: 0,
		perWorkspaceWrittenAt: {},
		workspaceMetadata: {},
		localToCanonical: {},
		paneClaudeSessions: {},
	},
};
