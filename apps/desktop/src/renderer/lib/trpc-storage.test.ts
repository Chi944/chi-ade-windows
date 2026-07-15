import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createDefaultAppState } from "main/lib/app-state/schemas";
import { hashTabsState } from "shared/tabs-sync";

let tabsSetError: Error | null = null;
let tabsBootstrap: {
	state: ReturnType<typeof createDefaultAppState>["tabsState"];
	startupPeerPaneIds: string[];
} | null = null;
const tabsSet = mock(async () => {
	if (tabsSetError) throw tabsSetError;
	return { success: true };
});
mock.module("renderer/lib/trpc-client", () => ({
	electronTrpcClient: {
		uiState: {
			tabs: {
				bootstrap: { query: async () => tabsBootstrap },
				get: { query: async () => null },
				set: { mutate: tabsSet },
			},
			theme: {
				get: { query: async () => null },
				set: { mutate: async () => undefined },
			},
			hotkeys: {
				get: { query: async () => null },
				set: { mutate: async () => undefined },
			},
		},
		settings: {
			getSelectedRingtoneId: { query: async () => null },
			setSelectedRingtoneId: { mutate: async () => undefined },
		},
	},
}));

const {
	acknowledgeTabsSuppressionToken,
	createTabsSuppressionTokenRegistry,
	getTabsPersistenceStatus,
	partializeTabsStoreState,
	resetTabsPersistenceForTests,
	resetTabsSuppressionTokensForTests,
	trpcTabsStorage,
	waitForTabsPersistenceIdle,
} = await import("./trpc-storage");
const { consumeSyncedPane, resetSyncedPaneRegistryForTests } = await import(
	"../stores/tabs/syncedPaneRegistry"
);

function tabs(label: string, workspaceId = "workspace") {
	const state = createDefaultAppState("device").tabsState;
	state.tabs = [
		{
			id: `${label}-tab`,
			name: label,
			workspaceId,
			createdAt: 1,
			layout: `${label}-pane`,
		},
	];
	state.panes = {
		[`${label}-pane`]: {
			id: `${label}-pane`,
			tabId: `${label}-tab`,
			type: "terminal",
			name: label,
		},
	};
	state.activeTabIds = { [workspaceId]: `${label}-tab` };
	state.focusedPaneIds = { [`${label}-tab`]: `${label}-pane` };
	state.tabHistoryStacks = { [workspaceId]: [] };
	return state;
}

function combineTabs(...states: ReturnType<typeof tabs>[]) {
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

function tokenFor(
	value: ReturnType<typeof tabs>,
	token: string,
	revision: number,
	expiresAt = 10_000,
) {
	return {
		token,
		revision,
		tabsHash: hashTabsState(value),
		expiresAt,
	};
}

beforeEach(() => {
	tabsSet.mockClear();
	tabsSetError = null;
	tabsBootstrap = null;
	resetTabsSuppressionTokensForTests();
	resetTabsPersistenceForTests();
	resetSyncedPaneRegistryForTests();
	const sidecars = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => sidecars.get(key) ?? null,
			setItem: (key: string, value: string) => sidecars.set(key, value),
			removeItem: (key: string) => sidecars.delete(key),
		},
	});
});

