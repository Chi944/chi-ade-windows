import { EventEmitter } from "node:events";
import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { env } from "main/env.main";
import { setSkipQuitConfirmation } from "main/index";
import { prerelease } from "semver";
import { AUTO_UPDATE_STATUS, type AutoUpdateStatus } from "shared/auto-update";
import { PLATFORM } from "shared/constants";

const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4; // 4 hours

// ---------------------------------------------------------------------------
// Release repo + auto-update gating
//
// The updater feed points at GitHub Releases on the PUBLIC repo. There is a
// single source of truth for the repo name below.
//
// Keep this fork identity in sync with apps/desktop/electron-builder.ts.
const RELEASE_REPO_OWNER = "Chi944";
const RELEASE_REPO_NAME = "chi-ade-windows";

// Update checks are enabled in packaged builds. Downloads and installation are
// always user initiated; see setupAutoUpdater() below.
const AUTO_UPDATE_ENABLED = true;

/**
 * Detect if this is a prerelease build from app version using semver.
 * Versions like "0.0.53-canary" have prerelease component ["canary"].
 * Stable versions like "0.0.53" have no prerelease component.
 */
function isPrereleaseBuild(): boolean {
	const version = app.getVersion();
	const prereleaseComponents = prerelease(version);
	return prereleaseComponents !== null && prereleaseComponents.length > 0;
}

const IS_PRERELEASE = isPrereleaseBuild();
const IS_AUTO_UPDATE_PLATFORM =
	PLATFORM.IS_MAC || PLATFORM.IS_LINUX || PLATFORM.IS_WINDOWS;

// Use explicit feed URLs to ensure we always fetch platform-specific manifests
// (for example latest-mac.yml, latest-linux.yml, and latest.yml) from the
// correct release.
// - Stable: fetches from /releases/latest/download/ (latest non-prerelease)
// - Canary: fetches from /releases/download/desktop-canary/ (rolling canary tag)
const UPDATE_FEED_URL = IS_PRERELEASE
	? `https://github.com/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases/download/desktop-canary`
	: `https://github.com/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases/latest/download`;

export interface AutoUpdateStatusEvent {
	status: AutoUpdateStatus;
	version?: string;
	error?: string;
	progress?: number;
}

export const autoUpdateEmitter = new EventEmitter();

// Network errors that don't need to be shown to the user
// These are transient/expected and will resolve on retry
const SILENT_ERROR_PATTERNS = [
	"net::ERR_INTERNET_DISCONNECTED",
	"net::ERR_NETWORK_CHANGED",
	"net::ERR_CONNECTION_REFUSED",
	"net::ERR_NAME_NOT_RESOLVED",
	"net::ERR_CONNECTION_TIMED_OUT",
	"net::ERR_CONNECTION_RESET",
	"ENOTFOUND",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
];

function isNetworkError(error: Error | string): boolean {
	const message = typeof error === "string" ? error : error.message;
	return SILENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

let currentStatus: AutoUpdateStatus = AUTO_UPDATE_STATUS.IDLE;
let currentVersion: string | undefined;
let currentProgress: number | undefined;
let isDismissed = false;

function emitStatus(
	status: AutoUpdateStatus,
	version?: string,
	error?: string,
	progress?: number,
): void {
	currentStatus = status;
	currentVersion = version;
	currentProgress = progress;

	if (
		isDismissed &&
		(status === AUTO_UPDATE_STATUS.AVAILABLE ||
			status === AUTO_UPDATE_STATUS.READY)
	) {
		return;
	}

	autoUpdateEmitter.emit("status-changed", {
		status,
		version,
		error,
		progress,
	});
}

export function getUpdateStatus(): AutoUpdateStatusEvent {
	if (
		isDismissed &&
		(currentStatus === AUTO_UPDATE_STATUS.AVAILABLE ||
			currentStatus === AUTO_UPDATE_STATUS.READY)
	) {
		return { status: AUTO_UPDATE_STATUS.IDLE };
	}
	return {
		status: currentStatus,
		version: currentVersion,
		progress: currentProgress,
	};
}

export function downloadUpdate(): void {
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

	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, currentVersion, undefined, 0);
	autoUpdater.downloadUpdate().catch((error) => {
		console.error("[auto-updater] Failed to download update:", error);
		emitStatus(
			AUTO_UPDATE_STATUS.ERROR,
			currentVersion,
			error instanceof Error ? error.message : String(error),
		);
	});
}

