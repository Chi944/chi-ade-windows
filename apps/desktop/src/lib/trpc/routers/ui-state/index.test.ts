import { beforeEach, describe, expect, mock, test } from "bun:test";
import { remoteWorkspaceBindings, workspaces } from "@superset/local-db";
import {
	type AppState,
	createDefaultAppState,
	type TabsState,
} from "main/lib/app-state/schemas";
import { normalizeAppState } from "main/lib/app-state/validation";
import type { LocalWorkspaceIdentityResolution } from "shared/tabs-sync";

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
const getCanonicalForLocalWorkspaceId = mock((workspaceId: string) => ({
	canonical: `canonical-${workspaceId}`,
	meta: {
		repository: `example.com/acme/${workspaceId}`,
		branch: "main",
		type: "worktree" as const,
	},
}));
const getLocalWorkspaceIdentityResolutions = mock(
	(workspaceIds: string[]): Record<string, LocalWorkspaceIdentityResolution> =>
		Object.fromEntries(
			workspaceIds.map((workspaceId) => [
				workspaceId,
				{
					status: "verified" as const,
					canonical: `canonical-${workspaceId}`,
					metadata: {
						repository: `example.com/acme/${workspaceId}`,
						branch: "main",
						type: "worktree" as const,
					},
				},
			]),
		),
);
const readMetadata = mock(async () => ({ claudeSessionId: "session-1" }));
let startupPeerPaneIds: string[] = [];
const takeStartupPeerPaneIds = mock(() => {
	const paneIds = startupPeerPaneIds;
	startupPeerPaneIds = [];
	return paneIds;
});

mock.module("main/lib/app-state", () => ({
	appState,
	enqueueAppStateMutation,
	getAppStateSnapshot: () => structuredClone(currentState),
	getDeviceId: () => "local-device",
	takeStartupPeerPaneIds,
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
	getLocalWorkspaceIdentityResolutions,
}));
mock.module("main/lib/terminal-history", () => ({
	HistoryReader: class {
		readMetadata = readMetadata;
	},
}));

const { createUiStateRouter } = await import(".");

function tabsState(workspaceId: string, label: string): TabsState {
	return {
		tabs: [
			{
				id: `${label}-tab`,
				name: label,
				workspaceId,
				createdAt: 1,
				layout: `${label}-pane`,
			},
		],
		panes: {
			[`${label}-pane`]: {
				id: `${label}-pane`,
				tabId: `${label}-tab`,
				type: "terminal",
				name: label,
			},
		},
		activeTabIds: { [workspaceId]: `${label}-tab` },
		focusedPaneIds: { [`${label}-tab`]: `${label}-pane` },
		tabHistoryStacks: { [workspaceId]: [] },
	};
}

function combineTabs(...states: TabsState[]): TabsState {
	return {
		tabs: states.flatMap((state) => state.tabs),
		panes: Object.assign({}, ...states.map((state) => state.panes)),
		activeTabIds: Object.assign(
			{},
			...states.map((state) => state.activeTabIds),
		),
		focusedPaneIds: Object.assign(
			{},
			...states.map((state) => state.focusedPaneIds),
		),
		tabHistoryStacks: Object.assign(
			{},
			...states.map((state) => state.tabHistoryStacks),
		),
	};
}

beforeEach(() => {
	currentState = createDefaultAppState("local-device");
	currentState.sync.workspaceMetadata.legacy = {
		repository: "example.com/acme/legacy",
		branch: "main",
		type: "worktree",
	};
	appState.data = currentState;
	revision = 0;
	mutationLabels.length = 0;
	directWrite.mockClear();
	enqueueAppStateMutation.mockClear();
	getCanonicalForLocalWorkspaceId.mockClear();
	getLocalWorkspaceIdentityResolutions.mockClear();
	readMetadata.mockClear();
	startupPeerPaneIds = [];
	takeStartupPeerPaneIds.mockClear();
});

