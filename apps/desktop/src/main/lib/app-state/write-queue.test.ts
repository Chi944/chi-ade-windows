import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AppState,
	createDefaultAppState,
	type TabsState,
} from "./schemas";
import { normalizeAppState } from "./validation";
import {
	AppStateMutationCoordinator,
	writeAppStateAtomically,
} from "./write-queue";

const temporaryDirectories = new Set<string>();

function createTabsState(label: string): TabsState {
	return {
		tabs: [
			{
				id: `${label}-tab`,
				name: label,
				workspaceId: "workspace-1",
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
		activeTabIds: { "workspace-1": `${label}-tab` },
		focusedPaneIds: { [`${label}-tab`]: `${label}-pane` },
		tabHistoryStacks: { "workspace-1": [] },
	};
}

function createCoordinator(
	write: (state: AppState) => Promise<void> = async () => undefined,
): AppStateMutationCoordinator {
	return new AppStateMutationCoordinator(createDefaultAppState("device"), {
		validate: (state) => normalizeAppState(state, { deviceId: "device" }),
		write,
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(async () => {
	for (const directory of temporaryDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	temporaryDirectories.clear();
});

describe("AppStateMutationCoordinator", () => {
	test("executes mutations in strict FIFO order when the first is delayed", async () => {
		const gate = deferred();
		const events: string[] = [];
		const coordinator = createCoordinator(async (state) => {
			events.push(`write:${state.themeState.activeThemeId}`);
		});

		const first = coordinator.enqueue("first", async (draft) => {
			events.push("first:start");
			await gate.promise;
			draft.themeState.activeThemeId = "first";
			events.push("first:end");
		});
		const second = coordinator.enqueue("second", (draft) => {
			events.push("second:start");
			draft.themeState.activeThemeId = "second";
		});

		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		gate.resolve();
		await Promise.all([first, second]);

		expect(events).toEqual([
			"first:start",
			"first:end",
			"write:first",
			"second:start",
			"write:second",
		]);
		expect(coordinator.getSnapshot().themeState.activeThemeId).toBe("second");
	});

	test("commits the newest queued tabs state", async () => {
		const writes: string[] = [];
		const coordinator = createCoordinator(async (state) => {
			writes.push(state.tabsState.tabs[0]?.name ?? "empty");
		});

		const older = coordinator.enqueue("older-tabs", (draft) => {
			draft.tabsState = createTabsState("older");
		});
		const newer = coordinator.enqueue("newer-tabs", (draft) => {
			draft.tabsState = createTabsState("newer");
		});
		await Promise.all([older, newer]);

		expect(writes).toEqual(["older", "newer"]);
		expect(coordinator.getSnapshot().tabsState.tabs[0].name).toBe("newer");
	});

	test("does not interleave theme or hotkeys with a tabs sync stamp", async () => {
		const gate = deferred();
		const events: string[] = [];
		const coordinator = createCoordinator();

		const tabs = coordinator.enqueue("tabs", async (draft) => {
			events.push("tabs:state");
			draft.tabsState = createTabsState("tabs");
			await gate.promise;
			draft.sync.lastWrittenAt = 10;
			events.push("tabs:stamp");
		});
		const theme = coordinator.enqueue("theme", (draft) => {
			events.push("theme");
			draft.themeState.activeThemeId = "system";
		});
		const hotkeys = coordinator.enqueue("hotkeys", (draft) => {
			events.push("hotkeys");
			draft.hotkeysState.version = 2;
		});

		await Promise.resolve();
		expect(events).toEqual(["tabs:state"]);
		gate.resolve();
		await Promise.all([tabs, theme, hotkeys]);

		expect(events).toEqual(["tabs:state", "tabs:stamp", "theme", "hotkeys"]);
		const state = coordinator.getSnapshot();
		expect(state.sync.lastWrittenAt).toBe(10);
		expect(state.themeState.activeThemeId).toBe("system");
		expect(state.hotkeysState.version).toBe(2);
	});

	test("keeps committed state unchanged after rejection and continues the queue", async () => {
		const coordinator = createCoordinator(async (state) => {
			if (state.themeState.activeThemeId === "broken") {
				throw new Error("disk full");
			}
		});

		const rejected = coordinator.enqueue("rejected", (draft) => {
			draft.themeState.activeThemeId = "broken";
		});
		const continued = coordinator.enqueue("continued", (draft) => {
			draft.hotkeysState.version = 2;
		});

		await expect(rejected).rejects.toThrow("disk full");
		await expect(continued).resolves.toMatchObject({ revision: 1 });
		const state = coordinator.getSnapshot();
		expect(state.themeState.activeThemeId).toBe("dark");
		expect(state.hotkeysState.version).toBe(2);
		expect(coordinator.getRevision()).toBe(1);
	});

	test("validates a clone and does not expose committed objects", async () => {
		const coordinator = createCoordinator();
		const sourceTabs = createTabsState("source");

		await coordinator.enqueue("tabs", (draft) => {
			draft.tabsState = sourceTabs;
		});
		sourceTabs.tabs[0].name = "mutated-after-commit";
		const snapshot = coordinator.getSnapshot();
		snapshot.tabsState.tabs[0].name = "mutated-snapshot";

		expect(coordinator.getSnapshot().tabsState.tabs[0].name).toBe("source");
	});

	test("checks an expected revision inside the queue before mutating", async () => {
		const coordinator = createCoordinator();
		const baseRevision = coordinator.getRevision();
		const localWrite = coordinator.enqueue("local", (draft) => {
			draft.themeState.activeThemeId = "system";
		});
		const stalePeer = coordinator.enqueueAtRevision(
			"peer",
			baseRevision,
			(draft) => {
				draft.themeState.activeThemeId = "peer";
			},
		);

		await localWrite;
		expect(await stalePeer).toEqual({
			status: "stale",
			revision: 1,
			state: coordinator.getSnapshot(),
		});
		expect(coordinator.getSnapshot().themeState.activeThemeId).toBe("system");
	});
});

describe("atomic app-state writer", () => {
	test("writes restrictive JSON and removes its temporary file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ade-state-write-"));
		temporaryDirectories.add(directory);
		const path = join(directory, "app-state.json");
		const state = createDefaultAppState("device");

		await writeAppStateAtomically(path, state);

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
		expect(
			(await readdir(directory)).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
	});

	test("removes the temporary file when atomic promotion fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ade-state-write-"));
		temporaryDirectories.add(directory);
		const path = join(directory, "app-state.json");

		await expect(
			writeAppStateAtomically(path, createDefaultAppState("device"), {
				renameFile: async () => {
					throw new Error("promotion failed");
				},
			}),
		).rejects.toThrow("promotion failed");
		expect(
			(await readdir(directory)).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});
});
