import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AppStateBindingReconciliationDependencies,
	type AppStateBindingReconciliationInput,
	prepareAppStateForStartup,
} from "./reconciliation";
import { type AppState, createDefaultAppState } from "./schemas";

function stateWithPane(options: {
	writerDeviceId: string;
	workspaceId: string;
	canonical?: string;
	paneId?: string;
}): AppState {
	const paneId = options.paneId ?? "pane-1";
	const state = createDefaultAppState(options.writerDeviceId);
	state.tabsState = {
		tabs: [
			{
				id: "tab-1",
				name: "Agent",
				workspaceId: options.workspaceId,
				createdAt: 1,
				layout: paneId,
			},
		],
		panes: {
			[paneId]: {
				id: paneId,
				tabId: "tab-1",
				type: "terminal",
				name: "Claude",
				agentRuntime: "claude",
				subscriptionProfilePinned: true,
			},
		},
		activeTabIds: { [options.workspaceId]: "tab-1" },
		focusedPaneIds: { "tab-1": paneId },
		tabHistoryStacks: { [options.workspaceId]: [] },
	};
	if (options.canonical) {
		state.sync.localToCanonical[options.workspaceId] = options.canonical;
		state.sync.perWorkspaceWrittenAt[options.canonical] = {
			deviceId: options.writerDeviceId,
			at: 50,
		};
		state.sync.workspaceMetadata[options.canonical] = {
			repository: "example.com/acme/repo",
			branch: "main",
			type: "branch",
		};
		state.sync.lastWrittenAt = 50;
	}
	return state;
}

function dependencies(
	options: {
		resolve?: (canonical: string) => string | null;
		remoteIds?: string[];
		reconcile?: AppStateBindingReconciliationDependencies["reconcileBindings"];
	} = {},
): AppStateBindingReconciliationDependencies {
	return {
		resolveLocalWorkspaceId: (canonical) =>
			options.resolve?.(canonical) ?? null,
		getCanonicalForLocalWorkspaceId: (workspaceId) =>
			workspaceId === "local-workspace"
				? { canonical: "canonical-workspace" }
				: null,
		getRemoteWorkspaceIds: () => new Set(options.remoteIds ?? []),
		reconcileBindings:
			options.reconcile ?? (() => ({ removedBindings: 0, warnings: [] })),
	};
}

