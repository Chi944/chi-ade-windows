import { describe, expect, test } from "bun:test";
import type { Pane } from "shared/tabs-types";
import {
	PACKAGED_SMOKE_WORKSPACE_ID,
	type PackagedSmokeBridgeDependencies,
	parsePackagedSmokeQuery,
	runPackagedSmokeBridge,
} from "./packaged-smoke-bridge";

const TOKEN = "c".repeat(64);

function query(launch: 1 | 2): string {
	return `?adePackagedSmoke=1&adePackagedSmokeLaunch=${launch}&adePackagedSmokeToken=${TOKEN}`;
}

interface Harness {
	dependencies: PackagedSmokeBridgeDependencies;
	completed: Array<Record<string, unknown>>;
	panes: Record<string, Pane>;
	getHealthCalls: () => number;
	getTabCreates: () => number;
}

function createHarness(options: { restored?: boolean } = {}): Harness {
	const panes: Record<string, Pane> = {};
	let tabId: string | null = null;
	let tabCreates = 0;
	let healthCalls = 0;
	const completed: Array<Record<string, unknown>> = [];

	if (options.restored) {
		tabId = "smoke-tab";
		for (let index = 0; index < 6; index += 1) {
			const id = `pane-${index + 1}`;
			panes[id] = {
				id,
				tabId,
				type: "terminal",
				name: "Terminal",
				...(index === 0
					? { agentRuntime: "claude", subscriptionProfilePinned: true }
					: index === 1
						? { agentRuntime: "codex", subscriptionProfilePinned: true }
						: {}),
			};
		}
	}

	const dependencies: PackagedSmokeBridgeDependencies = {
		bootErrorReported: () => false,
		waitForRendererReady: async () => {},
		waitForStateHydration: async () => {},
		getSmokeTab: () =>
			tabId
				? {
						id: tabId,
						workspaceId: PACKAGED_SMOKE_WORKSPACE_ID,
						paneIds: Object.values(panes)
							.filter((pane) => pane.tabId === tabId)
							.map((pane) => pane.id),
					}
				: null,
		getPane: (paneId) => panes[paneId],
		getDurableSmokeTab: async () =>
			tabId
				? {
						id: tabId,
						workspaceId: PACKAGED_SMOKE_WORKSPACE_ID,
						panes: Object.values(panes).map(
							({ subscriptionProfileId: _profileId, ...pane }) => pane,
						),
					}
				: null,
		createSmokeTab: (pane) => {
			tabCreates += 1;
			tabId = "smoke-tab";
			panes["pane-1"] = {
				id: "pane-1",
				tabId,
				type: "terminal",
				name: "Terminal",
				...pane,
				subscriptionProfilePinned: true,
			};
			return { tabId, paneId: "pane-1" };
		},
		addSmokePane: (currentTabId, pane) => {
			if (Object.keys(panes).length >= 6) return "";
			const id = `pane-${Object.keys(panes).length + 1}`;
			panes[id] = {
				id,
				tabId: currentTabId,
				type: "terminal",
				name: "Terminal",
				...pane,
				...(pane?.subscriptionProfileId !== undefined
					? { subscriptionProfilePinned: true }
					: {}),
			};
			return id;
		},
		waitForPersistence: async () => {},
		runHealthQuery: async () => {
			healthCalls += 1;
			return {
				generatedAt: "2026-07-16T00:00:00.000Z",
				summary: { pass: 1, warning: 0, fail: 0 },
				checks: [
					{
						id: "app-state",
						group: "state",
						label: "Application state",
						status: "pass",
						message: "valid",
					},
				],
			};
		},
		command: async (command) => {
			if (command.command === "begin") {
				return { platform: "darwin", arch: "arm64" };
			}
			completed.push(command as unknown as Record<string, unknown>);
			return { accepted: true };
		},
		selectUpdateAsset: (platform, arch) =>
			`${platform}-${arch}` === "darwin-arm64"
				? "ADE-macOS-Apple-Silicon.dmg"
				: "wrong",
	};

	return {
		dependencies,
		completed,
		panes,
		getHealthCalls: () => healthCalls,
		getTabCreates: () => tabCreates,
	};
}

