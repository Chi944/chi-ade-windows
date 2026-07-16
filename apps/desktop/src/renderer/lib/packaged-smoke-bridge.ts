import type { HealthReport } from "main/lib/diagnostics/health";
import type {
	PackagedSmokeChecks,
	PackagedSmokeCommand,
} from "main/lib/packaged-smoke";
import {
	parsePersonalUpdateManifest,
	selectPersonalUpdateAsset,
} from "shared/personal-update";
import type { Pane } from "shared/tabs-types";

export const PACKAGED_SMOKE_WORKSPACE_ID = "ade-packaged-smoke-workspace";
const CLAUDE_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const EXPECTED_QUERY_KEYS = [
	"adePackagedSmoke",
	"adePackagedSmokeLaunch",
	"adePackagedSmokeToken",
] as const;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const HYDRATION_TIMEOUT_MS = 20_000;

const smokeUpdateManifest = parsePersonalUpdateManifest({
	schemaVersion: 1,
	version: "1.0.0",
	buildNumber: 1,
	commitSha: "0".repeat(40),
	publishedAt: "2026-07-16T00:00:00.000Z",
	releaseNotesUrl:
		"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
	assets: {
		"win32-x64": {
			name: "ADE-Windows-x64.exe",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
			size: 1,
			sha256: "1".repeat(64),
		},
		"darwin-arm64": {
			name: "ADE-macOS-Apple-Silicon.dmg",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg",
			size: 1,
			sha256: "2".repeat(64),
		},
		"darwin-x64": {
			name: "ADE-macOS-Intel.dmg",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg",
			size: 1,
			sha256: "3".repeat(64),
		},
	},
});

export interface PackagedSmokeQuery {
	launch: 1 | 2;
	token: string;
}

export interface SmokeTabView {
	id: string;
	workspaceId: string;
	paneIds: string[];
}

export interface DurableSmokeTabView {
	id: string;
	workspaceId: string;
	panes: Pane[];
}

type SmokePaneOptions = Pick<Pane, "agentRuntime" | "subscriptionProfileId">;

export interface PackagedSmokeBridgeDependencies {
	bootErrorReported: () => boolean;
	waitForRendererReady: () => Promise<void>;
	waitForStateHydration: () => Promise<void>;
	getSmokeTab: () => SmokeTabView | null;
	getPane: (paneId: string) => Pane | undefined;
	getDurableSmokeTab: () => Promise<DurableSmokeTabView | null>;
	createSmokeTab: (pane: SmokePaneOptions) => {
		tabId: string;
		paneId: string;
	};
	addSmokePane: (tabId: string, pane?: SmokePaneOptions) => string;
	waitForPersistence: () => Promise<void>;
	runHealthQuery: () => Promise<HealthReport>;
	command: (
		command: PackagedSmokeCommand,
	) => Promise<{ platform: string; arch: string } | { accepted: true }>;
	selectUpdateAsset: (platform: string, arch: string) => string;
}

export function parsePackagedSmokeQuery(
	search: string,
): PackagedSmokeQuery | null {
	const parameters = new URLSearchParams(search);
	const keys = [...parameters.keys()].sort();
	if (
		keys.length !== EXPECTED_QUERY_KEYS.length ||
		keys.some((key, index) => key !== [...EXPECTED_QUERY_KEYS].sort()[index])
	) {
		return null;
	}
	const token = parameters.get("adePackagedSmokeToken");
	const launch = parameters.get("adePackagedSmokeLaunch");
	if (
		parameters.get("adePackagedSmoke") !== "1" ||
		!token ||
		!TOKEN_PATTERN.test(token) ||
		(launch !== "1" && launch !== "2")
	) {
		return null;
	}
	return { launch: launch === "1" ? 1 : 2, token };
}

