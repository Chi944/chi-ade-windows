import { EventEmitter } from "node:events";
import { join } from "node:path";
import { app, dialog, net, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { env } from "main/env.main";
import { setSkipQuitConfirmation } from "main/index";
import { prerelease } from "semver";
import {
	AUTO_UPDATE_READY_ACTION,
	AUTO_UPDATE_STATUS,
	type AutoUpdateReadyAction,
	type AutoUpdateStatus,
} from "shared/auto-update";
import { PLATFORM } from "shared/constants";
import { SUPERSET_HOME_DIR } from "./app-environment";
import { getAppStateSnapshot } from "./app-state";
import { backupLocalDatabase } from "./local-db";
import {
	createPersonalUpdateController,
	isPersonalUpdateNetworkError,
	type PersonalUpdateController,
	parsePersonalBuildIdentity,
} from "./personal-auto-updater";
import { createUpdateSnapshot } from "./recovery/update-snapshot";

const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4;
const RELEASE_REPO_OWNER = "Chi944";
const RELEASE_REPO_NAME = "chi-ade-windows";
const AUTO_UPDATE_ENABLED = true;

function isPrereleaseBuild(): boolean {
	const components = prerelease(app.getVersion());
	return components !== null && components.length > 0;
}

const IS_PRERELEASE = isPrereleaseBuild();
const IS_LEGACY_AUTO_UPDATE_PLATFORM =
	PLATFORM.IS_MAC || PLATFORM.IS_LINUX || PLATFORM.IS_WINDOWS;
const IS_PERSONAL_UPDATE_PLATFORM = PLATFORM.IS_MAC || PLATFORM.IS_WINDOWS;
const UPDATE_FEED_URL = IS_PRERELEASE
	? `https://github.com/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases/download/desktop-canary`
	: `https://github.com/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases/latest/download`;

export interface AutoUpdateStatusEvent {
	status: AutoUpdateStatus;
	version?: string;
	error?: string;
	progress?: number;
	readyAction?: AutoUpdateReadyAction;
}

export const autoUpdateEmitter = new EventEmitter();

let currentStatus: AutoUpdateStatus = AUTO_UPDATE_STATUS.IDLE;
let currentVersion: string | undefined;
let currentError: string | undefined;
let currentProgress: number | undefined;
let currentReadyAction: AutoUpdateReadyAction | undefined;
let personalController: PersonalUpdateController | undefined;

function emitStatus(
	status: AutoUpdateStatus,
	version?: string,
	error?: string,
	progress?: number,
	readyAction?: AutoUpdateReadyAction,
): void {
	currentStatus = status;
	currentVersion = version;
	currentError = error;
	currentProgress = progress;
	currentReadyAction = readyAction;
	autoUpdateEmitter.emit("status-changed", {
		status,
		...(version !== undefined ? { version } : {}),
		...(error !== undefined ? { error } : {}),
		...(progress !== undefined ? { progress } : {}),
		...(readyAction !== undefined ? { readyAction } : {}),
	} satisfies AutoUpdateStatusEvent);
}

export function getUpdateStatus(): AutoUpdateStatusEvent {
	return {
		status: currentStatus,
		...(currentVersion !== undefined ? { version: currentVersion } : {}),
		...(currentError !== undefined ? { error: currentError } : {}),
		...(currentProgress !== undefined ? { progress: currentProgress } : {}),
		...(currentReadyAction !== undefined
			? { readyAction: currentReadyAction }
			: {}),
	};
}

export async function downloadUpdate(): Promise<void> {
	if (personalController) {
		await personalController.download();
		return;
	}
	if (!AUTO_UPDATE_ENABLED || env.NODE_ENV === "development") {
		console.info("[auto-updater] Download skipped outside a packaged build");
		return;
	}
	if (currentStatus !== AUTO_UPDATE_STATUS.AVAILABLE) {
		console.info(
			`[auto-updater] Download ignored while status is ${currentStatus}`,
		);
		return;
	}

	emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, currentVersion, undefined, 0);
	try {
		await autoUpdater.downloadUpdate();
	} catch (error) {
		console.error("[auto-updater] Failed to download update:", error);
		emitStatus(
			AUTO_UPDATE_STATUS.ERROR,
			currentVersion,
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function installUpdate(): Promise<void> {
	if (personalController) {
		await personalController.install();
		return;
	}
	if (!AUTO_UPDATE_ENABLED || env.NODE_ENV === "development") {
		console.info("[auto-updater] Install skipped in dev mode");
		emitStatus(AUTO_UPDATE_STATUS.IDLE);
		return;
	}
	if (currentStatus !== AUTO_UPDATE_STATUS.READY) {
		console.info(
			`[auto-updater] Install ignored while status is ${currentStatus}`,
		);
		return;
	}
	setSkipQuitConfirmation();
	autoUpdater.quitAndInstall(false, true);
}

export function dismissUpdate(): void {
	if (personalController) {
		personalController.dismiss();
		return;
	}
	emitStatus(AUTO_UPDATE_STATUS.IDLE);
}

export function checkForUpdates(): void {
	if (personalController) {
		void personalController.check();
		return;
	}
	if (
		!AUTO_UPDATE_ENABLED ||
		env.NODE_ENV === "development" ||
		!IS_LEGACY_AUTO_UPDATE_PLATFORM
	) {
		return;
	}
	if (
		currentStatus === AUTO_UPDATE_STATUS.CHECKING ||
		currentStatus === AUTO_UPDATE_STATUS.DOWNLOADING
	) {
		return;
	}
	if (currentStatus === AUTO_UPDATE_STATUS.READY) {
		emitStatus(currentStatus, currentVersion, undefined, currentProgress);
		return;
	}
	emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	autoUpdater.checkForUpdates().catch((error) => {
		if (isPersonalUpdateNetworkError(error)) {
			console.info("[auto-updater] Network unavailable, will retry later");
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			return;
		}
		console.error("[auto-updater] Failed to check for updates:", error);
		emitStatus(
			AUTO_UPDATE_STATUS.ERROR,
			undefined,
			error instanceof Error ? error.message : String(error),
		);
	});
}

export function checkForUpdatesInteractive(): void {
	if (personalController) {
		void personalController.check({ interactive: true });
		return;
	}
	if (!AUTO_UPDATE_ENABLED) {
		void dialog.showMessageBox({
			type: "info",
			title: "Updates",
			message: "Auto-updates are not enabled for this build.",
		});
		return;
	}
	if (env.NODE_ENV === "development") {
		void dialog.showMessageBox({
			type: "info",
			title: "Updates",
			message: "Auto-updates are disabled in development mode.",
		});
		return;
	}
	if (!IS_LEGACY_AUTO_UPDATE_PLATFORM) {
		void dialog.showMessageBox({
			type: "info",
			title: "Updates",
			message: "Auto-updates are not available on this platform.",
		});
		return;
	}
	if (
		currentStatus === AUTO_UPDATE_STATUS.CHECKING ||
		currentStatus === AUTO_UPDATE_STATUS.DOWNLOADING
	) {
		return;
	}
	if (currentStatus === AUTO_UPDATE_STATUS.READY) {
		emitStatus(currentStatus, currentVersion, undefined, currentProgress);
		return;
	}

	emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			if (
				!result?.updateInfo ||
				result.updateInfo.version === app.getVersion()
			) {
				emitStatus(AUTO_UPDATE_STATUS.IDLE);
				void dialog.showMessageBox({
					type: "info",
					title: "No Updates",
					message: "You're up to date!",
					detail: `Version ${app.getVersion()} is the latest version.`,
				});
			}
		})
		.catch((error) => {
			if (isPersonalUpdateNetworkError(error)) {
				console.info("[auto-updater] Network unavailable");
				emitStatus(AUTO_UPDATE_STATUS.IDLE);
				return;
			}
			console.error("[auto-updater] Failed to check for updates:", error);
			emitStatus(
				AUTO_UPDATE_STATUS.ERROR,
				undefined,
				error instanceof Error ? error.message : String(error),
			);
			void dialog.showMessageBox({
				type: "error",
				title: "Update Error",
				message: "Failed to check for updates. Please try again later.",
			});
		});
}

export function simulateUpdateReady(): void {
	if (env.NODE_ENV !== "development") return;
	emitStatus(
		AUTO_UPDATE_STATUS.READY,
		"99.0.0-test",
		undefined,
		undefined,
		AUTO_UPDATE_READY_ACTION.INSTALL_AND_RESTART,
	);
}

export function simulateUpdateAvailable(): void {
	if (env.NODE_ENV !== "development") return;
	emitStatus(AUTO_UPDATE_STATUS.AVAILABLE, "99.0.0-test");
}

export function simulateDownloading(): void {
	if (env.NODE_ENV !== "development") return;
	emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, "99.0.0-test");
}

