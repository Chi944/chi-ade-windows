import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { PeerAppStateEventMetadata } from "main/lib/app-state/watcher";

const appStateWatcher = new EventEmitter();
let cachedMetadata: PeerAppStateEventMetadata[] = [];
const peerAppStateEventCache = {
	listMetadata: mock(() =>
		cachedMetadata.map((metadata) => ({
			...metadata,
			canonicalWorkspaceIds: [...metadata.canonicalWorkspaceIds],
		})),
	),
};
const rebasePeerUpdate = mock(async () => ({
	status: "stale" as const,
	revision: 9,
}));
const getCanonicalForLocalWorkspaceId = mock((workspaceId: string) =>
	workspaceId === "local-workspace"
		? { canonical: "canonical-workspace" }
		: null,
);
const getLocalWorkspaceMappingsForCanonicalIds = mock(
	(canonicalWorkspaceIds: readonly string[]) =>
		Object.fromEntries(
			canonicalWorkspaceIds.flatMap((canonical) =>
				canonical === "canonical-workspace"
					? [[canonical, "local-workspace"] as const]
					: [],
			),
		),
);

mock.module("main/lib/app-state/watcher", () => ({
	appStateWatcher,
	peerAppStateEventCache,
}));
mock.module("main/lib/app-state", () => ({
	getAppStateSnapshot: () => ({
		sync: {
			localToCanonical: {
				"local-workspace": "canonical-workspace",
				"other-local-workspace": "unrelated-canonical",
			},
			workspaceMetadata: {
				"canonical-workspace": {
					repository: "github.com/acme/repo",
					branch: "main",
					type: "branch",
				},
				"unrelated-canonical": {
					repository: "github.com/acme/other",
					branch: "feature",
					type: "branch",
				},
			},
		},
	}),
}));
mock.module("main/lib/app-state/sync-service", () => ({
	peerSyncService: { rebasePeerUpdate },
}));
mock.module("main/lib/local-db", () => ({
	localDb: {
		select: () => ({
			from: () => ({
				all: () => [{ id: "local-workspace" }, { id: "unresolved-workspace" }],
			}),
		}),
	},
}));
mock.module("main/lib/sync/workspace-identity", () => ({
	getCanonicalForLocalWorkspaceId,
	getLocalWorkspaceMappingsForCanonicalIds,
}));

const { createSyncRouter } = await import(".");

afterEach(() => {
	appStateWatcher.removeAllListeners();
	cachedMetadata = [];
	peerAppStateEventCache.listMetadata.mockClear();
	rebasePeerUpdate.mockClear();
	getCanonicalForLocalWorkspaceId.mockClear();
	getLocalWorkspaceMappingsForCanonicalIds.mockClear();
});

