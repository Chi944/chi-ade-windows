import { beforeEach, describe, expect, mock, test } from "bun:test";
import { remoteWorkspaceBindings, workspaces } from "@superset/local-db";
import {
	type AppState,
	createDefaultAppState,
} from "main/lib/app-state/schemas";
import { normalizeAppState } from "main/lib/app-state/validation";

let currentState: AppState = createDefaultAppState("local-device");
const directWrite = mock(async () => undefined);
const appState = {
	data: currentState,
	write: directWrite,
};
const mutationLabels: string[] = [];
let revision = 0;
const enqueueAppStateMutation = mock(
	async (
		label: string,
		mutate: (draft: AppState) => unknown | Promise<unknown>,
	) => {
		mutationLabels.push(label);
		const draft = structuredClone(currentState);
		const result = await mutate(draft);
		currentState = normalizeAppState(draft, { deviceId: "local-device" });
		appState.data = currentState;
		revision += 1;
		return { label, revision, result, state: structuredClone(currentState) };
	},
);
const getCanonicalForLocalWorkspaceId = mock(() => ({
	canonical: "path-derived-canonical",
	meta: { mainRepoPath: "C:\\secret", branch: "main", type: "worktree" },
}));
const readMetadata = mock(async () => ({ claudeSessionId: "session-1" }));

mock.module("main/lib/app-state", () => ({
	appState,
	enqueueAppStateMutation,
	getAppStateSnapshot: () => structuredClone(currentState),
	getDeviceId: () => "local-device",
}));
mock.module("main/lib/local-db", () => ({
	localDb: {
		select: () => ({
			from: (table: unknown) => ({
				all: () =>
					table === workspaces
						? [{ workspaceId: "workspace-1" }]
						: table === remoteWorkspaceBindings
							? []
							: [],
			}),
		}),
	},
}));
mock.module("main/lib/sync/workspace-identity", () => ({
	getCanonicalForLocalWorkspaceId,
}));
mock.module("main/lib/terminal-history", () => ({
	HistoryReader: class {
		readMetadata = readMetadata;
	},
}));

const { createUiStateRouter } = await import(".");

beforeEach(() => {
	currentState = createDefaultAppState("local-device");
	currentState.sync.workspaceMetadata.legacy = {
		mainRepoPath: "C:\\legacy",
		branch: "main",
		type: "worktree",
	};
	appState.data = currentState;
	revision = 0;
	mutationLabels.length = 0;
	directWrite.mockClear();
	enqueueAppStateMutation.mockClear();
	getCanonicalForLocalWorkspaceId.mockClear();
	readMetadata.mockClear();
});

describe("UI-state mutation coordination", () => {
	test("routes tabs through one queued state-and-sync commit", async () => {
		const caller = createUiStateRouter().createCaller({});

		await caller.tabs.set({
			tabs: [
				{
					id: "tab-1",
					name: "Agent",
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
					subscriptionProfileId: "11111111-1111-4111-8111-111111111111",
				},
			},
			activeTabIds: { "workspace-1": "tab-1" },
			focusedPaneIds: { "tab-1": "pane-1" },
			tabHistoryStacks: { "workspace-1": [] },
			closedTabsStack: [{ mustRemainTransient: true }],
		});

		expect(mutationLabels).toEqual(["ui-state.tabs.set"]);
		expect(enqueueAppStateMutation).toHaveBeenCalledTimes(1);
		expect(directWrite).not.toHaveBeenCalled();
		expect(currentState.tabsState.panes["pane-1"]).toMatchObject({
			terminalProfileId: "nord",
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
		expect(currentState.sync.deviceId).toBe("local-device");
		expect(currentState.sync.paneClaudeSessions).toEqual({
			"pane-1": "session-1",
		});
		expect(currentState.sync.workspaceMetadata).toEqual({
			legacy: {
				mainRepoPath: "C:\\legacy",
				branch: "main",
				type: "worktree",
			},
		});
		expect(getCanonicalForLocalWorkspaceId).not.toHaveBeenCalled();
	});

	test("routes theme and hotkeys through the same coordinator", async () => {
		const caller = createUiStateRouter().createCaller({});

		await caller.theme.set({ activeThemeId: "system", customThemes: [] });
		await caller.hotkeys.set({
			version: 1,
			byPlatform: { darwin: {}, win32: {}, linux: {} },
		});

		expect(mutationLabels).toEqual([
			"ui-state.theme.set",
			"ui-state.hotkeys.set",
		]);
		expect(enqueueAppStateMutation).toHaveBeenCalledTimes(2);
		expect(directWrite).not.toHaveBeenCalled();
		expect(currentState.themeState.activeThemeId).toBe("system");
		expect(currentState.hotkeysState.version).toBe(1);
		expect(currentState.sync.deviceId).toBe("local-device");
	});

	test("serves cloned snapshots without mutating committed state during get", async () => {
		currentState.tabsState = {
			tabs: [
				{
					id: "tab-1",
					name: "Agent",
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
					subscriptionProfileId: "11111111-1111-4111-8111-111111111111",
				},
			},
			activeTabIds: {},
			focusedPaneIds: {},
			tabHistoryStacks: {},
		};
		appState.data = currentState;
		const caller = createUiStateRouter().createCaller({});

		const returned = await caller.tabs.get();
		returned.tabs[0].name = "mutated-return";

		expect(currentState.tabsState.tabs[0].name).toBe("Agent");
		expect(currentState.tabsState.panes["pane-1"].subscriptionProfileId).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
		expect(enqueueAppStateMutation).not.toHaveBeenCalled();
		expect(directWrite).not.toHaveBeenCalled();
	});
});
