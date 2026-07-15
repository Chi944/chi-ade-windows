import { describe, expect, test } from "bun:test";
import { parsePeerAppStateJson } from "./watcher";

describe("app-state watcher validation boundary", () => {
	test("deep-normalizes a valid peer snapshot through the shared schema", () => {
		const state = parsePeerAppStateJson(
			JSON.stringify({
				tabsState: {
					tabs: [
						{
							id: "tab-1",
							name: "Peer",
							workspaceId: "workspace-1",
							createdAt: 1,
							layout: "pane-1",
						},
					],
					panes: {
						"pane-1": {
							id: "pane-1",
							tabId: "tab-1",
							type: "terminal",
							name: "Claude",
							agentRuntime: "claude",
							terminalProfileId: "nord",
						},
					},
				},
				sync: { deviceId: "peer-device" },
			}),
			"local-device",
		);

		expect(state.sync.deviceId).toBe("peer-device");
		expect(state.tabsState.panes["pane-1"].terminalProfileId).toBe("nord");
		expect(state.tabsState.activeTabIds).toEqual({});
		expect(state.themeState).toEqual({
			activeThemeId: "dark",
			customThemes: [],
		});
	});

	test("rejects malformed peer snapshots instead of emitting them", () => {
		expect(() =>
			parsePeerAppStateJson(
				JSON.stringify({ tabsState: { tabs: null } }),
				"local-device",
			),
		).toThrow(/shape|tabs/i);
	});
});
