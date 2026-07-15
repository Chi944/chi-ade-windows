import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createDefaultAppState } from "./schemas";
import {
	AppStateWatcherController,
	parsePeerAppStateJson,
	ValidatedPeerEventCache,
} from "./watcher";

function peerRaw(deviceId: string, label: string): string {
	const state = createDefaultAppState(deviceId);
	state.tabsState = {
		tabs: [
			{
				id: `${label}-tab`,
				name: label,
				workspaceId: `${label}-workspace`,
				createdAt: 1,
				layout: `${label}-pane`,
			},
		],
		panes: {
			[`${label}-pane`]: {
				id: `${label}-pane`,
				tabId: `${label}-tab`,
				type: "terminal",
				name: label,
			},
		},
		activeTabIds: { [`${label}-workspace`]: `${label}-tab` },
		focusedPaneIds: { [`${label}-tab`]: `${label}-pane` },
		tabHistoryStacks: { [`${label}-workspace`]: [] },
	};
	state.sync.lastWrittenAt = 10;
	state.sync.perWorkspaceWrittenAt[`canonical-${label}`] = {
		deviceId,
		at: 10,
	};
	state.sync.workspaceMetadata[`canonical-${label}`] = {
		repository: `example.com/acme/${label}`,
		branch: "main",
		type: "branch",
	};
	state.sync.localToCanonical[`${label}-workspace`] = `canonical-${label}`;
	return JSON.stringify(state);
}

describe("app-state watcher validation boundary", () => {
	test("deep-normalizes a valid peer snapshot through the shared schema", () => {
		const state = parsePeerAppStateJson(
			JSON.stringify({
				tabsState: {
					tabs: [
						{
							id: "tab-1",
							name: "Peer",
							workspaceId: "workspace-1",
							createdAt: 1,
							layout: "pane-1",
						},
					],
					panes: {
						"pane-1": {
							id: "pane-1",
							tabId: "tab-1",
							type: "terminal",
							name: "Claude",
							agentRuntime: "claude",
							terminalProfileId: "nord",
						},
					},
				},
				sync: { deviceId: "peer-device" },
			}),
			"local-device",
		);

		expect(state.sync.deviceId).toBe("peer-device");
		expect(state.tabsState.panes["pane-1"].terminalProfileId).toBe("nord");
		expect(state.tabsState.activeTabIds).toEqual({});
		expect(state.themeState).toEqual({
			activeThemeId: "dark",
			customThemes: [],
		});
	});

	test("rejects malformed peer snapshots instead of emitting them", () => {
		expect(() =>
			parsePeerAppStateJson(
				JSON.stringify({ tabsState: { tabs: null } }),
				"local-device",
			),
		).toThrow(/shape|tabs/i);
	});
});

describe("rename-safe app-state watcher", () => {
	test("watches the parent directory and ingests a valid peer file at startup", async () => {
		const watchedPaths: string[] = [];
		const cache = new ValidatedPeerEventCache({
			localDeviceId: "local-device",
			capacity: 4,
		});
		const watcher = new AppStateWatcherController({
			targetPath: join("C:\\sync", "app-state.json"),
			localDeviceId: () => "local-device",
			getBaseRevision: () => 7,
			readStableFile: async () => peerRaw("peer-device", "startup"),
			watchDirectory: (path) => {
				watchedPaths.push(path);
				return { close: () => undefined };
			},
			eventCache: cache,
			eventIdFactory: () => "event-startup",
		});
		const events: unknown[] = [];
		watcher.on("peer-update", (event) => events.push(event));

		await watcher.start();

		expect(watchedPaths).toEqual(["C:\\sync"]);
		expect(events).toEqual([
			{
				eventId: "event-startup",
				baseRevision: 7,
				writerDeviceId: "peer-device",
				lastWrittenAt: 10,
				canonicalWorkspaceIds: ["canonical-startup"],
			},
		]);
		expect(cache.get("event-startup")?.state.tabsState.tabs[0]?.name).toBe(
			"startup",
		);
	});

	test("re-reads the named file after every atomic rename event", async () => {
		const raws = [peerRaw("peer-a", "first"), peerRaw("peer-b", "second")];
		let callback:
			| ((eventType: string, filename: string | Buffer | null) => void)
			| undefined;
		let readIndex = 0;
		const watcher = new AppStateWatcherController({
			targetPath: "/sync/app-state.json",
			localDeviceId: () => "local-device",
			getBaseRevision: () => readIndex,
			readStableFile: async () => raws[Math.min(readIndex++, raws.length - 1)],
			watchDirectory: (_path, listener) => {
				callback = listener;
				return { close: () => undefined };
			},
			eventCache: new ValidatedPeerEventCache({
				localDeviceId: "local-device",
			}),
			eventIdFactory: () => `event-${readIndex}`,
		});
		const labels: string[] = [];
		watcher.on("peer-update", (event) => labels.push(event.eventId));
		await watcher.start();

		callback?.("rename", "app-state.json");
		await watcher.flush();

		expect(labels).toEqual(["event-1", "event-2"]);
	});

	test("ignores malformed and local-authored startup files", async () => {
		for (const raw of ["{broken", peerRaw("local-device", "local")]) {
			const cache = new ValidatedPeerEventCache({
				localDeviceId: "local-device",
			});
			const watcher = new AppStateWatcherController({
				targetPath: "/sync/app-state.json",
				localDeviceId: () => "local-device",
				getBaseRevision: () => 0,
				readStableFile: async () => raw,
				watchDirectory: () => ({ close: () => undefined }),
				eventCache: cache,
			});
			let emitted = false;
			watcher.on("peer-update", () => {
				emitted = true;
			});

			await watcher.start();

			expect(emitted).toBe(false);
			expect(cache.size).toBe(0);
		}
	});
});