export function simulateError(): void {
	if (env.NODE_ENV !== "development") return;
	emitStatus(
		AUTO_UPDATE_STATUS.ERROR,
		undefined,
		"Simulated error for testing",
	);
}

function scheduleUpdateChecks(): void {
	const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
	interval.unref();
	if (app.isReady()) {
		checkForUpdates();
	} else {
		app
			.whenReady()
			.then(() => checkForUpdates())
			.catch((error) => {
				console.error("[auto-updater] Failed to start update checks:", error);
			});
	}
}

function setupPersonalUpdater(buildNumber: number): void {
	personalController = createPersonalUpdateController({
		installedVersion: app.getVersion(),
		installedBuildNumber: buildNumber,
		platform: process.platform,
		arch: process.arch,
		updatesDirectory: join(SUPERSET_HOME_DIR, "updates"),
		fetch: net.fetch.bind(net) as typeof globalThis.fetch,
		confirm: async ({ version, buildNumber: availableBuild, name }) => {
			const result = await dialog.showMessageBox({
				type: "warning",
				title: "Open verified ADE installer?",
				message: `Open ADE ${version} installer?`,
				detail: [
					`${name} passed ADE's size and SHA-256 checks.`,
					`Build ${availableBuild} is unsigned, so Windows or macOS may show a publisher warning.`,
					"ADE will create a local recovery snapshot before opening it. The installer will not run automatically.",
				].join("\n\n"),
				buttons: ["Open Installer", "Cancel"],
				defaultId: 1,
				cancelId: 1,
				noLink: true,
			});
			return result.response === 0;
		},
		createSnapshot: async () => {
			await createUpdateSnapshot({
				recoveryDirectory: join(SUPERSET_HOME_DIR, "recovery", "updates"),
				backupDatabase: backupLocalDatabase,
				getAppStateSnapshot,
			});
		},
		openPath: (path) => shell.openPath(path),
		showUpToDate: async () => {
			await dialog.showMessageBox({
				type: "info",
				title: "No Updates",
				message: "You're up to date!",
				detail: `Version ${app.getVersion()} is the latest available personal build.`,
			});
		},
		onStatus: (event) =>
			emitStatus(
				event.status,
				event.version,
				event.error,
				event.progress,
				event.readyAction,
			),
	});
	console.info(
		`[auto-updater] Initialized verified personal channel: version=${app.getVersion()}, build=${buildNumber}`,
	);
	scheduleUpdateChecks();
}

