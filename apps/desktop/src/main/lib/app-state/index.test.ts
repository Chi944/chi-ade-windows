import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AppStateBindingReconciliationInput,
	type AppStateDiagnosticEvent,
	enqueueAppStateMutation,
	getAppStateRevision,
	getAppStateSnapshot,
	getDeviceId,
	initAppState,
	reconcileLoadedAppStateBindings,
	resetAppStateForTests,
	takeStartupPeerPaneIds,
} from ".";
import { type AppState, createDefaultAppState } from "./schemas";
import { AppStateWatcherController, ValidatedPeerEventCache } from "./watcher";
import { writeAppStateAtomically } from "./write-queue";

const temporaryHomes = new Set<string>();

async function createTemporaryHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "ade-app-state-"));
	temporaryHomes.add(home);
	return home;
}

async function writeExistingState(
	home: string,
	state: AppState,
): Promise<void> {
	await mkdir(home, { recursive: true });
	await writeFile(join(home, "app-state.json"), JSON.stringify(state), "utf8");
}

function requireQuarantineFile(result: { quarantineFile?: string }): string {
	if (!result.quarantineFile) {
		throw new Error("Expected recovery to create a quarantine file");
	}
	return result.quarantineFile;
}

function createPeerStartupState(): AppState {
	const state = createDefaultAppState("peer-device");
	state.tabsState = {
		tabs: [
			{
				id: "peer-tab",
				name: "Peer",
				workspaceId: "peer-workspace",
				createdAt: 1,
				layout: "peer-pane",
			},
		],
		panes: {
			"peer-pane": {
				id: "peer-pane",
				tabId: "peer-tab",
				type: "terminal",
				name: "Claude",
				agentRuntime: "claude",
			},
		},
		activeTabIds: { "peer-workspace": "peer-tab" },
		focusedPaneIds: { "peer-tab": "peer-pane" },
		tabHistoryStacks: { "peer-workspace": [] },
	};
	state.sync.localToCanonical = {
		"peer-workspace": "canonical-workspace",
	};
	state.sync.workspaceMetadata = {
		"canonical-workspace": {
			repository: "example.com/acme/repo",
			branch: "main",
			type: "branch",
		},
	};
	state.sync.paneClaudeSessions = { "peer-pane": "session-123" };
	return state;
}

function createInitializationCapture(targetPath: string): {
	cache: ValidatedPeerEventCache;
	beforeOverwrite: (candidatePath: string) => Promise<void>;
} {
	const cache = new ValidatedPeerEventCache({
		localDeviceId: () => getDeviceId(),
	});
	const watcher = new AppStateWatcherController({
		targetPath,
		localDeviceId: () => getDeviceId(),
		getBaseRevision: getAppStateRevision,
		readCandidateFile: (path) => readFile(path, "utf8"),
		readStableFile: async () => null,
		watchDirectory: () => ({ close: () => undefined }),
		eventCache: cache,
		eventIdFactory: () => "initialization-peer-event",
	});
	return {
		cache,
		beforeOverwrite: (candidatePath) =>
			watcher.captureBeforeOverwrite(candidatePath),
	};
}

afterEach(async () => {
	resetAppStateForTests();
	for (const home of temporaryHomes) {
		await chmod(join(home, "app-state.json"), 0o600).catch(() => undefined);
		await rm(home, { recursive: true, force: true });
	}
	temporaryHomes.clear();
});