export function installUpdate(): void {
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
	// Skip confirmation dialog - quitAndInstall internally calls app.quit()
	setSkipQuitConfirmation();
	autoUpdater.quitAndInstall(false, true);
}

export function dismissUpdate(): void {
	isDismissed = true;
	autoUpdateEmitter.emit("status-changed", { status: AUTO_UPDATE_STATUS.IDLE });
}

export function checkForUpdates(): void {
	if (
		!AUTO_UPDATE_ENABLED ||
		env.NODE_ENV === "development" ||
		!IS_AUTO_UPDATE_PLATFORM
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
		isDismissed = false;
		emitStatus(currentStatus, currentVersion, undefined, currentProgress);
		return;
	}
	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	autoUpdater.checkForUpdates().catch((error) => {
		if (isNetworkError(error)) {
			console.info("[auto-updater] Network unavailable, will retry later");
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			return;
		}
		console.error("[auto-updater] Failed to check for updates:", error);
		emitStatus(AUTO_UPDATE_STATUS.ERROR, undefined, error.message);
	});
}

export function checkForUpdatesInteractive(): void {
	if (!AUTO_UPDATE_ENABLED) {
		dialog.showMessageBox({
			type: "info",
			title: "Updates",
			message: "Auto-updates are not enabled for this build.",
		});
		return;
	}
	if (env.NODE_ENV === "development") {
		dialog.showMessageBox({
			type: "info",
			title: "Updates",
			message: "Auto-updates are disabled in development mode.",
		});
		return;
	}
	if (!IS_AUTO_UPDATE_PLATFORM) {
		dialog.showMessageBox({
			type: "info",
			title: "Updates",
			message: "Auto-updates are only available on macOS, Linux, and Windows.",
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
		isDismissed = false;
		emitStatus(currentStatus, currentVersion, undefined, currentProgress);
		return;
	}

	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.CHECKING);

	autoUpdater
		.checkForUpdates()
		.then((result) => {
			if (
				!result?.updateInfo ||
				result.updateInfo.version === app.getVersion()
			) {
				emitStatus(AUTO_UPDATE_STATUS.IDLE);
				dialog.showMessageBox({
					type: "info",
					title: "No Updates",
					message: "You're up to date!",
					detail: `Version ${app.getVersion()} is the latest version.`,
				});
			}
		})
		.catch((error) => {
			if (isNetworkError(error)) {
				console.info("[auto-updater] Network unavailable");
				emitStatus(AUTO_UPDATE_STATUS.IDLE);
				dialog.showMessageBox({
					type: "info",
					title: "No Internet Connection",
					message:
						"Unable to check for updates. Please check your internet connection.",
				});
				return;
			}
			console.error("[auto-updater] Failed to check for updates:", error);
			emitStatus(AUTO_UPDATE_STATUS.ERROR, undefined, error.message);
			dialog.showMessageBox({
				type: "error",
				title: "Update Error",
				message: "Failed to check for updates. Please try again later.",
			});
		});
}

export function simulateUpdateReady(): void {
	if (env.NODE_ENV !== "development") return;
	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.READY, "99.0.0-test");
}

export function simulateUpdateAvailable(): void {
	if (env.NODE_ENV !== "development") return;
	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.AVAILABLE, "99.0.0-test");
}

