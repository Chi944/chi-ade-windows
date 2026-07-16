import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	open,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	projects,
	remoteHosts,
	remoteWorkspaceBindings,
	settings,
	workspaces,
} from "@superset/local-db";
import { app, dialog, Notification, net, shell } from "electron";
import { findRealBinariesAsync } from "main/lib/agent-setup/utils";
import { APP_STATE_PATH, SUPERSET_HOME_DIR } from "main/lib/app-environment";
import {
	getAppStateSnapshot,
	getDeviceId,
	initAppState,
} from "main/lib/app-state";
import { parseAppStateJson } from "main/lib/app-state/validation";
import { getCustomRingtonePath } from "main/lib/custom-ringtones";
import {
	markRendererReady,
	prepareNormalModeRetry,
} from "main/lib/diagnostics/boot-state";
import { inspectCrashDumpStorage } from "main/lib/diagnostics/crash-storage";
import {
	createDiagnosticsExport,
	exportDiagnostics,
	fetchHealthUpdateManifest,
	type HealthCheckDependencies,
	readStateShapeBestEffort,
	runHealthChecks,
	type StateShapeSummary,
} from "main/lib/diagnostics/health";
import {
	ensurePrivateDiagnosticsDirectory,
	logHealthOperation,
	readRecentDiagnosticEntries,
	resolveDiagnosticsCrashDirectory,
	resolveDiagnosticsDirectory,
	resolveDiagnosticsLogDirectory,
} from "main/lib/diagnostics/logger";
import { resolveLocalPrivateRoot } from "main/lib/diagnostics/private-root";
import { summarizeProviderBindingHealth } from "main/lib/diagnostics/provider-binding-health";
import {
	getRecoveryStatus,
	resetAppStateWithBackup,
	restoreLatestAppStateSnapshot,
} from "main/lib/diagnostics/recovery";
import { inspectUpdateStorage } from "main/lib/diagnostics/update-storage-health";
import { localDb } from "main/lib/local-db";
import { checkSqliteDatabaseIntegrity } from "main/lib/local-db/integrity";
import { getSoundPath } from "main/lib/sound-paths";
import {
	getSubscriptionProfilePaneBinding,
	listSubscriptionProfiles,
} from "main/lib/subscription-profiles";
import {
	CUSTOM_RINGTONE_ID,
	DEFAULT_RINGTONE_ID,
	getRingtoneFilename,
} from "shared/ringtones";
import type { RecoveryConfirmationOperation } from ".";

const PRIVATE_FILE_MODE = 0o600;
const DIAGNOSTIC_EVENT_LIMIT = 100;

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function localPrivateRoot(): string {
	return resolveLocalPrivateRoot({ adeHomeDir: SUPERSET_HOME_DIR });
}