describe("tabs suppression tokens", () => {
	test("marks startup peer panes before exposing hydrated tabs", async () => {
		const peer = tabs("peer");
		tabsBootstrap = {
			state: peer,
			startupPeerPaneIds: ["peer-pane"],
		};

		const hydrated = await trpcTabsStorage?.getItem("tabs-storage");

		expect(hydrated?.state).toEqual(peer);
		expect(consumeSyncedPane("peer-pane")).toBe(true);
		expect(consumeSyncedPane("peer-pane")).toBe(false);
	});

	test("a different local persistence cannot consume a peer token", () => {
		const peer = tabs("peer");
		const local = tabs("local");
		const registry = createTabsSuppressionTokenRegistry({ now: () => 1_000 });
		registry.acknowledge(tokenFor(peer, "peer-token", 1), peer);

		expect(registry.consume(local)).toBeNull();
		expect(registry.consume(peer)?.token).toBe("peer-token");
		expect(registry.consume(peer)).toBeNull();
	});

	test("matches multiple peer revisions exactly once and in revision order", () => {
		const peer = tabs("peer");
		const registry = createTabsSuppressionTokenRegistry({ now: () => 1_000 });
		registry.acknowledge(tokenFor(peer, "second", 2), peer);
		registry.acknowledge(tokenFor(peer, "first", 1), peer);

		expect(registry.consume(peer)?.revision).toBe(1);
		expect(registry.consume(peer)?.revision).toBe(2);
		expect(registry.consume(peer)).toBeNull();
	});

	test("is bounded, expiring, and rejects a mismatched acknowledgement", () => {
		let now = 1_000;
		const registry = createTabsSuppressionTokenRegistry({
			now: () => now,
			capacity: 2,
		});
		const peer = tabs("peer");
		registry.acknowledge(tokenFor(peer, "one", 1), peer);
		registry.acknowledge(tokenFor(peer, "two", 2), peer);
		registry.acknowledge(tokenFor(peer, "three", 3), peer);
		expect(registry.size).toBe(2);

		expect(() =>
			registry.acknowledge(
				{ ...tokenFor(peer, "bad", 4), tabsHash: "wrong" },
				peer,
			),
		).toThrow(/hash/i);
		now = 10_001;
		expect(registry.consume(peer)).toBeNull();
		expect(registry.size).toBe(0);
	});

	test("the tRPC adapter suppresses only the exact acknowledged snapshot", async () => {
		const peer = tabs("peer");
		const local = tabs("local");
		acknowledgeTabsSuppressionToken(
			tokenFor(peer, "peer", 1, Date.now() + 30_000),
			peer,
		);

		const beforeSuppression = getTabsPersistenceStatus();
		await trpcTabsStorage?.setItem("tabs-storage", {
			state: peer,
			version: 8,
		});
		expect(tabsSet).not.toHaveBeenCalled();
		expect(getTabsPersistenceStatus()).toEqual(beforeSuppression);

		await trpcTabsStorage?.setItem("tabs-storage", {
			state: local,
			version: 8,
		});
		expect(tabsSet).toHaveBeenCalledTimes(1);
		expect(tabsSet).toHaveBeenCalledWith({
			state: local,
			changedWorkspaceIds: ["workspace"],
		});
	});

	test("does not advance the persisted version when the main write rejects", async () => {
		tabsSetError = new Error("main write failed");

		await expect(
			trpcTabsStorage?.setItem("tabs-storage", {
				state: tabs("local"),
				version: 8,
			}),
		).rejects.toThrow("main write failed");
		expect(localStorage.getItem("tabs-storage:version")).toBeNull();
	});

	test("tracks the epoch and drains an in-flight main tabs write", async () => {
		let releaseWrite: (() => void) | undefined;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		tabsSet.mockImplementationOnce(async () => {
			await writeGate;
			return { success: true };
		});
		const before = getTabsPersistenceStatus();

		const write = trpcTabsStorage?.setItem("tabs-storage", {
			state: tabs("local"),
			version: 8,
		});
		await Promise.resolve();

		expect(getTabsPersistenceStatus()).toEqual({
			epoch: before.epoch + 1,
			pendingWrites: 1,
		});
		let drained = false;
		const drain = waitForTabsPersistenceIdle().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		releaseWrite?.();
		await Promise.all([write, drain]);
		expect(getTabsPersistenceStatus()).toEqual({
			epoch: before.epoch + 1,
			pendingWrites: 0,
		});
	});

	test("persists only the workspace delta from the last renderer snapshot", async () => {
		const peerBefore = tabs("peer-before", "peer-workspace");
		const localBefore = tabs("local-before", "local-workspace");
		const localAfter = tabs("local-after", "local-workspace");
		const baseline = combineTabs(peerBefore, localBefore);
		const next = combineTabs(peerBefore, localAfter);
		tabsBootstrap = { state: baseline, startupPeerPaneIds: [] };
		await trpcTabsStorage?.getItem("tabs-storage");

		await trpcTabsStorage?.setItem("tabs-storage", {
			state: next,
			version: 8,
		});

		expect(tabsSet).toHaveBeenCalledWith({
			state: next,
			changedWorkspaceIds: ["local-workspace"],
		});
	});
});

describe("tabs persistence partialization", () => {
	test("keeps only durable tabs fields and excludes the closed-tab undo stack", () => {
		const durable = tabs("durable");
		const partial = partializeTabsStoreState({
			...durable,
			closedTabsStack: [{ privateUndoState: true }],
			addTab: () => undefined,
		} as never);

		expect(partial).toEqual(durable);
		expect(partial).not.toHaveProperty("closedTabsStack");
		expect(partial).not.toHaveProperty("addTab");
	});

	test("the tabs store installs the explicit durable-state partializer", async () => {
		const storeSource = await Bun.file(
			new URL("../stores/tabs/store.ts", import.meta.url),
		).text();

		expect(storeSource).toContain(
			"partialize: (state: TabsStore) => partializeTabsStoreState(state)",
		);
	});
});