describe("UI-state mutation coordination", () => {
	test("serves one-time startup peer markers with a cloned tabs bootstrap", async () => {
		startupPeerPaneIds = ["peer-pane"];
		const caller = createUiStateRouter().createCaller({});

		const first = await caller.tabs.bootstrap();
		const second = await caller.tabs.bootstrap();

		expect(first).toEqual({
			state: currentState.tabsState,
			startupPeerPaneIds: ["peer-pane"],
		});
		expect(second.startupPeerPaneIds).toEqual([]);
		expect(first.state).not.toBe(currentState.tabsState);
	});

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
				repository: "example.com/acme/legacy",
				branch: "main",
				type: "worktree",
			},
			"canonical-workspace-1": {
				repository: "example.com/acme/workspace-1",
				branch: "main",
				type: "worktree",
			},
		});
		expect(currentState.sync.localToCanonical).toEqual({
			"workspace-1": "canonical-workspace-1",
		});
		expect(currentState.sync.perWorkspaceWrittenAt).toEqual({
			"canonical-workspace-1": {
				deviceId: "local-device",
				at: currentState.sync.lastWrittenAt,
			},
		});
		expect(getLocalWorkspaceIdentityResolutions).toHaveBeenCalledWith([
			"workspace-1",
		]);
	});

	test("invalidates a persisted mapping when batch identity becomes ambiguous", async () => {
		currentState.tabsState = {
			tabs: [
				{
					id: "tab-1",
					name: "Before",
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
					name: "Shell",
				},
			},
			activeTabIds: { "workspace-1": "tab-1" },
			focusedPaneIds: { "tab-1": "pane-1" },
			tabHistoryStacks: { "workspace-1": [] },
		};
		currentState.sync.localToCanonical = {
			"workspace-1": "persisted-canonical",
		};
		currentState.sync.perWorkspaceWrittenAt = {
			"persisted-canonical": { deviceId: "local-device", at: 1 },
		};
		getLocalWorkspaceIdentityResolutions.mockReturnValueOnce({
			"workspace-1": { status: "ambiguous" },
		});
		const caller = createUiStateRouter().createCaller({});

		await caller.tabs.set({
			...currentState.tabsState,
			tabs: [{ ...currentState.tabsState.tabs[0], name: "After" }],
		});

		expect(currentState.sync.localToCanonical["workspace-1"]).toBeUndefined();
		expect(
			currentState.sync.perWorkspaceWrittenAt["persisted-canonical"],
		).toBeUndefined();
	});

	test("overlays a queued local workspace delta onto a peer-committed snapshot", async () => {
		const peerBefore = tabsState("peer-workspace", "peer-before");
		const peerAfter = tabsState("peer-workspace", "peer-after");
		const localBefore = tabsState("local-workspace", "local-before");
		const localAfter = tabsState("local-workspace", "local-after");
		currentState.tabsState = combineTabs(peerAfter, localBefore);
		currentState.sync.lastWrittenAt = 100;
		currentState.sync.perWorkspaceWrittenAt = {
			"canonical-peer-workspace": { deviceId: "peer-device", at: 100 },
			"canonical-local-workspace": { deviceId: "local-device", at: 10 },
		};
		currentState.sync.workspaceMetadata = {
			"canonical-peer-workspace": {
				repository: "example.com/acme/peer-workspace",
				branch: "main",
				type: "worktree",
			},
			"canonical-local-workspace": {
				repository: "example.com/acme/local-workspace",
				branch: "main",
				type: "worktree",
			},
		};
		currentState.sync.localToCanonical = {
			"peer-workspace": "canonical-peer-workspace",
			"local-workspace": "canonical-local-workspace",
		};
		currentState.sync.paneClaudeSessions = {
			"peer-after-pane": "session-1",
			"local-before-pane": "session-1",
		};
		const staleRendererNext = combineTabs(peerBefore, localAfter);
		const caller = createUiStateRouter().createCaller({});

		await caller.tabs.set({
			state: staleRendererNext,
			changedWorkspaceIds: ["local-workspace"],
		});

		expect(currentState.tabsState.tabs.map(({ name }) => name).sort()).toEqual([
			"local-after",
			"peer-after",
		]);
		expect(
			currentState.sync.perWorkspaceWrittenAt["canonical-peer-workspace"],
		).toEqual({ deviceId: "peer-device", at: 100 });
		expect(
			currentState.sync.perWorkspaceWrittenAt["canonical-local-workspace"],
		).toEqual({
			deviceId: "local-device",
			at: currentState.sync.lastWrittenAt,
		});
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