describe("trusted startup app-state reconciliation", () => {
	test("main awaits state reconciliation and startup ingestion before terminal restoration", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "..", "index.ts"),
			"utf8",
		);
		const initIndex = source.indexOf("await initAppState();");
		const watcherIndex = source.indexOf("await startAppStateWatcher();");
		const restoreIndex = source.indexOf("await reconcileServiceSessions();");

		expect(initIndex).toBeGreaterThan(-1);
		expect(watcherIndex).toBeGreaterThan(initIndex);
		expect(restoreIndex).toBeGreaterThan(watcherIndex);
	});

	test("keeps a valid local durable pane and its matching binding", () => {
		const reconcileBindings = mock(
			(_input: AppStateBindingReconciliationInput) => ({ removedBindings: 0 }),
		);
		const state = stateWithPane({
			writerDeviceId: "local-device",
			workspaceId: "local-workspace",
			canonical: "canonical-workspace",
		});

		const result = prepareAppStateForStartup({
			state,
			trust: "trusted",
			localDeviceId: "local-device",
			dependencies: dependencies({ reconcile: reconcileBindings }),
		});

		expect(result.outcome.status).toBe("completed");
		expect(result.startupPeerPaneIds).toEqual([]);
		expect(result.startupPeerClaudeSessionHandoffs).toEqual([]);
		expect(result.state.tabsState.tabs[0]?.workspaceId).toBe("local-workspace");
		expect(reconcileBindings).toHaveBeenCalledWith({
			stateTrust: "trusted",
			durablePanes: [
				{
					paneId: "pane-1",
					provider: "claude",
					workspaceId: "local-workspace",
				},
			],
			unresolvedWorkspaceIds: new Set(),
		});
	});

	test("localizes peer workspace IDs before coordinator hydration without bumping clocks", () => {
		const reconcileBindings = mock(
			(_input: AppStateBindingReconciliationInput) => ({ removedBindings: 0 }),
		);
		const state = stateWithPane({
			writerDeviceId: "peer-device",
			workspaceId: "peer-workspace",
			canonical: "canonical-workspace",
		});
		state.sync.paneClaudeSessions["pane-1"] = "session-123";
		const originalClocks = structuredClone(state.sync.perWorkspaceWrittenAt);

		const result = prepareAppStateForStartup({
			state,
			trust: "trusted",
			localDeviceId: "local-device",
			dependencies: dependencies({
				resolve: (canonical) =>
					canonical === "canonical-workspace" ? "local-workspace" : null,
				reconcile: reconcileBindings,
			}),
		});

		expect(result.state.tabsState.tabs[0]?.workspaceId).toBe("local-workspace");
		expect(result.state.tabsState.activeTabIds).toEqual({
			"local-workspace": "tab-1",
		});
		expect(result.state.tabsState.tabHistoryStacks).toEqual({
			"local-workspace": [],
		});
		expect(result.state.sync.localToCanonical).toEqual({
			"local-workspace": "canonical-workspace",
		});
		expect(result.state.sync.deviceId).toBe("local-device");
		expect(result.state.sync.lastWrittenAt).toBe(50);
		expect(result.state.sync.perWorkspaceWrittenAt).toEqual(originalClocks);
		expect(result.startupPeerPaneIds).toEqual(["pane-1"]);
		expect(result.startupPeerClaudeSessionHandoffs).toEqual([
			{
				paneId: "pane-1",
				workspaceId: "local-workspace",
				claudeSessionId: "session-123",
			},
		]);
		expect(reconcileBindings.mock.calls[0]?.[0].durablePanes[0]).toEqual({
			paneId: "pane-1",
			provider: "claude",
			workspaceId: "local-workspace",
		});
	});

	test("removes a closed-stack-only binding from the durable pane set", () => {
		const reconcileBindings = mock((input) => ({
			removedBindings: input.durablePanes.length === 0 ? 1 : 0,
		}));
		const state = createDefaultAppState("local-device");

		const result = prepareAppStateForStartup({
			state,
			trust: "trusted",
			localDeviceId: "local-device",
			dependencies: dependencies({ reconcile: reconcileBindings }),
		});

		expect(reconcileBindings.mock.calls[0]?.[0].durablePanes).toEqual([]);
		expect(result.outcome).toEqual({
			status: "completed",
			result: { removedBindings: 1 },
		});
	});

	test("skips an unresolved peer workspace in memory while preserving bindings conservatively", () => {
		const reconcileBindings = mock((input) => ({
			preservedUnresolvedBindings: input.unresolvedWorkspaceIds?.size ?? 0,
			warnings: ["preserved"],
		}));
		const state = stateWithPane({
			writerDeviceId: "peer-device",
			workspaceId: "peer-unresolved",
			canonical: "canonical-unresolved",
		});

		const result = prepareAppStateForStartup({
			state,
			trust: "trusted",
			localDeviceId: "local-device",
			dependencies: dependencies({ reconcile: reconcileBindings }),
		});

		expect(result.state.tabsState.tabs).toEqual([]);
		expect(result.state.tabsState.panes).toEqual({});
		expect(result.startupPeerPaneIds).toEqual([]);
		expect(result.startupPeerClaudeSessionHandoffs).toEqual([]);
		expect(reconcileBindings).toHaveBeenCalledWith({
			stateTrust: "trusted",
			durablePanes: [
				{
					paneId: "pane-1",
					provider: "claude",
					workspaceId: "peer-unresolved",
				},
			],
			unresolvedWorkspaceIds: new Set(["peer-unresolved"]),
		});
		expect(result.warnings).toContain(
			"A peer workspace could not be resolved on this device.",
		);
	});

	test.each([
		"recovered" as const,
		"untrusted" as const,
	])("defers destructive cleanup for %s state", (trust) => {
		const reconcileBindings = mock(() => {
			throw new Error("must not run");
		});
		const state = stateWithPane({
			writerDeviceId: "peer-device",
			workspaceId: "peer-workspace",
			canonical: "canonical-workspace",
		});

		const result = prepareAppStateForStartup({
			state,
			trust,
			localDeviceId: "local-device",
			dependencies: dependencies({ reconcile: reconcileBindings }),
		});

		expect(result.outcome.status).toBe("deferred");
		expect(result.state).toEqual(state);
		expect(result.startupPeerPaneIds).toEqual([]);
		expect(result.startupPeerClaudeSessionHandoffs).toEqual([]);
		expect(reconcileBindings).not.toHaveBeenCalled();
	});

	test("a reconciliation error remains non-fatal after safe localization", () => {
		const state = stateWithPane({
			writerDeviceId: "peer-device",
			workspaceId: "peer-workspace",
			canonical: "canonical-workspace",
		});

		const result = prepareAppStateForStartup({
			state,
			trust: "trusted",
			localDeviceId: "local-device",
			dependencies: dependencies({
				resolve: () => "local-workspace",
				reconcile: () => {
					throw new Error("metadata unavailable");
				},
			}),
		});

		expect(result.outcome.status).toBe("failed");
		expect(result.state.tabsState.tabs[0]?.workspaceId).toBe("local-workspace");
		expect(result.startupPeerPaneIds).toEqual(["pane-1"]);
	});
});