describe("packaged smoke renderer query gate", () => {
	test("accepts only the dedicated query with a 256-bit token and launch", () => {
		expect(parsePackagedSmokeQuery(query(1))).toEqual({
			launch: 1,
			token: TOKEN,
		});
		for (const invalid of [
			"",
			`?adePackagedSmoke=0&adePackagedSmokeLaunch=1&adePackagedSmokeToken=${TOKEN}`,
			`?adePackagedSmoke=1&adePackagedSmokeLaunch=3&adePackagedSmokeToken=${TOKEN}`,
			"?adePackagedSmoke=1&adePackagedSmokeLaunch=1&adePackagedSmokeToken=guessable",
			`?adePackagedSmoke=1&adePackagedSmokeLaunch=1&adePackagedSmokeToken=${TOKEN}&source=eval`,
		]) {
			expect(parsePackagedSmokeQuery(invalid)).toBeNull();
		}
	});
});

describe("packaged smoke renderer assertions", () => {
	test("first launch creates six real store panes, rejects the seventh, and reports fixed checks", async () => {
		const harness = createHarness();

		await runPackagedSmokeBridge(query(1), harness.dependencies);

		expect(harness.getTabCreates()).toBe(1);
		expect(Object.keys(harness.panes)).toHaveLength(6);
		expect(harness.panes["pane-1"]).toMatchObject({
			agentRuntime: "claude",
			subscriptionProfileId: "11111111-1111-4111-8111-111111111111",
			subscriptionProfilePinned: true,
		});
		expect(harness.panes["pane-2"]).toMatchObject({
			agentRuntime: "codex",
			subscriptionProfileId: null,
			subscriptionProfilePinned: true,
		});
		expect(harness.getHealthCalls()).toBe(1);
		expect(harness.completed).toHaveLength(1);
		expect(harness.completed[0]).toEqual({
			command: "complete",
			launch: 1,
			token: TOKEN,
			checks: {
				rendererReady: true,
				bootErrorFree: true,
				stateHydrated: true,
				sixPanesCreated: true,
				seventhPaneRejected: true,
				claudeAccountMarker: true,
				codexAccountMarker: true,
				healthQueryCompleted: true,
				updateAssetSelected: true,
				statePersisted: true,
			},
		});
	});

	test("second launch verifies sanitized Claude/Codex markers from persisted state without recreating it", async () => {
		const harness = createHarness({ restored: true });

		await runPackagedSmokeBridge(query(2), harness.dependencies);

		expect(harness.getTabCreates()).toBe(0);
		expect(harness.completed).toHaveLength(1);
		expect(harness.completed[0]).toMatchObject({
			command: "complete",
			launch: 2,
			checks: {
				sixPanesCreated: true,
				seventhPaneRejected: true,
				claudeAccountMarker: true,
				codexAccountMarker: true,
				statePersisted: true,
			},
		});
	});

	test("does nothing when the renderer query is not authenticated", async () => {
		const harness = createHarness();
		await runPackagedSmokeBridge("?adePackagedSmoke=1", harness.dependencies);
		expect(harness.getTabCreates()).toBe(0);
		expect(harness.getHealthCalls()).toBe(0);
		expect(harness.completed).toHaveLength(0);
	});

	test("does not claim persistence when the durable main-process snapshot is missing", async () => {
		const harness = createHarness();
		harness.dependencies.getDurableSmokeTab = async () => null;
		await runPackagedSmokeBridge(query(1), harness.dependencies);
		expect(harness.completed[0]).toMatchObject({
			checks: { statePersisted: false },
		});
	});

	test("cannot self-certify renderer readiness before React commits", async () => {
		const harness = createHarness();
		harness.dependencies.waitForRendererReady = async () => {
			throw new Error("renderer did not commit");
		};

		await runPackagedSmokeBridge(query(1), harness.dependencies);

		expect(harness.getTabCreates()).toBe(0);
		expect(harness.completed[0]).toMatchObject({
			checks: { rendererReady: false },
		});
	});
});
