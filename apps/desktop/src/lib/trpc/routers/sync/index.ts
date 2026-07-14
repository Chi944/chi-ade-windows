/**
 * Cross-Mac sync subscription router.
 *
 * Pushes peer-originated `app-state.json` updates to the renderer so
 * `useTabsStore` (Agent B) can merge them in with per-workspace
 * last-writer-wins semantics.
 *
 * Mirrors the `terminal.stream` observable pattern.
 */

import { remoteWorkspaceBindings } from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import type {
	AppStateSyncEnvelope,
	TabsState,
} from "main/lib/app-state/schemas";
import { appStateWatcher } from "main/lib/app-state/watcher";
import { localDb } from "main/lib/local-db";
import { getCanonicalForLocalWorkspaceId } from "main/lib/sync/workspace-identity";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import { publicProcedure, router } from "../..";

export interface AppStateUpdatePayload {
	tabsState: TabsState;
	sync: AppStateSyncEnvelope;
}

function getPeerRemoteWorkspaceIds(
	sync: AppStateSyncEnvelope,
): ReadonlySet<string> {
	const localRemoteWorkspaceIds = localDb
		.select({ workspaceId: remoteWorkspaceBindings.workspaceId })
		.from(remoteWorkspaceBindings)
		.all()
		.map(({ workspaceId }) => workspaceId);
	const remoteCanonicalIds = new Set(
		localRemoteWorkspaceIds.flatMap((workspaceId) => {
			const identity = getCanonicalForLocalWorkspaceId(workspaceId);
			return identity ? [identity.canonical] : [];
		}),
	);
	const peerRemoteWorkspaceIds = new Set(localRemoteWorkspaceIds);
	for (const [peerWorkspaceId, canonicalId] of Object.entries(
		sync.localToCanonical ?? {},
	)) {
		if (remoteCanonicalIds.has(canonicalId)) {
			peerRemoteWorkspaceIds.add(peerWorkspaceId);
		}
	}
	return peerRemoteWorkspaceIds;
}

export const createSyncRouter = () => {
	return router({
		/**
		 * Subscribe to peer-originated changes to `~/.ade/app-state.json`.
		 * Emits the parsed `tabsState` + `sync` envelope each time the
		 * file is rewritten by another Mac (detected via `sync.deviceId`
		 * differing from the local deviceId).
		 */
		appStateUpdates: publicProcedure.subscription(() => {
			return observable<AppStateUpdatePayload>((emit) => {
				const onUpdate = (payload: {
					state: { tabsState: TabsState; sync?: AppStateSyncEnvelope };
				}) => {
					const sync = payload.state.sync;
					if (!sync) return;
					emit.next({
						tabsState: sanitizeSubscriptionProfilesForPersistence({
							state: payload.state.tabsState,
							remoteWorkspaceIds: getPeerRemoteWorkspaceIds(sync),
						}),
						sync,
					});
				};
				appStateWatcher.on("peer-update", onUpdate);
				return () => {
					appStateWatcher.off("peer-update", onUpdate);
				};
			});
		}),
	});
};
