export const APP_WEBVIEW_PARTITION = "persist:superset";

const APP_RENDERER_PERMISSIONS = new Set([
	"clipboard-read",
	"clipboard-sanitized-write",
]);
const securedEmbedders = new WeakSet<Electron.WebContents>();
const securedGuests = new WeakSet<Electron.WebContents>();
const securedSessions = new WeakSet<Electron.Session>();
const guestWebContentsIds = new Set<number>();

export function isAllowedWebviewUrl(value: string | undefined): boolean {
	if (!value || value === "about:blank") return true;

	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.hostname.length > 0
		);
	} catch {
		return false;
	}
}

export function isAllowedWebviewPartition(
	partition: string | undefined,
): boolean {
	return !partition || partition === APP_WEBVIEW_PARTITION;
}

export function shouldGrantAppPermission(
	contentsType: string | undefined,
	permission: string,
): boolean {
	return contentsType === "window" && APP_RENDERER_PERMISSIONS.has(permission);
}

export function hardenWebviewPreferences(
	webPreferences: Electron.WebPreferences,
	params: Record<string, string>,
): void {
	delete webPreferences.preload;
	delete webPreferences.additionalArguments;
	delete webPreferences.session;
	delete params.preload;
	delete params.preloadurl;
	delete params.webpreferences;

	webPreferences.allowRunningInsecureContent = false;
	webPreferences.contextIsolation = true;
	webPreferences.enableDeprecatedPaste = false;
	webPreferences.experimentalFeatures = false;
	webPreferences.navigateOnDragDrop = false;
	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.nodeIntegrationInWorker = false;
	webPreferences.partition = APP_WEBVIEW_PARTITION;
	webPreferences.plugins = false;
	webPreferences.safeDialogs = true;
	webPreferences.sandbox = true;
	webPreferences.webSecurity = true;
	webPreferences.webviewTag = false;
	params.partition = APP_WEBVIEW_PARTITION;
}

export function secureWebviewEmbedder(contents: Electron.WebContents): void {
	if (securedEmbedders.has(contents)) return;
	securedEmbedders.add(contents);

	contents.on("will-attach-webview", (event, webPreferences, params) => {
		if (
			!isAllowedWebviewUrl(params.src) ||
			!isAllowedWebviewPartition(params.partition)
		) {
			event.preventDefault();
			return;
		}

		hardenWebviewPreferences(webPreferences, params);
	});
}

export function secureWebviewGuest(contents: Electron.WebContents): void {
	if (securedGuests.has(contents)) return;
	securedGuests.add(contents);
	const contentsId = contents.id;
	guestWebContentsIds.add(contentsId);

	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-frame-navigate", (event) => {
		if (event.isMainFrame && !isAllowedWebviewUrl(event.url)) {
			event.preventDefault();
		}
	});
	contents.on("will-redirect", (event) => {
		if (event.isMainFrame && !isAllowedWebviewUrl(event.url)) {
			event.preventDefault();
		}
	});
	contents.once("destroyed", () => {
		guestWebContentsIds.delete(contentsId);
	});
}

export function configureWebviewSessionSecurity(ses: Electron.Session): void {
	if (securedSessions.has(ses)) return;
	securedSessions.add(ses);

	ses.setPermissionCheckHandler((contents, permission) =>
		shouldGrantAppPermission(contents?.getType(), permission),
	);
	ses.setPermissionRequestHandler((contents, permission, callback) => {
		callback(shouldGrantAppPermission(contents.getType(), permission));
	});
	ses.webRequest.onBeforeRequest((details, callback) => {
		const isGuest =
			details.webContents?.getType() === "webview" ||
			(details.webContentsId !== undefined &&
				guestWebContentsIds.has(details.webContentsId));
		const shouldBlock =
			isGuest &&
			details.resourceType === "mainFrame" &&
			!isAllowedWebviewUrl(details.url);
		callback({ cancel: shouldBlock });
	});
}
