import path from "node:path";
import { pathToFileURL } from "node:url";
import { settings } from "@superset/local-db";
import {
	app,
	BrowserWindow,
	dialog,
	Notification,
	net,
	protocol,
	session,
} from "electron";
import { makeAppSetup } from "lib/electron-app/factories/app/setup";
import {
	DEFAULT_CONFIRM_ON_QUIT,
	PLATFORM,
	PROTOCOL_SCHEME,
} from "shared/constants";
import { getWorkspaceName } from "shared/env.shared";
import { removeLegacyAgentCodexAuthFiles } from "./lib/agent-home";
import { backfillAgentMemory } from "./lib/agent-memory-backfill";
import { setupAgentHooks } from "./lib/agent-setup";
import {
	ensureSupersetHomeDirExists,
	SUPERSET_HOME_DIR,
} from "./lib/app-environment";
import { initAppState } from "./lib/app-state";
import { appStateWatcher, startAppStateWatcher } from "./lib/app-state/watcher";
import { setupAutoUpdater } from "./lib/auto-updater";
import {
	getBootRuntimeStatus,
	getStartupCapabilities,
} from "./lib/diagnostics/boot-state";
import {
	getDiagnosticsLogger,
	logAppStateRecovery,
} from "./lib/diagnostics/logger";
import { setWorkspaceDockIcon } from "./lib/dock-icon";
import { loadWebviewBrowserExtension } from "./lib/extensions";
import { initializeLocalDatabase, localDb } from "./lib/local-db";
import { getActivePackagedSmokeStartup } from "./lib/packaged-smoke";
import {
	ensureProjectIconsDir,
	ensureWorkspaceIconsDir,
	getIconPath,
} from "./lib/project-icons";
import { reconcileSshTunnels } from "./lib/remote/tunnel-manager";
import { hasSingleInstanceLock } from "./lib/single-instance";
import {
	initializeSubscriptionProfiles,
	pruneOrphanedSubscriptionHomes,
} from "./lib/subscription-profiles";
import {
	assertSensitiveSyncIgnoreReady,
	ensureSensitiveSyncIgnore,
} from "./lib/sync/sensitive-ignore";
import {
	getServiceTerminalManager,
	prewarmTerminalRuntime,
	reconcileServiceSessions,
} from "./lib/terminal";
import { getTerminalHostClient } from "./lib/terminal-host/client";
import { disposeTray, initTray } from "./lib/tray";
import { MainWindow } from "./windows/main";

console.log("[main] Local database ready:", !!localDb);

const packagedSmokeStartup = getActivePackagedSmokeStartup();

// Local build: set userData to our workspace-specific dir so singleton lock
// doesn't conflict with the production Superset.app
app.setPath("userData", SUPERSET_HOME_DIR);

// Dev mode: label the app with the workspace name so multiple worktrees are distinguishable
if (process.env.NODE_ENV === "development") {
	const workspaceName = getWorkspaceName();
	if (workspaceName) {
		app.setName(`ADE (${workspaceName})`);
	}
}

// Dev mode: register with execPath + app script so macOS launches Electron with
// our entry point. Isolated startup smoke tests opt out to avoid touching the
// user's OS protocol registration.
if (
	!packagedSmokeStartup &&
	process.env.ADE_DISABLE_PROTOCOL_REGISTRATION !== "1"
) {
	if (process.defaultApp) {
		if (process.argv.length >= 2) {
			app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
				path.resolve(process.argv[1]),
			]);
		}
	} else {
		app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
	}
}

async function processDeepLink(url: string): Promise<void> {
	console.log("[main] Processing deep link:", url);

	// Deep links: extract path and navigate in renderer
	// e.g. superset://tasks/my-slug -> /tasks/my-slug
	const path = `/${url.split("://")[1]}`;
	focusMainWindow();

	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		windows[0].webContents.send("deep-link-navigate", path);
	}
}

function findDeepLinkInArgv(argv: string[]): string | undefined {
	return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
}

function focusMainWindow(): void {
	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		const mainWindow = windows[0];
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
	}
}

function registerWithMacOSNotificationCenter() {
	if (!PLATFORM.IS_MAC || !Notification.isSupported()) return;

	const registrationNotification = new Notification({
		title: app.name,
		body: " ",
		silent: true,
	});

	let handled = false;
	const cleanup = () => {
		if (handled) return;
		handled = true;
		registrationNotification.close();
	};

	registrationNotification.on("show", () => {
		cleanup();
		console.log("[notifications] Registered with Notification Center");
	});

	// Fallback timeout in case macOS doesn't fire events
	setTimeout(cleanup, 1000);

	registrationNotification.show();
}

