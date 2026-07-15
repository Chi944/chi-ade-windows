import { describe, expect, mock, test } from "bun:test";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import { type AppState, createDefaultAppState } from "./schemas";
import { normalizeAppState } from "./validation";
import { ValidatedPeerEventCache } from "./watcher";
import { AppStateMutationCoordinator } from "./write-queue";

mock.module("main/lib/app-state", () => ({
	enqueueAppStateMutationAtRevision: async () => {
		throw new Error("unused test default");
	},
	getAppStateRevision: () => 0,
}));
mock.module("main/lib/sync/workspace-identity", () => ({
	getCanonicalForLocalWorkspaceId: () => null,
}));
mock.module("main/lib/local-db", () => ({ localDb: {} }));
mock.module("main/lib/terminal-history", () => ({
	writeClaudeSessionIdToHistory: async () => undefined,
}));

const { createPeerSyncService } = await import("./sync-service");

function stateWithWorkspace(options: {
	deviceId: string;
	workspaceId: string;
	canonical: string;
	label: string;
	at: number;
	sessionId?: string;
}): AppState {
	const state = createDefaultAppState(options.deviceId);
	state.tabsState = {
		tabs: [
			{
				id: `${options.label}-tab`,
				name: options.label,
				workspaceId: options.workspaceId,
				createdAt: 1,
				layout: `${options.label}-pane`,
			},
		],
		panes: {
			[`${options.label}-pane`]: {
				id: `${options.label}-pane`,
				tabId: `${options.label}-tab`,
				type: "terminal",
				name: options.label,
				agentRuntime: "claude",
			},
		},
		activeTabIds: {
			[options.workspaceId]: `${options.label}-tab`,
		},
		focusedPaneIds: {
			[`${options.label}-tab`]: `${options.label}-pane`,
		},
		tabHistoryStacks: { [options.workspaceId]: [] },
	};
	state.sync.lastWrittenAt = options.at;
	state.sync.perWorkspaceWrittenAt[options.canonical] = {
		deviceId: options.deviceId,
		at: options.at,
	};
	state.sync.workspaceMetadata[options.canonical] = {
		repository: "example.com/acme/repo",
		branch: "main",
		type: "branch",
	};
	state.sync.localToCanonical[options.workspaceId] = options.canonical;
	if (options.sessionId) {
		state.sync.paneClaudeSessions[`${options.label}-pane`] = options.sessionId;
	}
	return state;
}

function createHarness(options?: {
	localAt?: number;
	peerAt?: number;
	persistHandoff?: (handoff: {
		paneId: string;
		workspaceId: string;
		claudeSessionId: string;
	}) => Promise<void>;
	write?: (state: AppState) => Promise<void>;
	verifyMapping?: (
		canonical: string,
		localWorkspaceId: string,
	) => boolean | Promise<boolean>;
	sanitizeTabsState?: (state: AppState["tabsState"]) => AppState["tabsState"];
	now?: () => number;
}) {
	const local = stateWithWorkspace({
		deviceId: "local-device",
		workspaceId: "local-workspace",
		canonical: "canonical",
		label: "local",
		at: options?.localAt ?? 5,
	});
	const peer = stateWithWorkspace({
		deviceId: "peer-device",
		workspaceId: "peer-workspace",
		canonical: "canonical",
		label: "peer",
		at: options?.peerAt ?? 10,
		sessionId: "session-123",
	});
	const coordinator = new AppStateMutationCoordinator(local, {
		validate: (state) => normalizeAppState(state, { deviceId: "local-device" }),
		write: options?.write ?? (async () => undefined),
	});
	const cache = new ValidatedPeerEventCache({
		localDeviceId: "local-device",
	});
	cache.put("event-1", peer, coordinator.getRevision());
	let tokenCounter = 0;
	const service = createPeerSyncService({
		getEvent: (eventId) => cache.get(eventId),
		enqueueAtRevision: (label, revision, mutate) =>
			coordinator.enqueueAtRevision(label, revision, mutate),
		getRevision: () => coordinator.getRevision(),
		getSnapshot: () => coordinator.getSnapshot(),
		verifyMapping:
			options?.verifyMapping ??
			((canonical, localWorkspaceId) =>
				canonical === "canonical" && localWorkspaceId === "local-workspace"),
		persistHandoff: options?.persistHandoff ?? (async () => undefined),
		sanitizeTabsState: options?.sanitizeTabsState,
		tokenFactory: () => `suppression-${++tokenCounter}`,
		now: options?.now ?? (() => 1_000),
	});
	return { coordinator, cache, service };
}

