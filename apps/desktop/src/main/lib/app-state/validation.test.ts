import { describe, expect, test } from "bun:test";
import type { AppState } from "./schemas";
import {
	MAX_APP_STATE_JSON_BYTES,
	MAX_APP_STATE_RECORD_ENTRIES,
	normalizeAppState,
	parseAppStateJson,
} from "./validation";

const LOCAL_DEVICE_ID = "local-device";

function createValidState(): AppState {
	return {
		tabsState: {
			tabs: [
				{
					id: "terminal-tab",
					name: "Terminal",
					userTitle: "Pinned terminal",
					workspaceId: "workspace-1",
					createdAt: 1,
					layout: "terminal-pane",
				},
				{
					id: "browser-tab",
					name: "Browser",
					workspaceId: "workspace-1",
					createdAt: 2,
					layout: {
						direction: "row",
						first: "browser-pane",
						second: "devtools-pane",
						splitPercentage: 60,
					},
				},
				{
					id: "file-tab",
					name: "File",
					workspaceId: "workspace-1",
					createdAt: 3,
					layout: "file-pane",
				},
			],
			panes: {
				"terminal-pane": {
					id: "terminal-pane",
					tabId: "terminal-tab",
					type: "terminal",
					name: "Claude",
					userTitle: "Review agent",
					isNew: false,
					status: "review",
					initialCwd: "C:\\repo",
					cwd: "C:\\repo",
					cwdConfirmed: true,
					terminalProfileId: "nord",
					agentRuntime: "claude",
					subscriptionProfilePinned: true,
					allowKilledRestore: true,
				},
				"browser-pane": {
					id: "browser-pane",
					tabId: "browser-tab",
					type: "webview",
					name: "Docs",
					url: "https://example.com",
					browser: {
						currentUrl: "https://example.com/current",
						history: [
							{
								url: "https://example.com",
								title: "Example",
								timestamp: 4,
								faviconUrl: "https://example.com/favicon.ico",
							},
						],
						historyIndex: 0,
						isLoading: false,
						error: {
							code: -105,
							description: "Name not resolved",
							url: "https://example.invalid",
						},
						viewport: { name: "Laptop", width: 1280, height: 800 },
					},
				},
				"devtools-pane": {
					id: "devtools-pane",
					tabId: "browser-tab",
					type: "devtools",
					name: "DevTools",
					devtools: { targetPaneId: "browser-pane" },
				},
				"file-pane": {
					id: "file-pane",
					tabId: "file-tab",
					type: "file-viewer",
					name: "README.md",
					fileViewer: {
						filePath: "README.md",
						absolutePath: "C:\\repo\\README.md",
						viewMode: "diff",
						isPinned: true,
						diffLayout: "side-by-side",
						diffCategory: "unstaged",
						commitHash: "abc123",
						oldPath: "README.old.md",
					},
				},
			},
			activeTabIds: { "workspace-1": "terminal-tab" },
			focusedPaneIds: {
				"terminal-tab": "terminal-pane",
				"browser-tab": "browser-pane",
				"file-tab": "file-pane",
			},
			tabHistoryStacks: {
				"workspace-1": ["browser-tab", "file-tab"],
			},
		},
		themeState: { activeThemeId: "dark", customThemes: [] },
		hotkeysState: {
			version: 1,
			byPlatform: {
				darwin: { OPEN_SETTINGS: "meta+," },
				win32: { OPEN_SETTINGS: "ctrl+," },
				linux: { OPEN_SETTINGS: null },
			},
		},
		sync: {
			deviceId: "peer-device",
			lastWrittenAt: 5,
			perWorkspaceWrittenAt: {
				"canonical-workspace": { deviceId: "peer-device", at: 5 },
			},
			workspaceMetadata: {
				"canonical-workspace": {
					mainRepoPath: "C:\\repo",
					branch: "main",
					type: "worktree",
				},
			},
			localToCanonical: {
				"workspace-1": "canonical-workspace",
			},
			paneClaudeSessions: { "terminal-pane": "session-1" },
		},
	};
}

function normalize(input: unknown): AppState {
	return normalizeAppState(input, { deviceId: LOCAL_DEVICE_ID });
}

