import type { BrowserWindow } from "electron";
import { env } from "shared/env.shared";

/** Window IDs defined in the router configuration */
type WindowId = "main" | "about";

export function buildDevelopmentWindowUrl(
	port: number,
	query?: Record<string, string>,
): string {
	const url = new URL(`http://localhost:${port}/`);
	for (const [key, value] of Object.entries(query ?? {})) {
		url.searchParams.set(key, value);
	}
	url.hash = "/";
	return url.toString();
}

export function buildProductionWindowOptions(query?: Record<string, string>): {
	hash: string;
	query?: Record<string, string>;
} {
	return {
		hash: "/",
		...(query && Object.keys(query).length > 0 ? { query } : {}),
	};
}

/**
 * Window URLs may carry the per-run packaged-smoke credential. Logs need only
 * the document origin/path, never the search or current application route.
 */
export function redactWindowUrlForLogs(value: string): string {
	try {
		const url = new URL(value);
		url.search = "";
		url.hash = "/";
		return url.toString();
	} catch {
		return "[redacted-window-url]";
	}
}

/**
 * Load an Electron window with the appropriate URL for TanStack Router.
 * Uses hash-based routing for compatibility with Electron's file:// protocol.
 *
 * - Development: loads from Vite dev server at http://localhost:PORT/#/
 * - Production: loads from built HTML file with hash routing (#/)
 */
export function registerRoute(props: {
	id: WindowId;
	browserWindow: BrowserWindow;
	htmlFile: string;
	query?: Record<string, string>;
}): void {
	const isDev = env.NODE_ENV === "development";

	if (isDev) {
		// Development: load from Vite dev server with hash routing
		const url = buildDevelopmentWindowUrl(env.DESKTOP_VITE_PORT, props.query);
		console.log(
			"[window-loader] Loading development URL:",
			redactWindowUrlForLogs(url),
		);
		props.browserWindow.loadURL(url);
	} else {
		// Production: load from file with hash routing
		// TanStack Router uses hash-based routing, so we always start at #/
		console.log("[window-loader] Loading production window");
		props.browserWindow.loadFile(
			props.htmlFile,
			buildProductionWindowOptions(props.query),
		);
	}

	// Log successful loads
	props.browserWindow.webContents.on("did-finish-load", () => {
		console.log(
			"[window-loader] Successfully loaded:",
			redactWindowUrlForLogs(props.browserWindow.webContents.getURL()),
		);
	});

	// Log and handle load failures
	props.browserWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error(
				"[window-loader] Failed to load URL:",
				redactWindowUrlForLogs(validatedURL),
			);
			console.error("[window-loader] Error code:", errorCode);
			console.error("[window-loader] Error description:", errorDescription);
		},
	);
}
