import { observable } from "@trpc/server/observable";
import { getAppStateSnapshot } from "main/lib/app-state";
import { peerSyncService } from "main/lib/app-state/sync-service";
import {
	appStateWatcher,
	type PeerAppStateEventMetadata,
	peerAppStateEventCache,
} from "main/lib/app-state/watcher";
import {
	getLocalWorkspaceMappingsForCanonicalIds,
	type PortableWorkspaceMetadata,
} from "main/lib/sync/workspace-identity";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const rebasePeerUpdateInputSchema = z.strictObject({
	eventId: z.string().min(1).max(256),
	baseRevision: z.number().int().nonnegative(),
	canonicalToLocal: z
		.record(z.string().min(1).max(128), z.string().min(1).max(256))
		.refine((value) => Object.keys(value).length <= 1_000, {
			message: "Too many workspace mappings",
		}),
});

const localWorkspaceMappingsInputSchema = z.strictObject({
	canonicalWorkspaceIds: z.array(z.string().min(1).max(128)).max(1_000),
});

function localWorkspaceResolutionHints(
	canonicalWorkspaceIds: readonly string[],
): {
	preferredLocalWorkspaceIdsByCanonical: Record<string, string[]>;
	workspaceMetadataByCanonical: Record<string, PortableWorkspaceMetadata>;
} {
	const requested = new Set(canonicalWorkspaceIds);
	const snapshot = getAppStateSnapshot();
	const preferredLocalWorkspaceIdsByCanonical: Record<string, string[]> = {};
	for (const [localWorkspaceId, canonical] of Object.entries(
		snapshot.sync.localToCanonical,
	)) {
		if (!requested.has(canonical)) continue;
		const workspaceIds = preferredLocalWorkspaceIdsByCanonical[canonical] ?? [];
		workspaceIds.push(localWorkspaceId);
		preferredLocalWorkspaceIdsByCanonical[canonical] = workspaceIds;
	}
	for (const workspaceIds of Object.values(
		preferredLocalWorkspaceIdsByCanonical,
	)) {
		workspaceIds.sort();
	}
	const workspaceMetadataByCanonical = Object.fromEntries(
		canonicalWorkspaceIds.flatMap((canonical) => {
			const metadata = snapshot.sync.workspaceMetadata[canonical];
			return metadata ? [[canonical, metadata] as const] : [];
		}),
	);
	return {
		preferredLocalWorkspaceIdsByCanonical,
		workspaceMetadataByCanonical,
	};
}

export const createSyncRouter = () =>
	router({
		/** Emits only opaque cache metadata; peer state never crosses optimistically. */
		appStateUpdates: publicProcedure.subscription(() =>
			observable<PeerAppStateEventMetadata>((emit) => {
				const emittedEventIds = new Set<string>();
				const onUpdate = (metadata: PeerAppStateEventMetadata) => {
					if (emittedEventIds.has(metadata.eventId)) return;
					emittedEventIds.add(metadata.eventId);
					emit.next(metadata);
				};
				// Attach first so an event arriving during cache enumeration cannot be lost.
				appStateWatcher.on("peer-update", onUpdate);
				for (const metadata of peerAppStateEventCache.listMetadata()) {
					onUpdate(metadata);
				}
				return () => appStateWatcher.off("peer-update", onUpdate);
			}),
		),

		/** Portable identities the renderer may use to build a peer rebase map. */
		localWorkspaceMappings: publicProcedure
			.input(localWorkspaceMappingsInputSchema)
			.query(({ input }) =>
				getLocalWorkspaceMappingsForCanonicalIds(input.canonicalWorkspaceIds, {
					...localWorkspaceResolutionHints(input.canonicalWorkspaceIds),
				}),
			),

		/** Revalidates and commits the cached event inside the app-state queue. */
		rebasePeerUpdate: publicProcedure
			.input(rebasePeerUpdateInputSchema)
			.mutation(({ input }) => peerSyncService.rebasePeerUpdate(input)),
	});
