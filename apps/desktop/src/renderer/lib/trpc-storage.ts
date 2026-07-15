import type { TabsState } from "main/lib/app-state/schemas";
import type { TabsSuppressionToken } from "main/lib/app-state/sync-service";
import type { HotkeysState } from "shared/hotkeys";
import { changedTabsWorkspaceIds, hashTabsState } from "shared/tabs-sync";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { markSyncedPane } from "../stores/tabs/syncedPaneRegistry";
import { electronTrpcClient } from "./trpc-client";

/**
 * Flag to skip the next hotkeys persist operation.
 * Used when syncing from remote to avoid echo writes.
 */
let skipNextHotkeysPersist = false;

export function setSkipNextHotkeysPersist(skip: boolean): void {
	skipNextHotkeysPersist = skip;
}

const DEFAULT_SUPPRESSION_CAPACITY = 64;

export interface TabsSuppressionTokenRegistry {
	acknowledge: (token: TabsSuppressionToken, tabsState: TabsState) => void;
	consume: (tabsState: TabsState) => TabsSuppressionToken | null;
	readonly size: number;
}

export function createTabsSuppressionTokenRegistry(
	options: { now?: () => number; capacity?: number } = {},
): TabsSuppressionTokenRegistry {
	const now = options.now ?? Date.now;
	const capacity = Math.max(
		1,
		options.capacity ?? DEFAULT_SUPPRESSION_CAPACITY,
	);
	const tokens = new Map<string, TabsSuppressionToken>();
	const purgeExpired = () => {
		const currentTime = now();
		for (const [token, value] of tokens) {
			if (value.expiresAt <= currentTime) tokens.delete(token);
		}
	};

	return {
		acknowledge(token, tabsState) {
			purgeExpired();
			if (!token.token || token.expiresAt <= now()) {
				throw new Error("Tabs suppression token is empty or expired.");
			}
			if (token.tabsHash !== hashTabsState(tabsState)) {
				throw new Error(
					"Tabs suppression token hash does not match the snapshot.",
				);
			}
			const existing = tokens.get(token.token);
			if (existing) {
				if (
					existing.revision !== token.revision ||
					existing.tabsHash !== token.tabsHash ||
					existing.expiresAt !== token.expiresAt
				) {
					throw new Error(
						"Tabs suppression token conflicts with an existing token.",
					);
				}
				return;
			}
			tokens.set(token.token, { ...token });
			while (tokens.size > capacity) {
				const oldest = tokens.keys().next().value;
				if (typeof oldest !== "string") break;
				tokens.delete(oldest);
			}
		},
		consume(tabsState) {
			purgeExpired();
			const tabsHash = hashTabsState(tabsState);
			const match = [...tokens.values()]
				.filter((token) => token.tabsHash === tabsHash)
				.sort(
					(left, right) =>
						left.revision - right.revision ||
						left.token.localeCompare(right.token),
				)[0];
			if (!match) return null;
			tokens.delete(match.token);
			return { ...match };
		},
		get size() {
			purgeExpired();
			return tokens.size;
		},
	};
}

let tabsSuppressionTokens = createTabsSuppressionTokenRegistry();

export interface TabsPersistenceStatus {
	epoch: number;
	pendingWrites: number;
}

let tabsPersistenceEpoch = 0;
const pendingTabsPersistenceWrites = new Set<Promise<unknown>>();
let tabsPersistenceTail: Promise<void> = Promise.resolve();
let lastRendererTabsState: TabsState | null = null;

function trackTabsPersistenceWrite(
	operation: () => Promise<unknown>,
): Promise<unknown> {
	tabsPersistenceEpoch += 1;
	let write: Promise<unknown>;
	try {
		write = operation();
	} catch (error) {
		return Promise.reject(error);
	}
	pendingTabsPersistenceWrites.add(write);
	const clear = () => pendingTabsPersistenceWrites.delete(write);
	void write.then(clear, clear);
	return write;
}

export function getTabsPersistenceStatus(): TabsPersistenceStatus {
	return {
		epoch: tabsPersistenceEpoch,
		pendingWrites: pendingTabsPersistenceWrites.size,
	};
}

export async function waitForTabsPersistenceIdle(): Promise<void> {
	while (pendingTabsPersistenceWrites.size > 0) {
		await Promise.allSettled([...pendingTabsPersistenceWrites]);
	}
}

/** @internal Test seam. */
export function resetTabsPersistenceForTests(): void {
	tabsPersistenceEpoch = 0;
	pendingTabsPersistenceWrites.clear();
	tabsPersistenceTail = Promise.resolve();
	lastRendererTabsState = null;
}

export function acknowledgeTabsSuppressionToken(
	token: TabsSuppressionToken,
	tabsState: TabsState,
): void {
	tabsSuppressionTokens.acknowledge(token, tabsState);
}

/** @internal Test seam. */
export function resetTabsSuppressionTokensForTests(): void {
	tabsSuppressionTokens = createTabsSuppressionTokenRegistry();
}