// macOS open-url can fire before the window exists (cold-start via protocol link).
// Queue the URL and process it after initialization.
let pendingDeepLinkUrl: string | null = null;
let appReady = false;

app.on("open-url", async (event, url) => {
	event.preventDefault();
	if (appReady) {
		await processDeepLink(url);
	} else {
		pendingDeepLinkUrl = url;
	}
});

let isQuitting = false;
let skipConfirmation = false;

function getConfirmOnQuitSetting(): boolean {
	try {
		const row = localDb.select().from(settings).get();
		return row?.confirmOnQuit ?? DEFAULT_CONFIRM_ON_QUIT;
	} catch {
		return DEFAULT_CONFIRM_ON_QUIT;
	}
}

export function setSkipQuitConfirmation(): void {
	skipConfirmation = true;
}

export function quitWithoutConfirmation(): void {
	skipConfirmation = true;
	app.exit(0);
}

async function quitPackagedSmokeCleanly(exitCode: number): Promise<void> {
	setSkipQuitConfirmation();
	try {
		await getTerminalHostClient().shutdownIfRunning({ killSessions: true });
	} catch {
		// The runner independently checks terminal-host.pid and tree-kills any
		// detached fallback before deleting the isolated home.
	}
	process.exitCode = exitCode;
	app.quit();
}

app.on("before-quit", async (event) => {
	if (isQuitting) return;
	if (packagedSmokeStartup) {
		isQuitting = true;
		disposeTray();
		return;
	}

	const isDev = process.env.NODE_ENV === "development";
	const shouldConfirm =
		!skipConfirmation && !isDev && getConfirmOnQuitSetting();

	if (shouldConfirm) {
		event.preventDefault();

		try {
			const { response } = await dialog.showMessageBox({
				type: "question",
				buttons: ["Quit", "Cancel"],
				defaultId: 0,
				cancelId: 1,
				title: "Quit ADE",
				message: "Are you sure you want to quit?",
			});

			if (response === 1) return;
		} catch (error) {
			console.error("[main] Quit confirmation dialog failed:", error);
		}
	}

	isQuitting = true;
	disposeTray();
	app.exit(0);
});

