import type { BaseTabsState } from "shared/tabs-types";

interface WorkspaceTarget {
	paneId?: string;
	tabId?: string;
	workspaceId: string;
}

function tabWorkspaceId(
	tabsState: BaseTabsState,
	tabId: string,
): string | undefined {
	return tabsState.tabs.find((tab) => tab.id === tabId)?.workspaceId;
}

function paneBelongsToWorkspace(
	tabsState: BaseTabsState,
	paneId: string,
	workspaceId: string,
): boolean {
	const pane = tabsState.panes[paneId];
	return !!pane && tabWorkspaceId(tabsState, pane.tabId) === workspaceId;
}

/**
 * Unknown IDs are treated as stale and may fall back to the active workspace.
 * Known targets must be owned by the authenticated workspace.
 */
export function isWorkspaceTargetAllowed(
	tabsState: BaseTabsState,
	target: WorkspaceTarget,
): boolean {
	if (
		target.paneId &&
		tabsState.panes[target.paneId] &&
		!paneBelongsToWorkspace(tabsState, target.paneId, target.workspaceId)
	) {
		return false;
	}

	if (target.tabId) {
		const ownerWorkspaceId = tabWorkspaceId(tabsState, target.tabId);
		if (ownerWorkspaceId && ownerWorkspaceId !== target.workspaceId) {
			return false;
		}
	}

	return true;
}

export function resolveWorkspacePaneId(
	tabsState: BaseTabsState,
	target: WorkspaceTarget,
): string | undefined {
	if (
		target.paneId &&
		paneBelongsToWorkspace(tabsState, target.paneId, target.workspaceId)
	) {
		return target.paneId;
	}

	if (
		target.tabId &&
		tabWorkspaceId(tabsState, target.tabId) === target.workspaceId
	) {
		const focusedPaneId = tabsState.focusedPaneIds[target.tabId];
		if (
			focusedPaneId &&
			paneBelongsToWorkspace(tabsState, focusedPaneId, target.workspaceId)
		) {
			return focusedPaneId;
		}
	}

	const activeTabId = tabsState.activeTabIds[target.workspaceId];
	if (
		activeTabId &&
		tabWorkspaceId(tabsState, activeTabId) === target.workspaceId
	) {
		const focusedPaneId = tabsState.focusedPaneIds[activeTabId];
		if (
			focusedPaneId &&
			paneBelongsToWorkspace(tabsState, focusedPaneId, target.workspaceId)
		) {
			return focusedPaneId;
		}
	}

	return undefined;
}
