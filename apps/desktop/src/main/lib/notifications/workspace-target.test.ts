import { describe, expect, it } from "bun:test";
import type { BaseTabsState, Pane } from "shared/tabs-types";
import {
	isWorkspaceTargetAllowed,
	resolveWorkspacePaneId,
} from "./workspace-target";

function pane(id: string, tabId: string): Pane {
	return { id, tabId, type: "terminal", name: id };
}

const tabsState: BaseTabsState = {
	tabs: [
		{ id: "tab-a", name: "A", workspaceId: "workspace-a", createdAt: 1 },
		{ id: "tab-b", name: "B", workspaceId: "workspace-b", createdAt: 2 },
	],
	panes: {
		"pane-a": pane("pane-a", "tab-a"),
		"pane-b": pane("pane-b", "tab-b"),
	},
	activeTabIds: { "workspace-a": "tab-a", "workspace-b": "tab-b" },
	focusedPaneIds: { "tab-a": "pane-a", "tab-b": "pane-b" },
	tabHistoryStacks: { "workspace-a": ["tab-a"], "workspace-b": ["tab-b"] },
};

describe("workspace notification targets", () => {
	it("rejects an existing pane owned by another workspace", () => {
		expect(
			isWorkspaceTargetAllowed(tabsState, {
				workspaceId: "workspace-a",
				paneId: "pane-b",
			}),
		).toBe(false);
	});

	it("rejects an existing tab owned by another workspace", () => {
		expect(
			isWorkspaceTargetAllowed(tabsState, {
				workspaceId: "workspace-a",
				tabId: "tab-b",
			}),
		).toBe(false);
	});

	it("allows stale IDs and falls back to the authenticated workspace", () => {
		const target = {
			workspaceId: "workspace-a",
			paneId: "stale-pane",
			tabId: "stale-tab",
		};
		expect(isWorkspaceTargetAllowed(tabsState, target)).toBe(true);
		expect(resolveWorkspacePaneId(tabsState, target)).toBe("pane-a");
	});

	it("never resolves a focused pane outside the authenticated workspace", () => {
		const corruptedState = {
			...tabsState,
			focusedPaneIds: { ...tabsState.focusedPaneIds, "tab-a": "pane-b" },
		};
		expect(
			resolveWorkspacePaneId(corruptedState, {
				workspaceId: "workspace-a",
				tabId: "tab-a",
			}),
		).toBeUndefined();
	});
});