function emptyChecks(): PackagedSmokeChecks {
	return {
		rendererReady: false,
		bootErrorFree: false,
		stateHydrated: false,
		sixPanesCreated: false,
		seventhPaneRejected: false,
		claudeAccountMarker: false,
		codexAccountMarker: false,
		healthQueryCompleted: false,
		updateAssetSelected: false,
		statePersisted: false,
	};
}

function expectedAssetName(platform: string, arch: string): string | null {
	const names: Record<string, string> = {
		"win32-x64": "ADE-Windows-x64.exe",
		"darwin-arm64": "ADE-macOS-Apple-Silicon.dmg",
		"darwin-x64": "ADE-macOS-Intel.dmg",
	};
	return names[`${platform}-${arch}`] ?? null;
}

function providerMarkers(panes: readonly Pane[], restored: boolean) {
	const claude = panes.find((pane) => pane.agentRuntime === "claude");
	const codex = panes.find((pane) => pane.agentRuntime === "codex");
	return {
		claude:
			claude?.subscriptionProfilePinned === true &&
			(restored
				? claude.subscriptionProfileId === undefined
				: claude.subscriptionProfileId === CLAUDE_PROFILE_ID),
		codex:
			codex?.subscriptionProfilePinned === true &&
			(restored
				? codex.subscriptionProfileId === undefined
				: codex.subscriptionProfileId === null),
	};
}

function durableStateMatches(tab: DurableSmokeTabView | null): boolean {
	if (
		!tab ||
		tab.workspaceId !== PACKAGED_SMOKE_WORKSPACE_ID ||
		tab.panes.length !== 6
	) {
		return false;
	}
	const markers = providerMarkers(tab.panes, true);
	return markers.claude && markers.codex;
}

export async function runPackagedSmokeBridge(
	search: string,
	dependencies: PackagedSmokeBridgeDependencies,
): Promise<void> {
	const query = parsePackagedSmokeQuery(search);
	if (!query) return;

	const checks = emptyChecks();
	let begun = false;
	try {
		const runtime = await dependencies.command({
			command: "begin",
			launch: query.launch,
			token: query.token,
		});
		begun = true;
		if (!("platform" in runtime)) throw new Error("runtime unavailable");

		await dependencies.waitForRendererReady();
		checks.rendererReady = true;
		await dependencies.waitForStateHydration();
		checks.stateHydrated = true;

		let smokeTab = dependencies.getSmokeTab();
		if (query.launch === 1) {
			if (smokeTab) throw new Error("unexpected existing smoke state");
			const created = dependencies.createSmokeTab({
				agentRuntime: "claude",
				subscriptionProfileId: CLAUDE_PROFILE_ID,
			});
			dependencies.addSmokePane(created.tabId, {
				agentRuntime: "codex",
				subscriptionProfileId: null,
			});
			for (let index = 0; index < 4; index += 1) {
				dependencies.addSmokePane(created.tabId);
			}
			smokeTab = dependencies.getSmokeTab();
		}

		if (!smokeTab) throw new Error("smoke state unavailable");
		const livePanes = smokeTab.paneIds.flatMap((paneId) => {
			const pane = dependencies.getPane(paneId);
			return pane ? [pane] : [];
		});
		checks.sixPanesCreated =
			smokeTab.workspaceId === PACKAGED_SMOKE_WORKSPACE_ID &&
			livePanes.length === 6;
		checks.seventhPaneRejected = dependencies.addSmokePane(smokeTab.id) === "";
		const markers = providerMarkers(livePanes, query.launch === 2);
		checks.claudeAccountMarker = markers.claude;
		checks.codexAccountMarker = markers.codex;

		await dependencies.waitForPersistence();
		checks.statePersisted = durableStateMatches(
			await dependencies.getDurableSmokeTab(),
		);

		const health = await dependencies.runHealthQuery();
		checks.healthQueryCompleted =
			Array.isArray(health.checks) &&
			typeof health.generatedAt === "string" &&
			typeof health.summary === "object";

		const expectedAsset = expectedAssetName(runtime.platform, runtime.arch);
		checks.updateAssetSelected =
			expectedAsset !== null &&
			dependencies.selectUpdateAsset(runtime.platform, runtime.arch) ===
				expectedAsset;
		checks.bootErrorFree = !dependencies.bootErrorReported();
	} catch {
		// Fixed booleans are the complete failure surface; never send exception text.
	} finally {
		if (begun) {
			await dependencies.command({
				command: "complete",
				launch: query.launch,
				token: query.token,
				checks,
			});
		}
	}
}