describe("sync router coordinated peer adoption", () => {
	test("replays a startup event cached before subscription and deduplicates attach races", async () => {
		const metadata: PeerAppStateEventMetadata = {
			eventId: "event-startup",
			baseRevision: 4,
			writerDeviceId: "peer-device",
			lastWrittenAt: 10,
			canonicalWorkspaceIds: ["canonical-workspace"],
		};
		cachedMetadata = [metadata];
		peerAppStateEventCache.listMetadata.mockImplementationOnce(() => {
			appStateWatcher.emit("peer-update", metadata);
			return cachedMetadata;
		});
		const caller = createSyncRouter().createCaller({});
		const updates = await caller.appStateUpdates();
		const received: PeerAppStateEventMetadata[] = [];

		const subscription = updates.subscribe({
			next: (update) => received.push(update),
		});

		expect(received).toEqual([metadata]);
		expect(appStateWatcher.listenerCount("peer-update")).toBe(1);
		subscription.unsubscribe();
		expect(appStateWatcher.listenerCount("peer-update")).toBe(0);
	});

	test("replays one pending event on each reconnect without duplicates", async () => {
		const metadata: PeerAppStateEventMetadata = {
			eventId: "event-pending",
			baseRevision: 4,
			writerDeviceId: "peer-device",
			lastWrittenAt: 10,
			canonicalWorkspaceIds: ["canonical-workspace"],
		};
		cachedMetadata = [metadata];
		const caller = createSyncRouter().createCaller({});

		for (let reconnect = 0; reconnect < 2; reconnect += 1) {
			const received: PeerAppStateEventMetadata[] = [];
			const updates = await caller.appStateUpdates();
			const subscription = updates.subscribe({
				next: (update) => received.push(update),
			});
			expect(received).toEqual([metadata]);
			subscription.unsubscribe();
		}

		expect(peerAppStateEventCache.listMetadata).toHaveBeenCalledTimes(2);
	});

	test("subscription exposes only opaque event metadata and the base revision", async () => {
		const caller = createSyncRouter().createCaller({});
		const updates = await caller.appStateUpdates();
		let received: PeerAppStateEventMetadata | undefined;
		const subscription = updates.subscribe({
			next: (update) => {
				received = update;
			},
		});
		const metadata: PeerAppStateEventMetadata = {
			eventId: "event-1",
			baseRevision: 4,
			writerDeviceId: "peer-device",
			lastWrittenAt: 10,
			canonicalWorkspaceIds: ["canonical-workspace"],
		};

		appStateWatcher.emit("peer-update", metadata);

		expect(received).toEqual(metadata);
		expect(received).not.toHaveProperty("tabsState");
		expect(received).not.toHaveProperty("sync");
		subscription.unsubscribe();
	});

	test("returns portable local workspace mappings for renderer resolution", async () => {
		const caller = createSyncRouter().createCaller({});

		expect(
			await caller.localWorkspaceMappings({
				canonicalWorkspaceIds: ["canonical-workspace"],
			}),
		).toEqual({
			"canonical-workspace": "local-workspace",
		});
		expect(getLocalWorkspaceMappingsForCanonicalIds).toHaveBeenCalledWith(
			["canonical-workspace"],
			{
				preferredLocalWorkspaceIdsByCanonical: {
					"canonical-workspace": ["local-workspace"],
				},
				workspaceMetadataByCanonical: {
					"canonical-workspace": {
						repository: "github.com/acme/repo",
						branch: "main",
						type: "branch",
					},
				},
			},
		);
		expect(getCanonicalForLocalWorkspaceId).not.toHaveBeenCalled();
	});

	test("accepts every canonical id from a valid large tombstone event", async () => {
		const caller = createSyncRouter().createCaller({});
		const canonicalWorkspaceIds = Array.from(
			{ length: 1_001 },
			(_, index) => `canonical-${index}`,
		);

		await expect(
			caller.localWorkspaceMappings({ canonicalWorkspaceIds }),
		).resolves.toEqual({});
		expect(getLocalWorkspaceMappingsForCanonicalIds).toHaveBeenCalledWith(
			canonicalWorkspaceIds,
			expect.any(Object),
		);
		const canonicalToLocal = Object.fromEntries(
			canonicalWorkspaceIds.map((canonical, index) => [
				canonical,
				`local-${index}`,
			]),
		);

		await expect(
			caller.rebasePeerUpdate({
				eventId: "large-event",
				baseRevision: 0,
				canonicalToLocal,
			}),
		).resolves.toEqual({ status: "stale", revision: 9 });
		expect(rebasePeerUpdate).toHaveBeenCalledWith({
			eventId: "large-event",
			baseRevision: 0,
			canonicalToLocal,
		});
	});

	test("validates and forwards a rebase request to the main sync service", async () => {
		const caller = createSyncRouter().createCaller({});
		const input = {
			eventId: "event-1",
			baseRevision: 4,
			canonicalToLocal: {
				"canonical-workspace": "local-workspace",
			},
		};

		expect(await caller.rebasePeerUpdate(input)).toEqual({
			status: "stale",
			revision: 9,
		});
		expect(rebasePeerUpdate).toHaveBeenCalledWith(input);
	});
});