export function partializeTabsStoreState(state: {
	tabs: TabsState["tabs"];
	panes: TabsState["panes"];
	activeTabIds: TabsState["activeTabIds"];
	focusedPaneIds: TabsState["focusedPaneIds"];
	tabHistoryStacks: TabsState["tabHistoryStacks"];
}): TabsState {
	return {
		tabs: state.tabs,
		panes: state.panes,
		activeTabIds: state.activeTabIds,
		focusedPaneIds: state.focusedPaneIds,
		tabHistoryStacks: state.tabHistoryStacks,
	};
}

/**
 * Creates a Zustand storage adapter that uses tRPC for persistence.
 * This ensures all state is persisted through the centralized appState lowdb instance.
 */

interface TrpcStorageConfig {
	get: () => Promise<unknown>;
	set: (input: unknown) => Promise<unknown>;
}

function createTrpcStorageAdapter(config: TrpcStorageConfig): StateStorage {
	return {
		getItem: async (name: string): Promise<string | null> => {
			try {
				const state = await config.get();
				if (!state) return null;
				// Version is stored in localStorage as a sidecar since the
				// tRPC backend validates bare state and rejects envelopes.
				const version = Number.parseInt(
					localStorage.getItem(`${name}:version`) ?? "0",
					10,
				);
				return JSON.stringify({ state, version });
			} catch (error) {
				console.error("[trpc-storage] Failed to get state:", error);
				return null;
			}
		},
		setItem: async (name: string, value: string): Promise<void> => {
			try {
				const parsed = JSON.parse(value) as {
					state: unknown;
					version: number;
				};
				await config.set(parsed.state);
				// Advance the sidecar only after the durable write/ack succeeds.
				localStorage.setItem(`${name}:version`, String(parsed.version));
			} catch (error) {
				console.error("[trpc-storage] Failed to set state:", error);
				throw error;
			}
		},
		removeItem: async (_name: string): Promise<void> => {
			// Reset to empty/default state is handled by the store itself
			// No-op here as we don't want to delete persisted state
		},
	};
}

/**
 * Zustand storage adapter for tabs state using tRPC
 */
export const trpcTabsStorage = createJSONStorage(() =>
	createTrpcStorageAdapter({
		get: async () => {
			const bootstrap = await electronTrpcClient.uiState.tabs.bootstrap.query();
			for (const paneId of bootstrap.startupPeerPaneIds) {
				markSyncedPane(paneId);
			}
			lastRendererTabsState = structuredClone(bootstrap.state);
			return bootstrap.state;
		},
		set: (input) => {
			const persisted = partializeTabsStoreState(
				input as Parameters<typeof partializeTabsStoreState>[0],
			);
			if (tabsSuppressionTokens.consume(persisted)) {
				lastRendererTabsState = structuredClone(persisted);
				return Promise.resolve();
			}
			return trackTabsPersistenceWrite(() => {
				const operation = tabsPersistenceTail.then(async () => {
					const previous = lastRendererTabsState;
					const payload = previous
						? {
								state: persisted,
								changedWorkspaceIds: changedTabsWorkspaceIds(
									previous,
									persisted,
								),
							}
						: persisted;
					// biome-ignore lint/suspicious/noExplicitAny: Zustand persist passes unknown, tRPC expects typed input
					await electronTrpcClient.uiState.tabs.set.mutate(payload as any);
					lastRendererTabsState = structuredClone(persisted);
				});
				tabsPersistenceTail = operation
					.then(() => undefined)
					.catch(() => undefined);
				return operation;
			});
		},
	}),
);

/**
 * Zustand storage adapter for theme state using tRPC
 */
export const trpcThemeStorage = createJSONStorage(() =>
	createTrpcStorageAdapter({
		get: () => electronTrpcClient.uiState.theme.get.query(),
		// biome-ignore lint/suspicious/noExplicitAny: Zustand persist passes unknown, tRPC expects typed input
		set: (input) => electronTrpcClient.uiState.theme.set.mutate(input as any),
	}),
);

/**
 * Zustand storage adapter for hotkeys state using tRPC
 */
export const trpcHotkeysStorage = createJSONStorage(() =>
	createTrpcStorageAdapter({
		get: async () => {
			const hotkeysState = await electronTrpcClient.uiState.hotkeys.get.query();
			return { hotkeysState };
		},
		set: (input) => {
			// Skip persistence when syncing from remote to avoid echo writes
			if (skipNextHotkeysPersist) {
				skipNextHotkeysPersist = false;
				return Promise.resolve();
			}
			const state = input as { hotkeysState: HotkeysState };
			return electronTrpcClient.uiState.hotkeys.set.mutate(state.hotkeysState);
		},
	}),
);

/**
 * Zustand storage adapter for ringtone state using tRPC.
 * Only the selectedRingtoneId is persisted.
 */
export const trpcRingtoneStorage = createJSONStorage(() =>
	createTrpcStorageAdapter({
		get: async () => {
			const ringtoneId =
				await electronTrpcClient.settings.getSelectedRingtoneId.query();
			return { selectedRingtoneId: ringtoneId };
		},
		set: async (input) => {
			const state = input as { selectedRingtoneId: string };
			await electronTrpcClient.settings.setSelectedRingtoneId.mutate({
				ringtoneId: state.selectedRingtoneId,
			});
		},
	}),
);