type SmokeClient = {
	packagedSmoke: {
		command: {
			mutate: PackagedSmokeBridgeDependencies["command"];
		};
	};
};

async function createDefaultDependencies(): Promise<PackagedSmokeBridgeDependencies> {
	const [
		{ isBootErrorReported },
		{ electronTrpcClient },
		persistence,
		{ waitForRendererCommit },
		tabs,
	] = await Promise.all([
		import("renderer/lib/boot-errors"),
		import("renderer/lib/trpc-client"),
		import("renderer/lib/trpc-storage"),
		import("renderer/lib/renderer-ready"),
		import("renderer/stores/tabs/store"),
	]);
	const { useTabsStore } = tabs;

	const waitForHydration = async (): Promise<void> => {
		if (useTabsStore.persist.hasHydrated()) return;
		await new Promise<void>((resolve, reject) => {
			let unsubscribe = () => {};
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error("state hydration timed out"));
			}, HYDRATION_TIMEOUT_MS);
			unsubscribe = useTabsStore.persist.onFinishHydration(() => {
				clearTimeout(timeout);
				unsubscribe();
				resolve();
			});
		});
	};

	const liveSmokeTab = (): SmokeTabView | null => {
		const state = useTabsStore.getState();
		const tab = state.tabs.find(
			(candidate) => candidate.workspaceId === PACKAGED_SMOKE_WORKSPACE_ID,
		);
		if (!tab) return null;
		return {
			id: tab.id,
			workspaceId: tab.workspaceId,
			paneIds: Object.values(state.panes)
				.filter((pane) => pane.tabId === tab.id)
				.map((pane) => pane.id),
		};
	};

	return {
		bootErrorReported: isBootErrorReported,
		waitForRendererReady: waitForRendererCommit,
		waitForStateHydration: waitForHydration,
		getSmokeTab: liveSmokeTab,
		getPane: (paneId) => useTabsStore.getState().panes[paneId],
		getDurableSmokeTab: async () => {
			const state = await electronTrpcClient.uiState.tabs.get.query();
			const tab = state.tabs.find(
				(candidate) => candidate.workspaceId === PACKAGED_SMOKE_WORKSPACE_ID,
			);
			if (!tab) return null;
			return {
				id: tab.id,
				workspaceId: tab.workspaceId,
				panes: Object.values(state.panes).filter(
					(pane) => pane.tabId === tab.id,
				),
			};
		},
		createSmokeTab: (pane) =>
			useTabsStore.getState().addTab(PACKAGED_SMOKE_WORKSPACE_ID, pane),
		addSmokePane: (tabId, pane) => useTabsStore.getState().addPane(tabId, pane),
		waitForPersistence: persistence.waitForTabsPersistenceIdle,
		runHealthQuery: () => electronTrpcClient.diagnostics.run.query(),
		command: (command) =>
			(
				electronTrpcClient as unknown as SmokeClient
			).packagedSmoke.command.mutate(command),
		selectUpdateAsset: (platform, arch) =>
			selectPersonalUpdateAsset(smokeUpdateManifest, platform, arch).name,
	};
}

export async function initializePackagedSmokeBridge(
	search: string,
): Promise<void> {
	const query = parsePackagedSmokeQuery(search);
	if (!query) return;
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${window.location.hash}`,
	);
	await runPackagedSmokeBridge(search, await createDefaultDependencies());
}