describe("validated app-state initialization", () => {
	test("awaits peer session handoff persistence and exposes pane markers only ephemerally", async () => {
		const home = await createTemporaryHome();
		await writeExistingState(home, createPeerStartupState());
		let releaseHandoff: (() => void) | undefined;
		let handoffStarted: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseHandoff = resolve;
		});
		const started = new Promise<void>((resolve) => {
			handoffStarted = resolve;
		});
		const persisted = mock(async () => {
			handoffStarted?.();
			await gate;
		});
		let resolved = false;
		const initializing = initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: {
				resolveLocalWorkspaceId: () => "local-workspace",
				getCanonicalForLocalWorkspaceId: () => null,
				getRemoteWorkspaceIds: () => new Set(),
				reconcileBindings: () => ({ removedBindings: 0 }),
			},
			persistStartupPeerHandoff: persisted,
		}).then((value) => {
			resolved = true;
			return value;
		});

		await started;
		expect(resolved).toBe(false);
		releaseHandoff?.();
		await initializing;

		expect(persisted).toHaveBeenCalledWith({
			paneId: "peer-pane",
			workspaceId: "local-workspace",
			claudeSessionId: "session-123",
		});
		expect(takeStartupPeerPaneIds()).toEqual(["peer-pane"]);
		expect(takeStartupPeerPaneIds()).toEqual([]);
		expect(await readFile(join(home, "app-state.json"), "utf8")).not.toContain(
			"startupPeerPaneIds",
		);
	});

	test("reports a startup handoff failure without bricking initialization", async () => {
		const home = await createTemporaryHome();
		await writeExistingState(home, createPeerStartupState());

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: {
				resolveLocalWorkspaceId: () => "local-workspace",
				getCanonicalForLocalWorkspaceId: () => null,
				getRemoteWorkspaceIds: () => new Set(),
				reconcileBindings: () => ({ removedBindings: 0 }),
			},
			persistStartupPeerHandoff: async () => {
				throw new Error("history unavailable");
			},
		});

		expect(result.startupWarnings).toEqual([
			"A peer Claude session could not be staged for startup.",
		]);
		expect(getAppStateSnapshot().tabsState.tabs[0]?.workspaceId).toBe(
			"local-workspace",
		);
		expect(takeStartupPeerPaneIds()).toEqual(["peer-pane"]);
	});

	test("classifies first run explicitly and atomically materializes defaults", async () => {
		const home = await createTemporaryHome();
		const events: AppStateDiagnosticEvent[] = [];

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "first-device",
			onDiagnosticEvent: (event) => events.push(event),
			reconciliation: false,
		});

		expect(result).toMatchObject({ source: "first-run", trust: "untrusted" });
		expect(events).toEqual([]);
		expect(getAppStateSnapshot()).toEqual(
			createDefaultAppState("first-device"),
		);
		const stored = JSON.parse(
			await readFile(join(home, "app-state.json"), "utf8"),
		);
		expect(stored).toEqual(createDefaultAppState("first-device"));
		expect((await readdir(home)).some((name) => name.endsWith(".tmp"))).toBe(
			false,
		);
		if (process.platform !== "win32") {
			expect((await stat(join(home, "app-state.json"))).mode & 0o777).toBe(
				0o600,
			);
		}
	});

	test("captures a peer that lands during first-run promotion at revision zero", async () => {
		const home = await createTemporaryHome();
		const targetPath = join(home, "app-state.json");
		const peer = createDefaultAppState("peer-device");
		peer.themeState.activeThemeId = "peer-first-run";
		const capture = createInitializationCapture(targetPath);
		let injectPeer = true;

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "first-device",
			beforeOverwrite: capture.beforeOverwrite,
			writeStateAtomically: (path, state, dependencies) =>
				writeAppStateAtomically(path, state, {
					...dependencies,
					linkFile: async (source, destination) => {
						if (injectPeer) {
							injectPeer = false;
							await writeFile(destination, JSON.stringify(peer), "utf8");
							const error = new Error(
								"peer won first-run target",
							) as NodeJS.ErrnoException;
							error.code = "EEXIST";
							throw error;
						}
						await link(source, destination);
					},
				}),
			reconciliation: false,
		});

		expect(result).toMatchObject({ source: "first-run", trust: "untrusted" });
		expect(capture.cache.listMetadata()).toEqual([
			expect.objectContaining({
				eventId: "initialization-peer-event",
				baseRevision: 0,
			}),
		]);
		expect(capture.cache.get("initialization-peer-event")?.state).toMatchObject(
			{
				themeState: { activeThemeId: "peer-first-run" },
				sync: { deviceId: "peer-device" },
			},
		);
		expect(JSON.parse(await readFile(targetPath, "utf8")).sync.deviceId).toBe(
			"first-device",
		);
	});

	test("loads a valid file as trusted without rewriting it", async () => {
		const home = await createTemporaryHome();
		const state = createDefaultAppState("writer-device");
		state.themeState.activeThemeId = "system";
		await writeExistingState(home, state);
		const path = join(home, "app-state.json");
		const before = await stat(path);

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: false,
		});
		const after = await stat(path);

		expect(result).toMatchObject({ source: "loaded", trust: "trusted" });
		expect(getAppStateSnapshot()).toEqual(state);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	test.each([
		["missing tabs state", {}],
		["missing tabs and panes", { tabsState: {} }],
	])("quarantines %s without reconciling away existing bindings or homes", async (_name, incompleteState) => {
		const home = await createTemporaryHome();
		const raw = JSON.stringify(incompleteState);
		await writeFile(join(home, "app-state.json"), raw, "utf8");
		const bindingPath = join(home, "existing-pane-binding.json");
		const profileHome = join(home, "existing-profile-home");
		await writeFile(bindingPath, "binding-must-survive", "utf8");
		await mkdir(profileHome);
		await writeFile(
			join(profileHome, "credentials.json"),
			"home-must-survive",
			"utf8",
		);
		const reconcileBindings = mock(() => {
			rmSync(bindingPath, { force: true });
			rmSync(profileHome, { recursive: true, force: true });
			return { removedBindings: 1, prunedHomes: 1 };
		});

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: {
				resolveLocalWorkspaceId: () => null,
				getCanonicalForLocalWorkspaceId: () => null,
				getRemoteWorkspaceIds: () => new Set<string>(),
				reconcileBindings,
			},
		});

		expect(result).toMatchObject({
			source: "invalid-shape",
			trust: "recovered",
			reconciliation: { status: "deferred" },
		});
		expect(reconcileBindings).not.toHaveBeenCalled();
		expect(existsSync(bindingPath)).toBe(true);
		expect(await readFile(join(profileHome, "credentials.json"), "utf8")).toBe(
			"home-must-survive",
		);
		expect(
			await readFile(join(home, requireQuarantineFile(result)), "utf8"),
		).toBe(raw);
	});

	test("keeps a supported legacy snapshot trusted when tabs and panes are present", async () => {
		const home = await createTemporaryHome();
		await writeFile(
			join(home, "app-state.json"),
			JSON.stringify({
				tabsState: { tabs: [], panes: {} },
				themeState: { activeThemeId: "system" },
			}),
			"utf8",
		);
		const reconcileBindings = mock(() => ({
			removedBindings: 0,
			prunedHomes: 0,
		}));

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: {
				resolveLocalWorkspaceId: () => null,
				getCanonicalForLocalWorkspaceId: () => null,
				getRemoteWorkspaceIds: () => new Set<string>(),
				reconcileBindings,
			},
		});

		expect(result).toMatchObject({
			source: "loaded",
			trust: "trusted",
			reconciliation: { status: "completed" },
		});
		expect(reconcileBindings).toHaveBeenCalledTimes(1);
	});

	test.each([
		["invalid-json" as const, "{not-json"],
		["invalid-shape" as const, JSON.stringify({ tabsState: null })],
	])("quarantines %s and restores safe defaults", async (reason, damaged) => {
		const home = await createTemporaryHome();
		await writeFile(join(home, "app-state.json"), damaged, "utf8");
		const events: AppStateDiagnosticEvent[] = [];

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "recovery-device",
			now: () => 1_700_000_000_000,
			onDiagnosticEvent: (event) => events.push(event),
			reconciliation: false,
		});

		expect(result).toMatchObject({ source: reason, trust: "recovered" });
		const quarantineFile = requireQuarantineFile(result);
		expect(quarantineFile).toMatch(/^app-state\.quarantine\./);
		expect(await readFile(join(home, quarantineFile), "utf8")).toBe(damaged);
		expect(
			JSON.parse(await readFile(join(home, "app-state.json"), "utf8")),
		).toEqual(createDefaultAppState("recovery-device"));
		expect(events).toEqual([
			{
				type: "app-state-recovered",
				reason,
				quarantineFile,
			},
		]);
		expect(JSON.stringify(events)).not.toContain(damaged);
		expect(JSON.stringify(events)).not.toContain(home);
	});

	test("captures a valid peer replacement at the recovery quarantine boundary", async () => {
		const home = await createTemporaryHome();
		const targetPath = join(home, "app-state.json");
		const damaged = "{not-json";
		await writeFile(targetPath, damaged, "utf8");
		const peer = createDefaultAppState("peer-device");
		peer.themeState.activeThemeId = "peer-recovery-race";
		const capture = createInitializationCapture(targetPath);
		const events: AppStateDiagnosticEvent[] = [];

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "recovery-device",
			readStateFile: async (path) => {
				const observed = await readFile(path, "utf8");
				await writeFile(path, JSON.stringify(peer), "utf8");
				return observed;
			},
			beforeOverwrite: capture.beforeOverwrite,
			onDiagnosticEvent: (event) => events.push(event),
			reconciliation: false,
		});

		expect(result).toEqual(
			expect.objectContaining({ source: "invalid-json", trust: "recovered" }),
		);
		expect(result.quarantineFile).toBeUndefined();
		expect(capture.cache.listMetadata()).toEqual([
			expect.objectContaining({
				eventId: "initialization-peer-event",
				baseRevision: 0,
			}),
		]);
		expect(capture.cache.get("initialization-peer-event")?.state).toMatchObject(
			{
				themeState: { activeThemeId: "peer-recovery-race" },
				sync: { deviceId: "peer-device" },
			},
		);
		expect(events).toEqual([
			{ type: "app-state-recovered", reason: "invalid-json" },
		]);
		expect(JSON.parse(await readFile(targetPath, "utf8")).sync.deviceId).toBe(
			"recovery-device",
		);
		expect(
			(await readdir(home)).filter((name) =>
				name.startsWith("app-state.quarantine."),
			),
		).toEqual([]);
	});

	test("does not let a diagnostic observer crash successful recovery", async () => {
		const home = await createTemporaryHome();
		const damaged = "{damaged";
		await writeFile(join(home, "app-state.json"), damaged, "utf8");

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "recovery-device",
			onDiagnosticEvent: () => {
				throw new Error("diagnostic sink unavailable");
			},
			reconciliation: false,
		});

		expect(result).toMatchObject({
			source: "invalid-json",
			trust: "recovered",
		});
		expect(
			await readFile(join(home, requireQuarantineFile(result)), "utf8"),
		).toBe(damaged);
		expect(
			JSON.parse(await readFile(join(home, "app-state.json"), "utf8")),
		).toEqual(createDefaultAppState("recovery-device"));
	});

	test("distinguishes a read failure and preserves the unread source", async () => {
		const home = await createTemporaryHome();
		const damaged = "source-that-could-not-be-read";
		await writeFile(join(home, "app-state.json"), damaged, "utf8");
		const events: AppStateDiagnosticEvent[] = [];

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "recovery-device",
			readStateFile: async () => {
				throw new Error(`secret read error: ${home}`);
			},
			onDiagnosticEvent: (event) => events.push(event),
			reconciliation: false,
		});

		expect(result).toMatchObject({
			source: "read-failure",
			trust: "recovered",
		});
		const quarantineFile = requireQuarantineFile(result);
		expect(await readFile(join(home, quarantineFile), "utf8")).toBe(damaged);
		expect(events).toEqual([
			{
				type: "app-state-recovered",
				reason: "read-failure",
				quarantineFile,
			},
		]);
		expect(JSON.stringify(events)).not.toContain("secret read error");
		expect(JSON.stringify(events)).not.toContain(home);
	});

	test("rotates quarantine files to at most three", async () => {
		const home = await createTemporaryHome();
		for (const timestamp of [1, 2, 3]) {
			await writeFile(
				join(
					home,
					`app-state.quarantine.${String(timestamp).padStart(13, "0")}.old.json`,
				),
				`old-${timestamp}`,
				"utf8",
			);
		}
		await writeFile(join(home, "app-state.json"), "{damaged", "utf8");

		const result = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "recovery-device",
			now: () => 4,
			reconciliation: false,
		});
		const quarantines = (await readdir(home)).filter((name) =>
			name.startsWith("app-state.quarantine."),
		);

		expect(quarantines).toHaveLength(3);
		expect(quarantines).toContain(requireQuarantineFile(result));
		expect(quarantines).not.toContain(
			"app-state.quarantine.0000000000001.old.json",
		);
	});

	test("a recovered default becomes a trusted clean restart", async () => {
		const home = await createTemporaryHome();
		await writeFile(join(home, "app-state.json"), "[]", "utf8");

		const recovered = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "stable-device",
			reconciliation: false,
		});
		expect(recovered.trust).toBe("recovered");

		resetAppStateForTests();
		const restarted = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "different-device",
			reconciliation: false,
		});

		expect(restarted).toMatchObject({ source: "loaded", trust: "trusted" });
		expect(getAppStateSnapshot().sync.deviceId).toBe("stable-device");
	});

	test("serializes validated mutations and keeps a failed candidate off disk", async () => {
		const home = await createTemporaryHome();
		await initAppState({
			homeDir: home,
			deviceIdFactory: () => "queue-device",
			reconciliation: false,
		});

		const rejected = enqueueAppStateMutation("invalid-time", (draft) => {
			draft.sync.lastWrittenAt = Number.POSITIVE_INFINITY;
		});
		const continued = enqueueAppStateMutation("theme", (draft) => {
			draft.themeState.activeThemeId = "system";
		});

		await expect(rejected).rejects.toThrow(/finite|shape|number/i);
		await expect(continued).resolves.toMatchObject({ revision: 1 });
		expect(getAppStateSnapshot().sync.lastWrittenAt).toBe(0);
		expect(getAppStateSnapshot().themeState.activeThemeId).toBe("system");
		const stored = JSON.parse(
			await readFile(join(home, "app-state.json"), "utf8"),
		);
		expect(stored.sync.lastWrittenAt).toBe(0);
		expect(stored.themeState.activeThemeId).toBe("system");
	});

	test("classifies trusted writer workspaces before a theme mutation persists provider markers", async () => {
		const home = await createTemporaryHome();
		const profileId = "11111111-1111-4111-8111-111111111111";
		const state = createDefaultAppState("peer-device");
		state.tabsState = {
			tabs: [
				{
					id: "local-tab",
					name: "Local",
					workspaceId: "writer-local-workspace",
					createdAt: 1,
					layout: "local-pane",
				},
				{
					id: "remote-tab",
					name: "Remote",
					workspaceId: "writer-remote-workspace",
					createdAt: 2,
					layout: "remote-pane",
				},
				{
					id: "unresolved-pinned-tab",
					name: "Unresolved pinned",
					workspaceId: "writer-unresolved-pinned",
					createdAt: 3,
					layout: "unresolved-pinned-pane",
				},
				{
					id: "unresolved-unpinned-tab",
					name: "Unresolved unpinned",
					workspaceId: "writer-unresolved-unpinned",
					createdAt: 4,
					layout: "unresolved-unpinned-pane",
				},
			],
			panes: {
				"local-pane": {
					id: "local-pane",
					tabId: "local-tab",
					type: "terminal",
					name: "Local Claude",
					agentRuntime: "claude",
				},
				"remote-pane": {
					id: "remote-pane",
					tabId: "remote-tab",
					type: "terminal",
					name: "Remote Codex",
					agentRuntime: "codex",
					subscriptionProfileId: profileId,
					subscriptionProfilePinned: true,
				},
				"unresolved-pinned-pane": {
					id: "unresolved-pinned-pane",
					tabId: "unresolved-pinned-tab",
					type: "terminal",
					name: "Unresolved pinned Claude",
					agentRuntime: "claude",
					subscriptionProfileId: profileId,
					subscriptionProfilePinned: true,
				},
				"unresolved-unpinned-pane": {
					id: "unresolved-unpinned-pane",
					tabId: "unresolved-unpinned-tab",
					type: "terminal",
					name: "Unresolved unpinned Codex",
					agentRuntime: "codex",
					subscriptionProfileId: profileId,
				},
			},
			activeTabIds: {},
			focusedPaneIds: {},
			tabHistoryStacks: {},
		};
		state.sync.localToCanonical = {
			"writer-local-workspace": "canonical-local",
			"writer-remote-workspace": "canonical-remote",
			"writer-unresolved-pinned": "canonical-unresolved",
		};
		await writeExistingState(home, state);

		await initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: {
				resolveLocalWorkspaceId: (canonical) => {
					if (canonical === "canonical-local") return "local-workspace";
					if (canonical === "canonical-remote") return "remote-workspace";
					return null;
				},
				getCanonicalForLocalWorkspaceId: () => null,
				getRemoteWorkspaceIds: () => new Set(["remote-workspace"]),
				reconcileBindings: () => ({ removedBindings: 0 }),
			},
		});
		await enqueueAppStateMutation("test.theme", (draft) => {
			draft.themeState.activeThemeId = "system";
		});

		const stored = JSON.parse(
			await readFile(join(home, "app-state.json"), "utf8"),
		) as AppState;
		expect(stored.tabsState.panes["local-pane"].subscriptionProfilePinned).toBe(
			true,
		);
		expect(
			stored.tabsState.panes["remote-pane"].subscriptionProfilePinned,
		).toBeUndefined();
		expect(stored.tabsState.panes["unresolved-pinned-pane"]).toBeUndefined();
		expect(stored.tabsState.panes["unresolved-unpinned-pane"]).toBeUndefined();
		expect(JSON.stringify(stored)).not.toContain(profileId);
	});
});