async function canWritePath(path: string): Promise<boolean> {
	await access(path, constants.W_OK);
	const probePath = join(
		path,
		`.ade-health-${process.pid}-${randomUUID()}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(probePath, "wx", PRIVATE_FILE_MODE);
		await handle.writeFile("health\n", "utf8");
		await handle.sync();
		return true;
	} finally {
		await handle?.close().catch(() => undefined);
		await unlink(probePath).catch((error) => {
			if (!isMissing(error)) throw error;
		});
	}
}

async function commandAvailable(command: string): Promise<boolean> {
	return (await findRealBinariesAsync(command)).length > 0;
}

async function readAppStateHealth() {
	const state = parseAppStateJson(await readFile(APP_STATE_PATH, "utf8"), {
		deviceId: getDeviceId(),
	});
	return {
		valid: true,
		workspaceCount: Object.keys(state.tabsState.activeTabIds).length,
		paneCount: Object.keys(state.tabsState.panes).length,
		tabCount: state.tabsState.tabs.length,
	};
}

async function readDatabaseHealth() {
	try {
		const integrity = checkSqliteDatabaseIntegrity(localDb.$client);
		if (!integrity.ok) {
			return {
				integrity: "corrupt" as const,
				projectCount: 0,
				workspaceCount: 0,
			};
		}
		return {
			integrity: "ok" as const,
			projectCount: localDb.select().from(projects).all().length,
			workspaceCount: localDb.select().from(workspaces).all().length,
		};
	} catch {
		return {
			integrity: "unavailable" as const,
			projectCount: 0,
			workspaceCount: 0,
		};
	}
}

async function readProviderBindingHealth() {
	const accounts = listSubscriptionProfiles();
	const state = getAppStateSnapshot();
	const loadResult = await initAppState();
	const workspaceIdByTabId = new Map(
		state.tabsState.tabs.map((tab) => [tab.id, tab.workspaceId] as const),
	);
	const remoteWorkspaceIds = new Set(
		localDb
			.select({ workspaceId: remoteWorkspaceBindings.workspaceId })
			.from(remoteWorkspaceBindings)
			.all()
			.map(({ workspaceId }) => workspaceId),
	);
	const panes = Object.values(state.tabsState.panes).flatMap((pane) => {
		if (
			pane.type !== "terminal" ||
			(pane.agentRuntime !== "claude" && pane.agentRuntime !== "codex")
		) {
			return [];
		}
		const workspaceId = workspaceIdByTabId.get(pane.tabId);
		return [
			{
				id: pane.id,
				provider: pane.agentRuntime,
				workspaceId,
				pinned: pane.subscriptionProfilePinned === true,
				needsRebind: pane.subscriptionProfileNeedsRebind === true,
				remote: Boolean(workspaceId && remoteWorkspaceIds.has(workspaceId)),
			},
		];
	});
	return summarizeProviderBindingHealth({
		accountCount: accounts.profiles.length,
		panes,
		reconciliation: loadResult.reconciliation,
		readBinding: async ({ provider, paneId, workspaceId }) =>
			getSubscriptionProfilePaneBinding(provider, paneId, workspaceId) !== null,
	});
}

function selectedSoundPath(selectedId: string | null | undefined): string {
	if (selectedId === CUSTOM_RINGTONE_ID) {
		return (
			getCustomRingtonePath() ??
			getSoundPath(getRingtoneFilename(DEFAULT_RINGTONE_ID))
		);
	}
	const filename = getRingtoneFilename(selectedId ?? DEFAULT_RINGTONE_ID);
	return getSoundPath(filename || getRingtoneFilename(DEFAULT_RINGTONE_ID));
}

async function readNotificationHealth() {
	const row = localDb.select().from(settings).get();
	let selectedSoundReadable = false;
	try {
		await access(selectedSoundPath(row?.selectedRingtoneId), constants.R_OK);
		selectedSoundReadable = true;
	} catch {
		selectedSoundReadable = false;
	}
	return {
		supported: Notification.isSupported(),
		muted: row?.notificationSoundsMuted ?? false,
		selectedSoundReadable,
	};
}

async function readRemoteHostHealth() {
	const hosts = localDb.select().from(remoteHosts).all();
	const workspaceRows = localDb.select().from(workspaces).all();
	const bindings = localDb.select().from(remoteWorkspaceBindings).all();
	const hostIds = new Set(hosts.map((host) => host.id));
	const workspaceIds = new Set(workspaceRows.map((workspace) => workspace.id));
	const inconsistentCount = bindings.filter(
		(binding) =>
			!hostIds.has(binding.remoteHostId) ||
			!workspaceIds.has(binding.workspaceId) ||
			!Array.isArray(binding.portForwards),
	).length;
	return {
		hostCount: hosts.length,
		bindingCount: bindings.length,
		inconsistentCount,
	};
}

async function fetchUpdateManifest(): Promise<unknown> {
	return fetchHealthUpdateManifest({
		fetch: net.fetch.bind(net) as typeof globalThis.fetch,
	});
}

async function readDirectoryEntries(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
}

async function readStorageHealth() {
	const privateRoot = localPrivateRoot();
	const logDirectory = resolveDiagnosticsLogDirectory(privateRoot);
	const logEntries = (await readDirectoryEntries(logDirectory)).filter(
		(entry) => entry.isFile() && /^ade(?:\.\d+)?\.jsonl$/.test(entry.name),
	);
	const logSizes = await Promise.all(
		logEntries.map(
			async (entry) => (await stat(join(logDirectory, entry.name))).size,
		),
	);
	const recovery = await getRecoveryStatus();
	const crashStorage = inspectCrashDumpStorage(
		resolveDiagnosticsCrashDirectory(privateRoot),
	);
	const updateStorage = await inspectUpdateStorage(
		join(SUPERSET_HOME_DIR, "updates"),
	);
	return {
		diagnosticLogCount: logEntries.length,
		diagnosticLogBytes: logSizes.reduce((total, size) => total + size, 0),
		...crashStorage,
		appStateSnapshotCount: recovery.appStateSnapshotCount,
		databaseSnapshotCount: recovery.databaseSnapshotCount,
		...updateStorage,
	};
}

async function readRecoveryHealth() {
	const conflictPath = join(
		localPrivateRoot(),
		"provider-accounts-legacy-recovery",
	);
	try {
		await access(conflictPath, constants.F_OK);
		return { pendingConflictCount: 1 };
	} catch (error) {
		if (isMissing(error)) return { pendingConflictCount: 0 };
		throw error;
	}
}

function defaultHealthDependencies(): HealthCheckDependencies {
	return {
		platform: process.platform,
		arch: process.arch,
		paths: {
			syncRoot: SUPERSET_HOME_DIR,
			privateRoot: localPrivateRoot(),
		},
		now: () => new Date(),
		canWritePath,
		readAppStateHealth,
		readDatabaseHealth,
		commandAvailable,
		readProviderBindingHealth,
		readNotificationHealth,
		readRemoteHostHealth,
		fetchUpdateManifest,
		readStorageHealth,
		readRecoveryHealth,
	};
}

export async function runDefaultHealthChecks() {
	logHealthOperation("run", "started");
	try {
		const report = await runHealthChecks(defaultHealthDependencies());
		logHealthOperation(
			"run",
			report.summary.fail > 0
				? "failed"
				: report.summary.warning > 0
					? "warning"
					: "succeeded",
			{ summary: report.summary },
		);
		return report;
	} catch (error) {
		logHealthOperation("run", "failed", { error });
		throw error;
	}
}

function currentStateShape(): StateShapeSummary {
	return readStateShapeBestEffort({
		projectCount: () => localDb.select().from(projects).all().length,
		workspaceCount: () => localDb.select().from(workspaces).all().length,
		tabCount: () => getAppStateSnapshot().tabsState.tabs.length,
		paneCount: () => Object.keys(getAppStateSnapshot().tabsState.panes).length,
		accountCount: () => listSubscriptionProfiles().profiles.length,
		remoteHostCount: () => localDb.select().from(remoteHosts).all().length,
	});
}

function embeddedBuildNumber(): number | undefined {
	const value = process.env.ADE_BUILD_NUMBER;
	if (!value || !/^[0-9]+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function createDefaultBundle() {
	const privateRoot = localPrivateRoot();
	const [report, recentLogs, storage] = await Promise.all([
		runDefaultHealthChecks(),
		readRecentDiagnosticEntries({
			directory: resolveDiagnosticsLogDirectory(privateRoot),
			limit: DIAGNOSTIC_EVENT_LIMIT,
			homePaths: [SUPERSET_HOME_DIR, privateRoot],
		}).catch(() => []),
		readStorageHealth().catch(() => undefined),
	]);
	return createDiagnosticsExport({
		report,
		app: {
			version: app.getVersion(),
			buildNumber: embeddedBuildNumber(),
			commitSha: process.env.ADE_BUILD_SHA,
			platform: process.platform,
			arch: process.arch,
		},
		stateShape: currentStateShape(),
		storage,
		paths: { syncRoot: SUPERSET_HOME_DIR, privateRoot },
		recentLogs,
		now: () => new Date(),
	});
}

export async function exportDefaultDiagnostics() {
	logHealthOperation("export", "started");
	try {
		const result = await exportDiagnostics({
			chooseDestination: async () => {
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				const selection = await dialog.showSaveDialog({
					title: "Export ADE diagnostics",
					defaultPath: `ADE-diagnostics-${timestamp}.json`,
					filters: [{ name: "JSON", extensions: ["json"] }],
				});
				return selection.canceled ? null : (selection.filePath ?? null);
			},
			createBundle: createDefaultBundle,
			writeFile: async (path, contents) => {
				await writeFile(path, contents, {
					encoding: "utf8",
					mode: PRIVATE_FILE_MODE,
				});
			},
		});
		logHealthOperation("export", result.canceled ? "cancelled" : "succeeded");
		return result;
	} catch (error) {
		logHealthOperation("export", "failed", { error });
		throw error;
	}
}

export async function markDefaultRendererReady() {
	const status = await markRendererReady();
	logHealthOperation("renderer-ready", "succeeded", {
		safeMode: status.safeMode,
		incompleteStarts: status.incompleteStarts,
	});
	return status;
}

export async function openDefaultDiagnosticsFolder(): Promise<string> {
	logHealthOperation("open-folder", "started");
	try {
		const directory = resolveDiagnosticsDirectory(localPrivateRoot());
		ensurePrivateDiagnosticsDirectory(directory);
		const error = await shell.openPath(directory);
		logHealthOperation("open-folder", error ? "failed" : "succeeded");
		return error;
	} catch (error) {
		logHealthOperation("open-folder", "failed", { error });
		throw error;
	}
}

export async function confirmDefaultRecoveryOperation(
	operation: RecoveryConfirmationOperation,
): Promise<boolean> {
	const restoring = operation === "restore-app-state";
	const result = await dialog.showMessageBox({
		type: "warning",
		title: restoring
			? "Restore application state?"
			: "Reset application state?",
		message: restoring
			? "Restore the latest verified app-state snapshot?"
			: "Reset ADE application state to safe defaults?",
		detail: restoring
			? "ADE will back up the current state before restoring. Restart ADE afterward to load the restored state."
			: "ADE will create a recovery backup before resetting. Projects and repository files are not deleted.",
		buttons: [restoring ? "Restore Snapshot" : "Reset State", "Cancel"],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
	});
	return result.response === 0;
}

export async function restoreDefaultLatestAppStateSnapshot() {
	logHealthOperation("restore-state", "started");
	try {
		const result = await restoreLatestAppStateSnapshot();
		logHealthOperation("restore-state", "succeeded");
		return result;
	} catch (error) {
		logHealthOperation("restore-state", "failed", { error });
		throw error;
	}
}

export async function resetDefaultAppStateWithBackup() {
	logHealthOperation("reset-state", "started");
	try {
		const result = await resetAppStateWithBackup();
		logHealthOperation("reset-state", "succeeded");
		return result;
	} catch (error) {
		logHealthOperation("reset-state", "failed", { error });
		throw error;
	}
}

export async function retryDefaultNormalMode() {
	logHealthOperation("retry-normal-mode", "started");
	try {
		const result = await prepareNormalModeRetry();
		logHealthOperation("retry-normal-mode", "succeeded");
		return result;
	} catch (error) {
		logHealthOperation("retry-normal-mode", "failed", { error });
		throw error;
	}
}
