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
	partializeTabsStoreState,
	resetTabsSuppressionTokensForTests,
	trpcTabsStorage,
} = await import("./trpc-storage");
const { consumeSyncedPane, resetSyncedPaneRegistryForTests } = await import(
	"../stores/tabs/syncedPaneRegistry"
);

function tabs(label: string) {
	const state = createDefaultAppState("device").tabsState;
	state.tabs = [
		{
			id: `${label}-tab`,
			name: label,
			workspaceId: "workspace",
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
	state.activeTabIds = { workspace: `${label}-tab` };
	state.focusedPaneIds = { [`${label}-tab`]: `${label}-pane` };
	state.tabHistoryStacks = { workspace: [] };
	return state;
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

		await trpcTabsStorage?.setItem("tabs-storage", {
			state: peer,
			version: 8,
		});
		expect(tabsSet).not.toHaveBeenCalled();

		await trpcTabsStorage?.setItem("tabs-storage", {
			state: local,
			version: 8,
		});
		expect(tabsSet).toHaveBeenCalledTimes(1);
		expect(tabsSet).toHaveBeenCalledWith(local);
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