describe("peer app-state sync service", () => {
	test("persists session handoffs and main disk/memory before returning committed", async () => {
		const events: string[] = [];
		const { coordinator, service } = createHarness({
			persistHandoff: async () => {
				events.push("session");
			},
			write: async (state) => {
				events.push(`disk:${state.tabsState.tabs[0]?.name}`);
			},
		});

		const result = await service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(result.status).toBe("committed");
		if (result.status !== "committed") return;
		expect(events).toEqual(["session", "disk:peer"]);
		expect(coordinator.getSnapshot().tabsState.tabs[0]?.name).toBe("peer");
		expect(result.tabsState.tabs[0]?.name).toBe("peer");
		expect(result.suppressionToken).toMatchObject({
			token: "suppression-1",
			revision: 1,
			expiresAt: 31_000,
		});
	});

	test("returns stale when a local mutation commits before the queued rebase", async () => {
		const { coordinator, service } = createHarness();
		const localWrite = coordinator.enqueue("local-theme", (draft) => {
			draft.themeState.activeThemeId = "system";
		});
		const peer = service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		await localWrite;
		expect(await peer).toEqual({ status: "stale", revision: 1 });
		expect(coordinator.getSnapshot().tabsState.tabs[0]?.name).toBe("local");
	});

	test("makes duplicate event IDs idempotent while refreshing acknowledgement tokens", async () => {
		const writes = mock(async () => undefined);
		const { service } = createHarness({ write: writes });
		const input = {
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		};

		const first = await service.rebasePeerUpdate(input);
		const duplicate = await service.rebasePeerUpdate(input);

		if (first.status !== "committed") throw new Error("Expected commit");
		expect(duplicate).toMatchObject({
			status: "committed",
			revision: 1,
			tabsState: first.tabsState,
		});
		if (duplicate.status !== "committed") return;
		expect(duplicate.suppressionToken.token).not.toBe(
			first.suppressionToken.token,
		);
		expect(writes).toHaveBeenCalledTimes(1);
	});

	test("keeps a stale-replanned event idempotent across base revisions", async () => {
		const writes = mock(async () => undefined);
		const { service } = createHarness({ write: writes });
		const first = await service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});
		const acknowledgementRetry = await service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 1,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(acknowledgementRetry).toMatchObject({
			status: "committed",
			revision: 1,
		});
		if (
			first.status !== "committed" ||
			acknowledgementRetry.status !== "committed"
		) {
			return;
		}
		expect(acknowledgementRetry.tabsState).toEqual(first.tabsState);
		expect(acknowledgementRetry.suppressionToken.token).not.toBe(
			first.suppressionToken.token,
		);
		expect(writes).toHaveBeenCalledTimes(1);
	});

	test("refreshes an expired token when a committed event is replayed", async () => {
		let now = 1_000;
		const writes = mock(async () => undefined);
		const { service } = createHarness({ write: writes, now: () => now });
		const input = {
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		};
		const first = await service.rebasePeerUpdate(input);
		if (first.status !== "committed") throw new Error("Expected commit");
		now = first.suppressionToken.expiresAt + 1;

		const replay = await service.rebasePeerUpdate(input);

		if (replay.status !== "committed") throw new Error("Expected replay");
		expect(replay.suppressionToken.expiresAt).toBe(now + 30_000);
		expect(replay.suppressionToken.token).not.toBe(
			first.suppressionToken.token,
		);
		expect(writes).toHaveBeenCalledTimes(1);
	});

	test("replays the coordinator's current snapshot after a later local revision", async () => {
		const writes = mock(async () => undefined);
		const { coordinator, service } = createHarness({ write: writes });
		const input = {
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		};
		const first = await service.rebasePeerUpdate(input);
		if (first.status !== "committed") throw new Error("Expected commit");
		await coordinator.enqueue("later-local-tabs", (draft) => {
			draft.tabsState.tabs[0].name = "later-local";
		});

		const replay = await service.rebasePeerUpdate({
			...input,
			baseRevision: coordinator.getRevision(),
		});

		if (replay.status !== "committed") throw new Error("Expected replay");
		expect(replay.revision).toBe(2);
		expect(replay.tabsState.tabs[0]?.name).toBe("later-local");
		expect(replay.winningWorkspaces).toEqual([]);
		expect(writes).toHaveBeenCalledTimes(2);
	});

	test("joins simultaneous duplicate requests behind one durable commit", async () => {
		let releaseWrite: (() => void) | undefined;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const writes = mock(async () => writeGate);
		const { service } = createHarness({ write: writes });
		const input = {
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		};

		const first = service.rebasePeerUpdate(input);
		const duplicate = service.rebasePeerUpdate(input);
		await Promise.resolve();
		releaseWrite?.();
		const [firstResult, duplicateResult] = await Promise.all([
			first,
			duplicate,
		]);

		expect(firstResult.status).toBe("committed");
		expect(duplicateResult.status).toBe("committed");
		expect(duplicateResult).toEqual(firstResult);
		expect(writes).toHaveBeenCalledTimes(1);
	});

	test("serializes the full rebase flow before a later event can plan", async () => {
		let releaseFirst: (() => void) | undefined;
		let firstStarted: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		let active = 0;
		let maxActive = 0;
		let verificationCount = 0;
		const { cache, coordinator, service } = createHarness({
			verifyMapping: async () => {
				verificationCount += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (verificationCount === 1) {
					firstStarted?.();
					await gate;
				}
				active -= 1;
				return true;
			},
		});
		cache.put(
			"event-2",
			stateWithWorkspace({
				deviceId: "peer-device",
				workspaceId: "peer-workspace",
				canonical: "canonical",
				label: "newer-peer",
				at: 20,
			}),
			coordinator.getRevision(),
		);

		const first = service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});
		const second = service.rebasePeerUpdate({
			eventId: "event-2",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});
		await started;
		await Promise.resolve();
		expect(verificationCount).toBe(1);

		releaseFirst?.();
		await Promise.all([first, second]);
		expect(maxActive).toBe(1);
	});

	test("clears portable provider markers after mapping a peer pane to a remote workspace", async () => {
		const { cache, service } = createHarness({
			sanitizeTabsState: (state) =>
				sanitizeSubscriptionProfilesForPersistence({
					state,
					remoteWorkspaceIds: new Set(["local-workspace"]),
				}),
		});
		const peer = cache.get("event-1");
		if (!peer) throw new Error("Expected cached peer event");
		peer.state.tabsState.panes["peer-pane"].subscriptionProfilePinned = true;
		cache.put("event-1", peer.state, peer.baseRevision);

		const result = await service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(result.status).toBe("committed");
		if (result.status !== "committed") return;
		expect(
			result.tabsState.panes["peer-pane"].subscriptionProfilePinned,
		).toBeUndefined();
	});

	test("commits a no-winner rebase without bumping workspace clocks", async () => {
		const { coordinator, service } = createHarness({
			localAt: 20,
			peerAt: 10,
		});
		const before = coordinator.getSnapshot().sync;

		const result = await service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(result.status).toBe("committed");
		expect(coordinator.getRevision()).toBe(1);
		expect(coordinator.getSnapshot().sync).toEqual(before);
		expect(coordinator.getSnapshot().tabsState.tabs[0]?.name).toBe("local");
	});

	test("rejects missing events and unverified renderer mappings", async () => {
		const { coordinator, service } = createHarness();
		expect(
			await service.rebasePeerUpdate({
				eventId: "missing",
				baseRevision: 0,
				canonicalToLocal: {},
			}),
		).toEqual({ status: "rejected", reason: "peer-event-unavailable" });
		expect(
			await service.rebasePeerUpdate({
				eventId: "event-1",
				baseRevision: 0,
				canonicalToLocal: { canonical: "wrong-workspace" },
			}),
		).toEqual({ status: "rejected", reason: "invalid-workspace-mapping" });
		expect(coordinator.getRevision()).toBe(0);
	});

	test("rejects the transaction when a session handoff cannot be persisted", async () => {
		const { coordinator, service } = createHarness({
			persistHandoff: async () => {
				throw new Error("disk unavailable");
			},
		});

		const result = await service.rebasePeerUpdate({
			eventId: "event-1",
			baseRevision: 0,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(result).toEqual({ status: "rejected", reason: "commit-failed" });
		expect(coordinator.getRevision()).toBe(0);
		expect(coordinator.getSnapshot().tabsState.tabs[0]?.name).toBe("local");
	});
});