describe("app-state runtime validation", () => {
	test("preserves every current persisted pane and browser field", () => {
		const input = createValidState();
		const result = normalize(input);

		expect(result).toEqual(input);
		expect(result).not.toBe(input);
		expect(result.tabsState.panes["terminal-pane"].terminalProfileId).toBe(
			"nord",
		);
		expect(result.tabsState.panes["browser-pane"].browser?.error).toEqual({
			code: -105,
			description: "Name not resolved",
			url: "https://example.invalid",
		});
	});

	test("normalizes only supported legacy omissions", () => {
		const result = normalize({
			tabsState: { tabs: [], panes: {} },
			themeState: { activeThemeId: "system" },
			hotkeysState: { version: 1, byPlatform: { win32: {} } },
		});

		expect(result).toEqual({
			tabsState: {
				tabs: [],
				panes: {},
				activeTabIds: {},
				focusedPaneIds: {},
				tabHistoryStacks: {},
			},
			themeState: { activeThemeId: "system", customThemes: [] },
			hotkeysState: {
				version: 1,
				byPlatform: { darwin: {}, win32: {}, linux: {} },
			},
			sync: {
				deviceId: LOCAL_DEVICE_ID,
				lastWrittenAt: 0,
				perWorkspaceWrittenAt: {},
				workspaceMetadata: {},
				localToCanonical: {},
				paneClaudeSessions: {},
			},
		});
	});

	test.each([
		{},
		{ tabsState: {} },
	])("rejects a persisted snapshot without the durable tabs core: %p", (input) => {
		expect(() =>
			parseAppStateJson(JSON.stringify(input), {
				deviceId: LOCAL_DEVICE_ID,
			}),
		).toThrow(/tabs|panes|core|shape/i);
	});

	test("returns deep clones and never shares mutable defaults", () => {
		const first = normalize({});
		const second = normalize({});

		first.tabsState.activeTabIds.injected = "tab";
		first.hotkeysState.byPlatform.win32.OPEN_SETTINGS = "ctrl+shift+,";
		if (first.sync) first.sync.localToCanonical.injected = "canonical";

		expect(second.tabsState.activeTabIds).toEqual({});
		expect(second.hotkeysState.byPlatform.win32).toEqual({});
		expect(second.sync?.localToCanonical).toEqual({});
	});

	test("strips explicitly recognized non-durable renderer fields", () => {
		const input = createValidState() as AppState & {
			tabsState: AppState["tabsState"] & { closedTabsStack?: unknown[] };
		};
		input.tabsState.closedTabsStack = [{ privateUndoEntry: true }];
		const fileViewer = input.tabsState.panes["file-pane"]
			.fileViewer as NonNullable<
			(typeof input.tabsState.panes)["file-pane"]["fileViewer"]
		> & { initialLine?: number; initialColumn?: number };
		fileViewer.initialLine = 12;
		fileViewer.initialColumn = 4;

		const result = normalize(input) as AppState & {
			tabsState: AppState["tabsState"] & { closedTabsStack?: unknown[] };
		};

		expect(result.tabsState.closedTabsStack).toBeUndefined();
		expect(
			(
				result.tabsState.panes["file-pane"].fileViewer as {
					initialLine?: number;
				}
			).initialLine,
		).toBeUndefined();
	});

	test.each([
		["null tabs state", { tabsState: null }],
		["null tabs collection", { tabsState: { tabs: null } }],
		["tabs object instead of array", { tabsState: { tabs: {} } }],
		["panes array instead of object", { tabsState: { panes: [] } }],
		["theme array instead of object", { themeState: [] }],
		["sync array instead of object", { sync: [] }],
	])("rejects %s", (_name, input) => {
		expect(() => normalize(input)).toThrow();
	});

	test("rejects non-finite timestamps and layout percentages", () => {
		for (const mutate of [
			(state: AppState) => {
				state.tabsState.tabs[0].createdAt = Number.POSITIVE_INFINITY;
			},
			(state: AppState) => {
				const browser = state.tabsState.panes["browser-pane"].browser;
				if (browser) browser.history[0].timestamp = Number.NaN;
			},
			(state: AppState) => {
				if (state.sync) state.sync.lastWrittenAt = Number.NEGATIVE_INFINITY;
			},
			(state: AppState) => {
				const layout = state.tabsState.tabs[1].layout;
				if (typeof layout !== "string") {
					layout.splitPercentage = Number.NaN;
				}
			},
		]) {
			const state = createValidState();
			mutate(state);
			expect(() => normalize(state)).toThrow();
		}
	});

	test("rejects malformed and dangling layouts", () => {
		const invalidDirection = createValidState();
		(
			invalidDirection.tabsState.tabs[1].layout as { direction: string }
		).direction = "diagonal";
		expect(() => normalize(invalidDirection)).toThrow();

		const missingLeaf = createValidState();
		missingLeaf.tabsState.tabs[0].layout = "missing-pane";
		expect(() => normalize(missingLeaf)).toThrow(/layout|pane/i);

		const crossTabLeaf = createValidState();
		crossTabLeaf.tabsState.tabs[0].layout = "browser-pane";
		expect(() => normalize(crossTabLeaf)).toThrow(/layout|tab/i);

		const duplicateLeaf = createValidState();
		duplicateLeaf.tabsState.tabs[1].layout = {
			direction: "column",
			first: "browser-pane",
			second: "browser-pane",
		};
		expect(() => normalize(duplicateLeaf)).toThrow(/layout|duplicate/i);
	});

	test("rejects dangling panes, focused IDs, active IDs, and history IDs", () => {
		const cases: AppState[] = [];

		const danglingPane = createValidState();
		danglingPane.tabsState.panes["terminal-pane"].tabId = "missing-tab";
		cases.push(danglingPane);

		const mismatchedPaneKey = createValidState();
		mismatchedPaneKey.tabsState.panes["terminal-pane"].id = "other-pane";
		cases.push(mismatchedPaneKey);

		const focused = createValidState();
		focused.tabsState.focusedPaneIds["terminal-tab"] = "browser-pane";
		cases.push(focused);

		const active = createValidState();
		active.tabsState.activeTabIds["workspace-1"] = "foreign-tab";
		cases.push(active);

		const history = createValidState();
		history.tabsState.tabHistoryStacks["workspace-2"] = ["terminal-tab"];
		cases.push(history);

		for (const state of cases) {
			expect(() => normalize(state)).toThrow();
		}
	});

	test("rejects unknown runtime and provider-profile data", () => {
		const unknownRuntime = createValidState();
		(
			unknownRuntime.tabsState.panes["terminal-pane"] as {
				agentRuntime: string;
			}
		).agentRuntime = "future-agent";
		expect(() => normalize(unknownRuntime)).toThrow(/runtime|agent/i);

		const invalidProfile = createValidState();
		invalidProfile.tabsState.panes["terminal-pane"].subscriptionProfileId =
			"named-account";
		expect(() => normalize(invalidProfile)).toThrow(/profile|uuid/i);

		const unknownProfileField = createValidState();
		(
			unknownProfileField.tabsState.panes["terminal-pane"] as unknown as Record<
				string,
				unknown
			>
		).providerProfile = { token: "must-not-persist" };
		expect(() => normalize(unknownProfileField)).toThrow();
	});

	test("rejects oversized records and raw payloads", () => {
		const state = createValidState();
		state.sync = {
			...state.sync,
			localToCanonical: Object.fromEntries(
				Array.from({ length: MAX_APP_STATE_RECORD_ENTRIES + 1 }, (_, index) => [
					`workspace-${index}`,
					`canonical-${index}`,
				]),
			),
		};
		expect(() => normalize(state)).toThrow(/large|entries|record|size/i);

		expect(() =>
			parseAppStateJson(" ".repeat(MAX_APP_STATE_JSON_BYTES + 1), {
				deviceId: LOCAL_DEVICE_ID,
			}),
		).toThrow(/large|size|bytes/i);
	});

	test("rejects invalid sync envelopes", () => {
		const invalidClock = createValidState();
		if (invalidClock.sync) {
			invalidClock.sync.perWorkspaceWrittenAt["canonical-workspace"].at = -1;
		}
		expect(() => normalize(invalidClock)).toThrow(/sync|timestamp|written|at/i);

		const invalidMetadata = createValidState();
		if (invalidMetadata.sync) {
			(
				invalidMetadata.sync.workspaceMetadata["canonical-workspace"] as {
					type: string;
				}
			).type = "unknown";
		}
		expect(() => normalize(invalidMetadata)).toThrow(/sync|metadata|type/i);

		expect(() =>
			parseAppStateJson("{not-json", { deviceId: LOCAL_DEVICE_ID }),
		).toThrow(/json/i);
	});
});