// Without these handlers, Electron may not quit when electron-vite sends SIGTERM
if (process.env.NODE_ENV === "development") {
	const handleTerminationSignal = (signal: string) => {
		console.log(`[main] Received ${signal}, quitting...`);
		app.exit(0);
	};

	process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
	process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

	// Fallback: electron-vite may exit without signaling the child Electron process
	const parentPid = process.ppid;
	const isParentAlive = (): boolean => {
		try {
			process.kill(parentPid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const parentCheckInterval = setInterval(() => {
		if (!isParentAlive()) {
			console.log("[main] Parent process exited, quitting...");
			clearInterval(parentCheckInterval);
			app.exit(0);
		}
	}, 1000);
	parentCheckInterval.unref();
}

const gotTheLock = hasSingleInstanceLock();

if (!gotTheLock) {
	app.exit(0);
} else {
	// Windows/Linux: protocol URL arrives as argv on the second instance
	app.on("second-instance", async (_event, argv) => {
		focusMainWindow();
		const url = findDeepLinkInArgv(argv);
		if (url) {
			await processDeepLink(url);
		}
	});

	(async () => {
		await app.whenReady();
		const bootStatus = getBootRuntimeStatus();
		const startup = getStartupCapabilities(bootStatus.safeMode);
		getDiagnosticsLogger()[bootStatus.safeMode ? "warn" : "info"](
			"startup.mode",
			bootStatus,
		);
		ensureSupersetHomeDirExists();
		await initializeLocalDatabase();
		let sensitiveSyncIgnoreReady = true;
		try {
			ensureSensitiveSyncIgnore(SUPERSET_HOME_DIR);
		} catch {
			sensitiveSyncIgnoreReady = false;
			console.error("[main] Failed to update managed sync ignores");
		}
		try {
			assertSensitiveSyncIgnoreReady({
				ignoreReady: sensitiveSyncIgnoreReady,
			});
		} catch {
			app.quit();
			return;
		}

		const subscriptionStorage = await initializeSubscriptionProfiles({
			adeHomeDir: SUPERSET_HOME_DIR,
			stopTerminalSessions: async () => {
				await getServiceTerminalManager().shutdownForSubscriptionProfileMigration();
			},
			resetTerminalService: () => {
				getServiceTerminalManager().reset();
			},
		});
		if (subscriptionStorage.warning) {
			console.warn(
				"[main] Provider account storage warning:",
				subscriptionStorage.warning,
			);
		}
		if (!packagedSmokeStartup && startup.notifications)
			registerWithMacOSNotificationCenter();

		// Must register on both default session and the app's custom partition
		const iconProtocolHandler = (request: Request) => {
			// superset-icon://<namespace>/<id> — namespace is the URL host
			// ("projects" for Category photos, "workspaces" for Agent avatars).
			const url = new URL(request.url);
			const namespace =
				url.hostname === "workspaces" ? "workspaces" : "projects";
			const id = url.pathname.replace(/^\//, "");
			const iconPath = getIconPath(namespace, id);
			if (!iconPath) {
				return new Response("Not found", { status: 404 });
			}
			return net.fetch(pathToFileURL(iconPath).toString());
		};
		protocol.handle("superset-icon", iconProtocolHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-icon", iconProtocolHandler);

		ensureProjectIconsDir();
		ensureWorkspaceIconsDir();
		setWorkspaceDockIcon();
		// Boot-phase markers: each awaited step below can block window creation,
		// so log entry/exit to make a boot hang localizable from the log alone.
		console.log("[main] boot: initAppState…");
		await initAppState({
			beforeOverwrite: (displacedPath) =>
				appStateWatcher.captureBeforeOverwrite(displacedPath),
			onDiagnosticEvent: logAppStateRecovery,
		});
		if (!packagedSmokeStartup && startup.appStateWatcher)
			await startAppStateWatcher();

		console.log("[main] boot: loadWebviewBrowserExtension…");
		if (!bootStatus.safeMode && !packagedSmokeStartup)
			await loadWebviewBrowserExtension();

		// Must happen before renderer restore runs
		console.log("[main] boot: reconcileServiceSessions…");
		if (!packagedSmokeStartup && startup.terminalRestore)
			await reconcileServiceSessions();
		if (!packagedSmokeStartup && startup.sshTunnels) {
			void reconcileSshTunnels().catch((error) => {
				getDiagnosticsLogger().warn("ssh-tunnels.reconcile.failed", { error });
			});
		}
		if (!packagedSmokeStartup && startup.terminalPrewarm)
			prewarmTerminalRuntime();

		if (!packagedSmokeStartup && startup.agentHooks) {
			try {
				setupAgentHooks();
			} catch (error) {
				getDiagnosticsLogger().error("agent-hooks.setup.failed", { error });
			}
		}

		console.log("[main] boot: makeAppSetup (create window)…");
		await makeAppSetup(() =>
			MainWindow({
				safeMode: bootStatus.safeMode,
				packagedSmoke: packagedSmokeStartup ?? undefined,
				onPackagedSmokeComplete: (exitCode) => {
					// Let tRPC flush its response before Electron starts closing windows.
					setTimeout(() => {
						void quitPackagedSmokeCleanly(exitCode);
					}, 100);
				},
			}),
		);
		console.log("[main] boot: window created");
		if (!packagedSmokeStartup && startup.autoUpdater) setupAutoUpdater();
		if (!packagedSmokeStartup && startup.tray) initTray();

		// One-time: bring agents created before the memory scaffold was enabled
		// up to spec (idempotent + self-guarding; no-op when the flag is off).
		// Deliberately OFF the critical boot path — scheduled after the window is
		// up and fire-and-forget — so a slow or broken backfill can NEVER delay or
		// brick window creation. Runs on a macrotask so it can't block this tick.
		if (!bootStatus.safeMode && !packagedSmokeStartup)
			setTimeout(() => {
				try {
					const prunedHomes = pruneOrphanedSubscriptionHomes();
					if (prunedHomes > 0) {
						console.info(
							`[main] Pruned ${prunedHomes} orphaned provider ${prunedHomes === 1 ? "home" : "homes"}`,
						);
					}
				} catch (error) {
					console.error("[main] Provider home cleanup failed:", error);
				}
				try {
					const removedAuthFiles = removeLegacyAgentCodexAuthFiles();
					if (removedAuthFiles > 0) {
						console.info(
							`[main] Removed ${removedAuthFiles} legacy Codex credential ${removedAuthFiles === 1 ? "copy" : "copies"}`,
						);
					}
					backfillAgentMemory();
				} catch (error) {
					console.error("[main] Memory backfill failed:", error);
				}
			}, 0);

		// Process any deep links from cold start
		if (!bootStatus.safeMode) {
			const coldStartUrl = findDeepLinkInArgv(process.argv);
			if (coldStartUrl) {
				await processDeepLink(coldStartUrl);
			}
			if (pendingDeepLinkUrl) {
				await processDeepLink(pendingDeepLinkUrl);
				pendingDeepLinkUrl = null;
			}
		}

		appReady = true;
	})();
}