function setupLegacyUpdater(): void {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.disableDifferentialDownload = false;
	if (PLATFORM.IS_MAC) autoUpdater.channel = `latest-${process.arch}`;
	autoUpdater.allowDowngrade = IS_PRERELEASE;
	autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });

	autoUpdater.on("error", (error) => {
		if (isPersonalUpdateNetworkError(error)) {
			console.info("[auto-updater] Network unavailable, will retry later");
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			return;
		}
		console.error("[auto-updater] Error during update:", error);
		emitStatus(
			AUTO_UPDATE_STATUS.ERROR,
			undefined,
			error instanceof Error ? error.message : String(error),
		);
	});
	autoUpdater.on("checking-for-update", () => {
		emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	});
	autoUpdater.on("update-available", (info) => {
		emitStatus(AUTO_UPDATE_STATUS.AVAILABLE, info.version);
	});
	autoUpdater.on("update-not-available", () => {
		emitStatus(AUTO_UPDATE_STATUS.IDLE);
	});
	autoUpdater.on("download-progress", (progress) => {
		emitStatus(
			AUTO_UPDATE_STATUS.DOWNLOADING,
			currentVersion,
			undefined,
			progress.percent,
		);
	});
	autoUpdater.on("update-downloaded", (info) => {
		emitStatus(
			AUTO_UPDATE_STATUS.READY,
			info.version,
			undefined,
			undefined,
			AUTO_UPDATE_READY_ACTION.INSTALL_AND_RESTART,
		);
	});

	console.info(
		`[auto-updater] Initialized signed channel: version=${app.getVersion()}, channel=${IS_PRERELEASE ? "canary" : "stable"}, feedURL=${UPDATE_FEED_URL}`,
	);
	scheduleUpdateChecks();
}

export function setupAutoUpdater(): void {
	if (!AUTO_UPDATE_ENABLED || !app.isPackaged) return;
	let personalBuild: ReturnType<typeof parsePersonalBuildIdentity>;
	try {
		personalBuild = parsePersonalBuildIdentity(
			process.env.ADE_BUILD_SHA,
			process.env.ADE_BUILD_NUMBER,
		);
	} catch (error) {
		emitStatus(
			AUTO_UPDATE_STATUS.ERROR,
			undefined,
			error instanceof Error ? error.message : String(error),
		);
		return;
	}

	if (personalBuild) {
		if (!IS_PERSONAL_UPDATE_PLATFORM) {
			emitStatus(
				AUTO_UPDATE_STATUS.ERROR,
				undefined,
				`Unsupported personal update platform: ${process.platform}-${process.arch}`,
			);
			return;
		}
		setupPersonalUpdater(personalBuild.buildNumber);
		return;
	}

	if (!IS_LEGACY_AUTO_UPDATE_PLATFORM) return;
	setupLegacyUpdater();
}