describe("subscription binding reconciliation gate", () => {
	test("translates peer-local workspace IDs before trusted reconciliation", async () => {
		const home = await createTemporaryHome();
		const state = createDefaultAppState("peer-device");
		state.tabsState = {
			tabs: [
				{
					id: "peer-tab",
					name: "Peer",
					workspaceId: "peer-workspace",
					createdAt: 1,
					layout: "peer-pane",
				},
				{
					id: "unresolved-tab",
					name: "Unresolved",
					workspaceId: "unknown-peer-workspace",
					createdAt: 2,
					layout: "unresolved-pane",
				},
			],
			panes: {
				"peer-pane": {
					id: "peer-pane",
					tabId: "peer-tab",
					type: "terminal",
					name: "Claude",
					agentRuntime: "claude",
				},
				"unresolved-pane": {
					id: "unresolved-pane",
					tabId: "unresolved-tab",
					type: "terminal",
					name: "Codex",
					agentRuntime: "codex",
				},
			},
			activeTabIds: {},
			focusedPaneIds: {},
			tabHistoryStacks: {},
		};
		state.sync.localToCanonical = {
			"peer-workspace": "canonical-peer",
			"unknown-peer-workspace": "canonical-unknown",
		};
		state.sync.workspaceMetadata = {
			"canonical-peer": {
				repository: "example.com/acme/repo",
				branch: "main",
				type: "worktree",
			},
		};
		await writeExistingState(home, state);
		const loaded = await initAppState({
			homeDir: home,
			deviceIdFactory: () => "local-device",
			reconciliation: false,
		});
		const reconcileBindings = mock(
			(_input: AppStateBindingReconciliationInput) => ({
				removedBindings: 0,
				backfilledWorkspaceIds: 0,
				prunedHomes: 0,
				preservedUnresolvedBindings: 1,
				warnings: [],
			}),
		);

		const result = await reconcileLoadedAppStateBindings(loaded, {
			resolveLocalWorkspaceId: (canonical) =>
				canonical === "canonical-peer" ? "local-workspace" : null,
			getCanonicalForLocalWorkspaceId: () => null,
			getRemoteWorkspaceIds: () => new Set<string>(),
			reconcileBindings,
		});

		expect(result.status).toBe("completed");
		expect(reconcileBindings).toHaveBeenCalledTimes(1);
		expect(reconcileBindings.mock.calls[0]?.[0]).toEqual({
			stateTrust: "trusted",
			durablePanes: [
				{
					paneId: "peer-pane",
					provider: "claude",
					workspaceId: "local-workspace",
				},
				{
					paneId: "unresolved-pane",
					provider: "codex",
					workspaceId: "unknown-peer-workspace",
				},
			],
			unresolvedWorkspaceIds: new Set(["unknown-peer-workspace"]),
		});
	});

	test.each([
		"recovered" as const,
		"untrusted" as const,
	])("defers destructive reconciliation for %s state", async (trust) => {
		const reconcileBindings = mock(() => {
			throw new Error("must not run");
		});
		const result = await reconcileLoadedAppStateBindings(
			{
				source: trust === "recovered" ? "invalid-json" : "first-run",
				trust,
				state: createDefaultAppState("device"),
			},
			{
				resolveLocalWorkspaceId: () => null,
				getCanonicalForLocalWorkspaceId: () => null,
				getRemoteWorkspaceIds: () => new Set<string>(),
				reconcileBindings,
			},
		);

		expect(result.status).toBe("deferred");
		expect(reconcileBindings).not.toHaveBeenCalled();
	});
});
