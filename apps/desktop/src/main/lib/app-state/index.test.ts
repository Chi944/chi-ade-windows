import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	chmod,
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
	getAppStateSnapshot,
	initAppState,
	reconcileLoadedAppStateBindings,
	resetAppStateForTests,
} from ".";
import { type AppState, createDefaultAppState } from "./schemas";

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

afterEach(async () => {
	resetAppStateForTests();
	for (const home of temporaryHomes) {
		await chmod(join(home, "app-state.json"), 0o600).catch(() => undefined);
		await rm(home, { recursive: true, force: true });
	}
	temporaryHomes.clear();
});

describe("validated app-state initialization", () => {
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
				mainRepoPath: "C:\\repo",
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