describe("validated peer event cache", () => {
	test("advertises only canonical ids that can participate in a merge", () => {
		const state = createDefaultAppState("peer-device");
		state.sync.perWorkspaceWrittenAt.clock = {
			deviceId: "peer-device",
			at: 10,
		};
		state.sync.workspaceTombstones.deleted = {
			deviceId: "peer-device",
			at: 11,
		};
		state.sync.workspaceMetadata.metadata = {
			repository: "github.com/acme/metadata-only",
			branch: "main",
			type: "branch",
		};
		state.sync.localToCanonical.local = "mapping-only";
		const cache = new ValidatedPeerEventCache({
			localDeviceId: "local-device",
		});

		const metadata = cache.put("event", state, 1);

		expect(metadata.canonicalWorkspaceIds).toEqual(["clock", "deleted"]);
	});

	test("replays unexpired metadata in insertion order as defensive clones", () => {
		let now = 1_000;
		const cache = new ValidatedPeerEventCache({
			localDeviceId: "local-device",
			ttlMs: 100,
			now: () => now,
		});
		cache.put(
			"first",
			parsePeerAppStateJson(peerRaw("peer", "first"), "local"),
			1,
		);
		cache.put(
			"second",
			parsePeerAppStateJson(peerRaw("peer", "second"), "local"),
			2,
		);

		const replay = cache.listMetadata();
		expect(
			replay.map(({ eventId, baseRevision }) => ({ eventId, baseRevision })),
		).toEqual([
			{ eventId: "first", baseRevision: 1 },
			{ eventId: "second", baseRevision: 2 },
		]);
		replay[0].canonicalWorkspaceIds.push("mutated");
		expect(cache.listMetadata()[0]?.canonicalWorkspaceIds).not.toContain(
			"mutated",
		);

		now += 101;
		expect(cache.listMetadata()).toEqual([]);
	});

	test("is bounded, expiring, and returns a freshly validated clone", () => {
		let now = 1_000;
		const cache = new ValidatedPeerEventCache({
			localDeviceId: "local-device",
			capacity: 2,
			ttlMs: 100,
			now: () => now,
		});
		for (const [eventId, label] of [
			["one", "one"],
			["two", "two"],
			["three", "three"],
		] as const) {
			cache.put(
				eventId,
				parsePeerAppStateJson(peerRaw("peer", label), "local"),
				0,
			);
		}

		expect(cache.get("one")).toBeNull();
		const firstRead = cache.get("three");
		if (!firstRead) throw new Error("Expected cached event");
		firstRead.state.tabsState.tabs[0].name = "mutated";
		expect(cache.get("three")?.state.tabsState.tabs[0]?.name).toBe("three");

		now += 101;
		expect(cache.get("three")).toBeNull();
		expect(cache.size).toBe(0);
	});
});
