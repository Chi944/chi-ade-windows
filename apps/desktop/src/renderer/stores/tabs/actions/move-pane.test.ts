import { describe, expect, it } from "bun:test";
import type { TabsState } from "../types";
import {
	buildMultiPaneLayout,
	extractPaneIdsFromLayout,
	MAX_PANES_PER_TAB,
} from "../utils";
import { movePaneToTab } from "./move-pane";

function createState(targetPaneCount: number): TabsState {
	const sourcePaneId = "source-pane";
	const targetPaneIds = Array.from(
		{ length: targetPaneCount },
		(_, index) => `target-pane-${index + 1}`,
	);

	return {
		tabs: [
			{
				id: "source-tab",
				name: "Source",
				workspaceId: "workspace-1",
				layout: sourcePaneId,
				createdAt: 1,
			},
			{
				id: "target-tab",
				name: "Target",
				workspaceId: "workspace-1",
				layout: buildMultiPaneLayout(targetPaneIds),
				createdAt: 2,
			},
		],
		panes: {
			[sourcePaneId]: {
				id: sourcePaneId,
				tabId: "source-tab",
				type: "terminal",
				name: "Source",
			},
			...Object.fromEntries(
				targetPaneIds.map((id) => [
					id,
					{ id, tabId: "target-tab", type: "terminal" as const, name: id },
				]),
			),
		},
		activeTabIds: { "workspace-1": "source-tab" },
		focusedPaneIds: {
			"source-tab": sourcePaneId,
			"target-tab": targetPaneIds[0],
		},
		tabHistoryStacks: { "workspace-1": [] },
		closedTabsStack: [],
	};
}

describe("movePaneToTab capacity", () => {
	it("moves into a five-pane target and rebalances it to six views", () => {
		const result = movePaneToTab(
			createState(MAX_PANES_PER_TAB - 1),
			"source-pane",
			"target-tab",
		);

		expect(result).not.toBeNull();
		const target = result?.tabs.find((tab) => tab.id === "target-tab");
		expect(target).toBeDefined();
		expect(extractPaneIdsFromLayout(target?.layout ?? "missing")).toEqual([
			"target-pane-1",
			"target-pane-2",
			"target-pane-3",
			"target-pane-4",
			"target-pane-5",
			"source-pane",
		]);
		expect(target?.layout).toEqual(
			buildMultiPaneLayout([
				"target-pane-1",
				"target-pane-2",
				"target-pane-3",
				"target-pane-4",
				"target-pane-5",
				"source-pane",
			]),
		);
	});

	it("rejects moving into a target that already has six views", () => {
		const result = movePaneToTab(
			createState(MAX_PANES_PER_TAB),
			"source-pane",
			"target-tab",
		);

		expect(result).toBeNull();
	});
});
