import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createDefaultAppState } from "main/lib/app-state/schemas";
import type {
	RebasePeerUpdateInput,
	RebasePeerUpdateResult,
} from "main/lib/app-state/sync-service";
import type { PeerAppStateEventMetadata } from "main/lib/app-state/watcher";
import {
	preparePaneResumeInput,
	resetSyncedPaneRegistryForTests,
} from "./syncedPaneRegistry";

let subscriptionOnData:
	| ((event: PeerAppStateEventMetadata) => void)
	| undefined;
let subscriptionMappingsQuery = async (
	_canonicalWorkspaceIds: readonly string[],
): Promise<Record<string, string>> => ({ canonical: "local" });
let subscriptionRebaseMutation = async (
	_input: RebasePeerUpdateInput,
): Promise<RebasePeerUpdateResult> => committed("subscription", 1);
let subscriptionPersistenceStatus = { epoch: 0, pendingWrites: 0 };
let subscriptionWaitForPersistenceIdle = async (): Promise<void> => undefined;
let subscriptionAcknowledge = (
	_token: Extract<
		RebasePeerUpdateResult,
		{ status: "committed" }
	>["suppressionToken"],
): void => undefined;
let subscriptionStoreState: Record<string, unknown> | null = null;
let subscriptionStoreApplied: (() => void) | undefined;

mock.module("renderer/lib/electron-trpc", () => ({
	electronTrpc: {
		sync: {
			appStateUpdates: {
				useSubscription: (
					_input: unknown,
					options: { onData: (event: PeerAppStateEventMetadata) => void },
				) => {
					subscriptionOnData = options.onData;
				},
			},
		},
	},
}));
mock.module("renderer/lib/trpc-client", () => ({
	electronTrpcClient: {
		sync: {
			localWorkspaceMappings: {
				query: (input: { canonicalWorkspaceIds: string[] }) =>
					subscriptionMappingsQuery(input.canonicalWorkspaceIds),
			},
			rebasePeerUpdate: {
				mutate: (input: RebasePeerUpdateInput) =>
					subscriptionRebaseMutation(input),
			},
		},
	},
}));
mock.module("renderer/lib/trpc-storage", () => ({
	acknowledgeTabsSuppressionToken: (
		token: Extract<
			RebasePeerUpdateResult,
			{ status: "committed" }
		>["suppressionToken"],
	) => subscriptionAcknowledge(token),
	getTabsPersistenceStatus: () => subscriptionPersistenceStatus,
	setSkipNextTabsPersist: () => undefined,
	waitForTabsPersistenceIdle: () => subscriptionWaitForPersistenceIdle(),
}));
mock.module("./store", () => ({
	useTabsStore: {
		setState: (state: Record<string, unknown>) => {
			subscriptionStoreState = state;
			subscriptionStoreApplied?.();
		},
		getState: () => ({}),
	},
}));
mock.module("@superset/ui/sonner", () => ({
	toast: { error: () => undefined },
}));

const { createPeerUpdateConsumer, useTabsSyncSubscription } = await import(
	"./useTabsSyncSubscription"
);

beforeEach(() => {
	resetSyncedPaneRegistryForTests();
	subscriptionOnData = undefined;
	subscriptionMappingsQuery = async () => ({ canonical: "local" });
	subscriptionRebaseMutation = async () => committed("subscription", 1);
	subscriptionPersistenceStatus = { epoch: 0, pendingWrites: 0 };
	subscriptionWaitForPersistenceIdle = async () => undefined;
	subscriptionAcknowledge = () => undefined;
	subscriptionStoreState = null;
	subscriptionStoreApplied = undefined;
});

function event(eventId: string, baseRevision = 0): PeerAppStateEventMetadata {
	return {
		eventId,
		baseRevision,
		writerDeviceId: "peer-device",
		lastWrittenAt: 10,
		canonicalWorkspaceIds: ["canonical"],
	};
}

function committed(
	label: string,
	revision: number,
): Extract<RebasePeerUpdateResult, { status: "committed" }> {
	const state = createDefaultAppState("peer-device");
	state.tabsState.tabs = [];
	return {
		status: "committed",
		revision,
		tabsState: {
			...state.tabsState,
			activeTabIds: { label },
		},
		sync: state.sync,
		warnings: [],
		winningWorkspaces: [],
		importedPeerPaneIds: [],
		suppressionToken: {
			token: `token-${label}`,
			revision,
			tabsHash: `hash-${label}`,
			expiresAt: 50_000,
		},
	};
}

