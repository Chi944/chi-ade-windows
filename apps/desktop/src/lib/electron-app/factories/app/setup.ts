import { app, BrowserWindow, shell } from "electron";
import { env } from "main/env.main";
import { loadReactDevToolsExtension } from "main/lib/extensions";
import {
	configureWebviewSessionSecurity,
	secureWebviewEmbedder,
	secureWebviewGuest,
} from "main/lib/webview-security";
import { PLATFORM } from "shared/constants";
import { makeAppId } from "shared/utils";
import { ignoreConsoleWarnings } from "../../utils/ignore-console-warnings";

ignoreConsoleWarnings(["Manifest version 2 is deprecated"]);

export async function makeAppSetup(
	createWindow: () => Promise<BrowserWindow>,
	restoreWindows?: () => Promise<void>,
) {
	// Register before creating the main window so its webview attachment boundary is
	// protected before renderer code can create a guest.
	app.on("web-contents-created", (_, contents) => {
		configureWebviewSessionSecurity(contents.session);
		if (contents.getType() === "webview") {
			secureWebviewGuest(contents);
			return;
		}
		secureWebviewEmbedder(contents);
	});

	await loadReactDevToolsExtension();

	// Restore windows from previous session if available
	if (restoreWindows) {
		await restoreWindows();
	}

	// If no windows were restored, create a new one
	const existingWindows = BrowserWindow.getAllWindows();
	let window: BrowserWindow;
	if (existingWindows.length > 0) {
		window = existingWindows[0];
	} else {
		window = await createWindow();
	}

	app.on("activate", async () => {
		const windows = BrowserWindow.getAllWindows();

		if (!windows.length) {
			window = await createWindow();
		} else {
			for (window of windows.reverse()) {
				window.restore();
			}
		}
	});

	app.on("web-contents-created", (_, contents) => {
		if (contents.getType() === "webview") return;
		contents.on("will-navigate", (event, url) => {
			// Always prevent in-app navigation for external URLs
			if (url.startsWith("http://") || url.startsWith("https://")) {
				event.preventDefault();
				shell.openExternal(url);
			}
		});
	});

	app.on("window-all-closed", () => !PLATFORM.IS_MAC && app.quit());
	app.on("before-quit", () => {});

	return window;
}

PLATFORM.IS_LINUX && app.disableHardwareAcceleration();

// macOS Sequoia+: occluded window throttling can corrupt GPU compositor layers
if (PLATFORM.IS_MAC) {
	app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

PLATFORM.IS_WINDOWS &&
	app.setAppUserModelId(
		env.NODE_ENV === "development" ? process.execPath : makeAppId(),
	);

app.commandLine.appendSwitch("force-color-profile", "srgb");

// CDP is unauthenticated. Keep it out of normal packaged builds and require an
// explicit local automation opt-in when testing a release artifact.
const desktopAutomationEnabled =
	env.NODE_ENV === "development" ||
	process.env.ADE_ENABLE_DESKTOP_AUTOMATION === "1";
if (desktopAutomationEnabled) {
	const cdpPort = String(process.env.DESKTOP_AUTOMATION_PORT || 41729);
	app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
	app.commandLine.appendSwitch("remote-allow-origins", "*");
}
