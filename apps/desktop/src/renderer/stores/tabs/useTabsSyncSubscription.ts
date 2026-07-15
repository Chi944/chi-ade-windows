import { toast } from "@superset/ui/sonner";
import type {
	RebasePeerUpdateInput,
	RebasePeerUpdateResult,
	TabsSuppressionToken,
} from "main/lib/app-state/sync-service";
import type { PeerAppStateEventMetadata } from "main/lib/app-state/watcher";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	acknowledgeTabsSuppressionToken,
	getTabsPersistenceStatus,
	type TabsPersistenceStatus,
	waitForTabsPersistenceIdle,
} from "renderer/lib/trpc-storage";
import { useTabsStore } from "./store";
import { markSyncedPane } from "./syncedPaneRegistry";

const MAX_STALE_REBASE_ATTEMPTS = 8;
const RETRYABLE_SYNC_ERROR =
	"A peer tab update could not be applied. Your local tabs were left unchanged.";

type CommittedPeerUpdate = Extract<
	RebasePeerUpdateResult,
	{ status: "committed" }
>;

export interface PeerUpdateConsumerDependencies {
	getLocalWorkspaceMappings: (
		canonicalWorkspaceIds: readonly string[],
	) => Promise<Record<string, string>>;
	rebasePeerUpdate: (
		input: RebasePeerUpdateInput,
	) => Promise<RebasePeerUpdateResult>;
	getPersistenceStatus?: () => TabsPersistenceStatus;
	waitForPersistenceIdle?: () => Promise<void>;
	acknowledgeSuppressionToken: (
		token: TabsSuppressionToken,
		tabsState: CommittedPeerUpdate["tabsState"],
	) => void;
	applyCommitted: (result: CommittedPeerUpdate) => void | Promise<void>;
	onRetryableError: (message: string, retry: () => void) => void;
	maxStaleAttempts?: number;
}

export interface PeerUpdateConsumer {
	enqueue: (event: PeerAppStateEventMetadata) => Promise<void>;
	flush: () => Promise<void>;
}

/**
 * Consume peer events strictly in subscription order. Main owns merge planning
 * and persistence; the renderer updates Zustand only after a committed reply.
 */
export function createPeerUpdateConsumer(
	dependencies: PeerUpdateConsumerDependencies,
): PeerUpdateConsumer {
	let tail: Promise<void> = Promise.resolve();
	const maxStaleAttempts = Math.max(
		1,
		dependencies.maxStaleAttempts ?? MAX_STALE_REBASE_ATTEMPTS,
	);
	const getPersistenceStatus =
		dependencies.getPersistenceStatus ??
		(() => ({ epoch: 0, pendingWrites: 0 }));
	const waitForPersistenceIdle =
		dependencies.waitForPersistenceIdle ?? (async () => undefined);

	const process = async (event: PeerAppStateEventMetadata): Promise<void> => {
		let baseRevision = event.baseRevision;
		let committedMappings: Record<string, string> | undefined;
		for (let attempt = 0; attempt < maxStaleAttempts; attempt += 1) {
			const persistenceBefore = getPersistenceStatus();
			let canonicalToLocal = committedMappings;
			if (!canonicalToLocal) {
				const availableMappings = await dependencies.getLocalWorkspaceMappings(
					event.canonicalWorkspaceIds,
				);
				canonicalToLocal = Object.fromEntries(
					event.canonicalWorkspaceIds.flatMap((canonical) => {
						const localWorkspaceId = availableMappings[canonical];
						return localWorkspaceId
							? [[canonical, localWorkspaceId] as const]
							: [];
					}),
				);
			}
			const result = await dependencies.rebasePeerUpdate({
				eventId: event.eventId,
				baseRevision,
				canonicalToLocal,
			});
			if (result.status === "stale") {
				baseRevision = result.revision;
				committedMappings = undefined;
				continue;
			}
			if (result.status === "rejected") {
				throw new Error(`Peer update rejected: ${result.reason}`);
			}
			const persistenceOnReply = getPersistenceStatus();
			await waitForPersistenceIdle();
			const persistenceAfterDrain = getPersistenceStatus();
			if (
				persistenceBefore.pendingWrites > 0 ||
				persistenceOnReply.pendingWrites > 0 ||
				persistenceAfterDrain.pendingWrites > 0 ||
				persistenceAfterDrain.epoch !== persistenceBefore.epoch
			) {
				baseRevision = result.revision;
				committedMappings = canonicalToLocal;
				continue;
			}
			dependencies.acknowledgeSuppressionToken(
				result.suppressionToken,
				result.tabsState,
			);
			await dependencies.applyCommitted(result);
			return;
		}
		throw new Error("Peer update stayed stale during rebase");
	};

	const enqueue = (event: PeerAppStateEventMetadata): Promise<void> => {
		const operation = tail.then(async () => {
			try {
				await process(event);
			} catch {
				dependencies.onRetryableError(RETRYABLE_SYNC_ERROR, () => {
					void enqueue(event);
				});
			}
		});
		tail = operation.catch(() => undefined);
		return operation;
	};

	return {
		enqueue,
		flush: () => tail,
	};
}

function applyCommittedPeerUpdate(result: CommittedPeerUpdate): void {
	const winningCanonicalIds = new Set(result.winningWorkspaces);
	const winningLocalWorkspaceIds = new Set(
		Object.entries(result.sync.localToCanonical).flatMap(
			([localWorkspaceId, canonical]) =>
				winningCanonicalIds.has(canonical) ? [localWorkspaceId] : [],
		),
	);
	const winningTabIds = new Set(
		result.tabsState.tabs
			.filter((tab) => winningLocalWorkspaceIds.has(tab.workspaceId))
			.map((tab) => tab.id),
	);
	for (const [paneId, pane] of Object.entries(result.tabsState.panes)) {
		if (winningTabIds.has(pane.tabId)) markSyncedPane(paneId);
	}

	const tabsState = result.tabsState;
	useTabsStore.setState({
		tabs: tabsState.tabs,
		panes: tabsState.panes,
		activeTabIds: tabsState.activeTabIds,
		focusedPaneIds: tabsState.focusedPaneIds,
		tabHistoryStacks: tabsState.tabHistoryStacks,
	});
}

const peerUpdateConsumer = createPeerUpdateConsumer({
	getLocalWorkspaceMappings: (canonicalWorkspaceIds) =>
		electronTrpcClient.sync.localWorkspaceMappings.query({
			canonicalWorkspaceIds: [...canonicalWorkspaceIds],
		}),
	rebasePeerUpdate: (input) =>
		electronTrpcClient.sync.rebasePeerUpdate.mutate(input),
	getPersistenceStatus: getTabsPersistenceStatus,
	waitForPersistenceIdle: waitForTabsPersistenceIdle,
	acknowledgeSuppressionToken: acknowledgeTabsSuppressionToken,
	applyCommitted: applyCommittedPeerUpdate,
	onRetryableError: (message, retry) => {
		toast.error("Peer tab sync needs attention", {
			description: message,
			action: { label: "Retry", onClick: retry },
		});
	},
});

/** Subscribe once at the authenticated app boundary. */
export function useTabsSyncSubscription(): void {
	electronTrpc.sync.appStateUpdates.useSubscription(undefined, {
		onData: (event) => {
			void peerUpdateConsumer.enqueue(event);
		},
		onError: () => {
			toast.error("Peer tab sync disconnected", {
				description: "ADE will retry when the sync subscription reconnects.",
			});
		},
	});
}
