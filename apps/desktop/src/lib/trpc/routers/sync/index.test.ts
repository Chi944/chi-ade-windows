import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AppStateSyncEnvelope } from "main/lib/app-state/schemas";
import type { AppStateUpdatePayload } from ".";

const NAMED_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const appStateWatcher = new EventEmitter();
const getCanonicalForLocalWorkspaceId = mock((workspaceId: string) =>
	workspaceId === "receiver-remote-workspace"
		? { canonical: "canonical-remote-workspace" }
		: null,
);
const localDb = {
	select: () => ({
		from: () => ({
			all: () => [{ workspaceId: "receiver-remote-workspace" }],
		}),
	}),
};

mock.module("main/lib/app-state/watcher", () => ({ appStateWatcher }));
mock.module("main/lib/local-db", () => ({ localDb }));
mock.module("main/lib/sync/workspace-identity", () => ({
	getCanonicalForLocalWorkspaceId,
}));

const { createSyncRouter } = await import(".");

const sync: AppStateSyncEnvelope = {
	deviceId: "peer-device",
	lastWrittenAt: 1,
	perWorkspaceWrittenAt: {},
	workspaceMetadata: {},
	localToCanonical: {
		"peer-local-workspace": "canonical-local-workspace",
		"peer-remote-workspace": "canonical-remote-workspace",
		"peer-unresolved-workspace": "canonical-unresolved-workspace",
	},
	paneClaudeSessions: {},
};

afterEach(() => {
	appStateWatcher.removeAllListeners();
	getCanonicalForLocalWorkspaceId.mockClear();
});

describe("sync router provider-profile sanitization", () => {
	test("preserves only existing markers for unresolved peer-local panes", async () => {
		const caller = createSyncRouter().createCaller({});
		const updates = await caller.appStateUpdates();
		let received: AppStateUpdatePayload | undefined;
		const subscription = updates.subscribe({
			next: (update) => {
				received = update;
			},
		});

		appStateWatcher.emit("peer-update", {
			state: {
				tabsState: {
					tabs: [
						{
							id: "peer-local-tab",
							name: "Peer local",
							workspaceId: "peer-local-workspace",
							createdAt: 1,
						},
						{
							id: "peer-remote-tab",
							name: "Peer remote",
							workspaceId: "peer-remote-workspace",
							createdAt: 2,
						},
						{
							id: "peer-unresolved-tab",
							name: "Peer unresolved",
							workspaceId: "peer-unresolved-workspace",
							createdAt: 3,
						},
					],
					panes: {
						"pinned-peer-local-pane": {
							id: "pinned-peer-local-pane",
							tabId: "peer-local-tab",
							type: "terminal",
							name: "Pinned Claude",
							agentRuntime: "claude",
							subscriptionProfileId: NAMED_PROFILE_ID,
							subscriptionProfilePinned: true,
						},
						"remote-pane": {
							id: "remote-pane",
							tabId: "peer-remote-tab",
							type: "terminal",
							name: "Remote Codex",
							agentRuntime: "codex",
							subscriptionProfileId: NAMED_PROFILE_ID,
							subscriptionProfilePinned: true,
						},
						"unpinned-unresolved-pane": {
							id: "unpinned-unresolved-pane",
							tabId: "peer-unresolved-tab",
							type: "terminal",
							name: "Unpinned Claude",
							agentRuntime: "claude",
						},
					},
					activeTabIds: {},
					focusedPaneIds: {},
					tabHistoryStacks: {},
				},
				sync,
			},
		});

		if (!received) throw new Error("Expected a peer app-state update");
		expect(received.tabsState.panes["pinned-peer-local-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
		expect(received.tabsState.panes["remote-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: undefined,
		});
		expect(
			received.tabsState.panes["unpinned-unresolved-pane"]
				.subscriptionProfilePinned,
		).toBeUndefined();
		expect(JSON.stringify(received.tabsState)).not.toContain(NAMED_PROFILE_ID);
		subscription.unsubscribe();
	});
});