export function simulateDownloading(): void {
	if (env.NODE_ENV !== "development") return;
	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, "99.0.0-test");
}

export function simulateError(): void {
	if (env.NODE_ENV !== "development") return;
	isDismissed = false;
	emitStatus(
		AUTO_UPDATE_STATUS.ERROR,
		undefined,
		"Simulated error for testing",
	);
}

export function setupAutoUpdater(): void {
	// Only runs in a packaged app on a supported platform. Development builds
	// can exercise each state through the Dev menu.
	if (!AUTO_UPDATE_ENABLED || !app.isPackaged || !IS_AUTO_UPDATE_PLATFORM) {
		return;
	}

	// Never download or install behind the user's back. A background check only
	// surfaces an AVAILABLE toast; downloadUpdate() and installUpdate() are
	// explicit renderer actions.
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.disableDifferentialDownload = false;

	// macOS update artifacts are built and smoke-tested natively for each CPU
	// architecture. Separate channel manifests prevent an Intel install from
	// ever selecting an Apple Silicon archive (and vice versa).
	if (PLATFORM.IS_MAC) {
		autoUpdater.channel = `latest-${process.arch}`;
	}
	// Setting a custom channel enables downgrades inside electron-updater, so
	// apply our policy after the architecture-specific channel assignment.
	autoUpdater.allowDowngrade = IS_PRERELEASE;

	// Use generic provider with explicit feed URL so electron-updater can request
	// the correct manifest for the current platform from GitHub release assets.
	autoUpdater.setFeedURL({
		provider: "generic",
		url: UPDATE_FEED_URL,
	});

	console.info(
		`[auto-updater] Initialized: version=${app.getVersion()}, channel=${IS_PRERELEASE ? "canary" : "stable"}, feedURL=${UPDATE_FEED_URL}`,
	);

	autoUpdater.on("error", (error) => {
		if (isNetworkError(error)) {
			console.info("[auto-updater] Network unavailable, will retry later");
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			return;
		}
		console.error(
			`[auto-updater] Error during update (currentVersion=${app.getVersion()}):`,
			error?.message || error,
		);
		emitStatus(AUTO_UPDATE_STATUS.ERROR, undefined, error.message);
	});

	autoUpdater.on("checking-for-update", () => {
		console.info(
			`[auto-updater] Checking for updates... (currentVersion=${app.getVersion()}, feedURL=${UPDATE_FEED_URL})`,
		);
		emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	});

	autoUpdater.on("update-available", (info) => {
		console.info(
			`[auto-updater] Update available: ${app.getVersion()} → ${info.version} (files: ${info.files?.map((f: { url: string }) => f.url).join(", ")})`,
		);
		emitStatus(AUTO_UPDATE_STATUS.AVAILABLE, info.version);
	});

	autoUpdater.on("update-not-available", (info) => {
		console.info(
			`[auto-updater] No updates available (currentVersion=${app.getVersion()}, latestVersion=${info.version})`,
		);
		emitStatus(AUTO_UPDATE_STATUS.IDLE);
	});

	autoUpdater.on("download-progress", (progress) => {
		console.info(
			`[auto-updater] Download progress: ${progress.percent.toFixed(1)}% (${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB)`,
		);
		emitStatus(
			AUTO_UPDATE_STATUS.DOWNLOADING,
			currentVersion,
			undefined,
			progress.percent,
		);
	});

	autoUpdater.on("update-downloaded", (info) => {
		console.info(
			`[auto-updater] Update downloaded: ${app.getVersion()} → ${info.version}. Ready to install.`,
		);
		emitStatus(AUTO_UPDATE_STATUS.READY, info.version);
	});

	const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
	interval.unref();

	if (app.isReady()) {
		void checkForUpdates();
	} else {
		app
			.whenReady()
			.then(() => checkForUpdates())
			.catch((error) => {
				console.error("[auto-updater] Failed to start update checks:", error);
			});
	}
}