describe("sequential peer update consumer", () => {
	test("passes only mappings requested by the peer event", async () => {
		const inputs: Array<Record<string, string>> = [];
		const getLocalWorkspaceMappings = mock(async () => ({
			canonical: "local",
			unrelated: "other-local",
		}));
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings,
			rebasePeerUpdate: async (input) => {
				inputs.push(input.canonicalToLocal);
				return committed("mapped", 1);
			},
			acknowledgeSuppressionToken: () => undefined,
			applyCommitted: () => undefined,
			onRetryableError: () => undefined,
		});

		await consumer.enqueue(event("event-1"));

		expect(getLocalWorkspaceMappings).toHaveBeenCalledWith(["canonical"]);
		expect(inputs).toEqual([{ canonical: "local" }]);
	});

	test("applies a 1,001-id event once without exposing a futile retry", async () => {
		const canonicalWorkspaceIds = Array.from(
			{ length: 1_001 },
			(_, index) => `canonical-${index}`,
		);
		const rebase = mock(async () => committed("large", 1));
		const applied = mock(async () => undefined);
		const retryableError = mock(() => undefined);
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({}),
			rebasePeerUpdate: rebase,
			acknowledgeSuppressionToken: () => undefined,
			applyCommitted: applied,
			onRetryableError: retryableError,
		});

		await consumer.enqueue({
			...event("large-event"),
			canonicalWorkspaceIds,
		});

		expect(rebase).toHaveBeenCalledTimes(1);
		expect(rebase).toHaveBeenCalledWith({
			eventId: "large-event",
			baseRevision: 0,
			canonicalToLocal: {},
		});
		expect(applied).toHaveBeenCalledTimes(1);
		expect(retryableError).not.toHaveBeenCalled();
	});

	test("never overlaps updates, so a slow older event lands before a newer event", async () => {
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let active = 0;
		let maxActive = 0;
		const calls: string[] = [];
		const applied: string[] = [];
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({ canonical: "local" }),
			rebasePeerUpdate: async (input) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				calls.push(input.eventId);
				if (input.eventId === "older") {
					markFirstStarted?.();
					await firstGate;
				}
				active -= 1;
				return committed(input.eventId, calls.length);
			},
			acknowledgeSuppressionToken: () => undefined,
			applyCommitted: async (result) => {
				applied.push(result.tabsState.activeTabIds.label ?? "missing");
			},
			onRetryableError: () => undefined,
		});

		const older = consumer.enqueue(event("older"));
		const newer = consumer.enqueue(event("newer"));
		await firstStarted;

		expect(calls).toEqual(["older"]);
		releaseFirst?.();
		await Promise.all([older, newer]);
		expect(calls).toEqual(["older", "newer"]);
		expect(applied).toEqual(["older", "newer"]);
		expect(maxActive).toBe(1);
	});

	test("replans a stale event at the coordinator's returned revision", async () => {
		const revisions: number[] = [];
		const applied = mock(async () => undefined);
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({ canonical: "local" }),
			rebasePeerUpdate: async (input) => {
				revisions.push(input.baseRevision);
				return revisions.length === 1
					? { status: "stale", revision: 7 }
					: committed("replanned", 8);
			},
			acknowledgeSuppressionToken: () => undefined,
			applyCommitted: applied,
			onRetryableError: () => undefined,
		});

		await consumer.enqueue(event("event-1", 2));

		expect(revisions).toEqual([2, 7]);
		expect(applied).toHaveBeenCalledTimes(1);
	});

	test("drains a local write started during peer commit and replays before applying", async () => {
		let epoch = 0;
		let pendingWrites = 0;
		let releasePeer: (() => void) | undefined;
		let markPeerStarted: (() => void) | undefined;
		let releaseLocal: (() => void) | undefined;
		const peerGate = new Promise<void>((resolve) => {
			releasePeer = resolve;
		});
		const peerStarted = new Promise<void>((resolve) => {
			markPeerStarted = resolve;
		});
		const localGate = new Promise<void>((resolve) => {
			releaseLocal = resolve;
		});
		const peerOnly = committed("peer", 1);
		peerOnly.tabsState.activeTabIds = { peer: "peer-tab" };
		const currentMain = committed("current", 2);
		currentMain.tabsState.activeTabIds = {
			peer: "peer-tab",
			local: "local-tab",
		};
		const rebase = mock(async (_input: RebasePeerUpdateInput) => {
			if (rebase.mock.calls.length === 1) {
				markPeerStarted?.();
				await peerGate;
				return peerOnly;
			}
			return currentMain;
		});
		const acknowledged: string[] = [];
		const applied: RebasePeerUpdateResult[] = [];
		const retryableError = mock(() => undefined);
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({ canonical: "local" }),
			rebasePeerUpdate: rebase,
			getPersistenceStatus: () => ({ epoch, pendingWrites }),
			waitForPersistenceIdle: async () => {
				while (pendingWrites > 0) await localGate;
			},
			acknowledgeSuppressionToken: (token) => {
				acknowledged.push(token.token);
			},
			applyCommitted: (result) => {
				applied.push(result);
			},
			onRetryableError: retryableError,
		} as Parameters<typeof createPeerUpdateConsumer>[0]);

		const operation = consumer.enqueue(event("event-race"));
		await peerStarted;
		epoch += 1;
		pendingWrites = 1;
		releasePeer?.();
		await Promise.resolve();
		pendingWrites = 0;
		releaseLocal?.();
		await operation;

		expect(rebase).toHaveBeenCalledTimes(2);
		expect(rebase.mock.calls[1]?.[0]).toMatchObject({
			eventId: "event-race",
			baseRevision: 1,
		});
		expect(acknowledged).toEqual(["token-current"]);
		expect(applied).toHaveLength(1);
		expect(applied[0]).toMatchObject(currentMain);
		expect(retryableError).not.toHaveBeenCalled();
	});

	test("preserves peer resume provenance through a local write drain and processed replay", async () => {
		let releasePeer: (() => void) | undefined;
		let markPeerStarted: (() => void) | undefined;
		let releaseLocal: (() => void) | undefined;
		const peerGate = new Promise<void>((resolve) => {
			releasePeer = resolve;
		});
		const peerStarted = new Promise<void>((resolve) => {
			markPeerStarted = resolve;
		});
		const localGate = new Promise<void>((resolve) => {
			releaseLocal = resolve;
		});
		const applied = new Promise<void>((resolve) => {
			subscriptionStoreApplied = resolve;
		});
		const peerOnly = committed("peer", 1);
		peerOnly.tabsState.tabs = [
			{
				id: "peer-tab",
				name: "peer",
				workspaceId: "local-peer-workspace",
				createdAt: 1,
				layout: "peer-pane",
			},
		];
		peerOnly.tabsState.panes = {
			"peer-pane": {
				id: "peer-pane",
				tabId: "peer-tab",
				type: "terminal",
				name: "Claude",
				agentRuntime: "claude",
			},
		};
		peerOnly.tabsState.activeTabIds = {
			"local-peer-workspace": "peer-tab",
		};
		peerOnly.tabsState.focusedPaneIds = { "peer-tab": "peer-pane" };
		peerOnly.tabsState.tabHistoryStacks = { "local-peer-workspace": [] };
		peerOnly.winningWorkspaces = ["canonical"];
		peerOnly.importedPeerPaneIds = ["peer-pane"];
		peerOnly.sync.localToCanonical["local-peer-workspace"] = "canonical";

		const currentMain = structuredClone(peerOnly);
		currentMain.revision = 2;
		currentMain.winningWorkspaces = [];
		currentMain.suppressionToken = {
			...currentMain.suppressionToken,
			token: "token-current",
			revision: 2,
		};
		currentMain.tabsState.tabs.push({
			id: "local-tab",
			name: "local",
			workspaceId: "local-workspace",
			createdAt: 2,
			layout: "local-pane",
		});
		currentMain.tabsState.panes["local-pane"] = {
			id: "local-pane",
			tabId: "local-tab",
			type: "terminal",
			name: "Local",
		};
		currentMain.tabsState.activeTabIds["local-workspace"] = "local-tab";
		currentMain.tabsState.focusedPaneIds["local-tab"] = "local-pane";
		currentMain.tabsState.tabHistoryStacks["local-workspace"] = [];

		const inputs: RebasePeerUpdateInput[] = [];
		subscriptionRebaseMutation = async (input) => {
			inputs.push(input);
			if (inputs.length === 1) {
				markPeerStarted?.();
				await peerGate;
				return peerOnly;
			}
			return currentMain;
		};
		subscriptionWaitForPersistenceIdle = async () => {
			while (subscriptionPersistenceStatus.pendingWrites > 0) await localGate;
		};
		const acknowledged: string[] = [];
		subscriptionAcknowledge = (token) => {
			acknowledged.push(token.token);
		};

		useTabsSyncSubscription();
		subscriptionOnData?.(event("event-provenance"));
		await peerStarted;
		subscriptionPersistenceStatus = { epoch: 1, pendingWrites: 1 };
		releasePeer?.();
		await Promise.resolve();
		subscriptionPersistenceStatus = { epoch: 1, pendingWrites: 0 };
		releaseLocal?.();
		await applied;

		expect(inputs).toHaveLength(2);
		expect(inputs[1]).toMatchObject({
			eventId: "event-provenance",
			baseRevision: 1,
		});
		expect(acknowledged).toEqual(["token-current"]);
		expect(
			(subscriptionStoreState?.tabs as Array<{ name: string }>).map(
				(tab) => tab.name,
			),
		).toEqual(["peer", "local"]);
		const resumeInput = preparePaneResumeInput(
			"peer-pane",
			"claude --resume 123e4567-e89b-42d3-a456-426614174000\r\n",
		);
		expect(resumeInput).not.toMatch(/[\r\n]/);
	});

	test("does not apply or echo when acknowledgement fails and exposes a retry", async () => {
		let shouldFail = true;
		let retry: (() => void) | undefined;
		const applied = mock(async () => undefined);
		const rebase = mock(async () => committed("retryable", 1));
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({ canonical: "local" }),
			rebasePeerUpdate: rebase,
			acknowledgeSuppressionToken: () => {
				if (shouldFail) throw new Error("acknowledgement unavailable");
			},
			applyCommitted: applied,
			onRetryableError: (_message, retryOperation) => {
				retry = retryOperation;
			},
		});

		await consumer.enqueue(event("event-1"));
		expect(applied).not.toHaveBeenCalled();
		expect(retry).toBeFunction();

		shouldFail = false;
		retry?.();
		await consumer.flush();
		expect(rebase).toHaveBeenCalledTimes(2);
		expect(applied).toHaveBeenCalledTimes(1);
	});

	test("continues with a later event after a rejected update", async () => {
		const applied: string[] = [];
		const errors: string[] = [];
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({ canonical: "local" }),
			rebasePeerUpdate: async (input) =>
				input.eventId === "rejected"
					? { status: "rejected", reason: "invalid-workspace-mapping" }
					: committed(input.eventId, 1),
			acknowledgeSuppressionToken: () => undefined,
			applyCommitted: (result) => {
				applied.push(result.tabsState.activeTabIds.label ?? "missing");
			},
			onRetryableError: (message) => errors.push(message),
		});

		await consumer.enqueue(event("rejected"));
		await consumer.enqueue(event("later"));

		expect(errors).toHaveLength(1);
		expect(applied).toEqual(["later"]);
	});

	test("registers suppression and applies the exact snapshot without yielding", async () => {
		let applied = false;
		let overlappingPersistenceWon = false;
		const consumer = createPeerUpdateConsumer({
			getLocalWorkspaceMappings: async () => ({ canonical: "local" }),
			rebasePeerUpdate: async () => committed("no-winner-same-hash", 1),
			acknowledgeSuppressionToken: () => {
				queueMicrotask(() => {
					if (!applied) overlappingPersistenceWon = true;
				});
			},
			applyCommitted: () => {
				applied = true;
			},
			onRetryableError: () => undefined,
		});

		await consumer.enqueue(event("event-1"));

		expect(applied).toBe(true);
		expect(overlappingPersistenceWon).toBe(false);
	});
});
