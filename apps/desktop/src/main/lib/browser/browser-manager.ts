import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { app, clipboard, webContents } from "electron";
import { isAllowedWebviewUrl } from "../webview-security";

interface ConsoleEntry {
	level: "log" | "warn" | "error" | "info" | "debug";
	message: string;
	timestamp: number;
}

export interface DesignSelection {
	version: 1;
	cancelled?: boolean;
	tagName?: string;
	selector?: string;
	text?: string;
	attributes?: Record<string, string>;
	styles?: Record<string, string>;
	rect?: { x: number; y: number; width: number; height: number };
	page?: { path: string; title: string };
}

const MAX_CONSOLE_ENTRIES = 500;
const DESIGN_SELECTION_MARKER = "__ADE_DESIGN_SELECTION__";
const MAX_DESIGN_MESSAGE_LENGTH = 16_384;
const DESIGN_ATTRIBUTE_KEYS = new Set([
	"role",
	"aria-label",
	"title",
	"alt",
	"type",
]);
const DESIGN_STYLE_KEYS = new Set([
	"display",
	"position",
	"color",
	"backgroundColor",
	"fontFamily",
	"fontSize",
	"fontWeight",
	"lineHeight",
	"textAlign",
	"borderRadius",
	"padding",
	"margin",
	"gap",
	"width",
	"height",
]);

function isLocalDesignUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "localhost" ||
				url.hostname === "127.0.0.1" ||
				url.hostname.endsWith(".localhost"))
		);
	} catch {
		return false;
	}
}

function parseDesignSelection(
	message: string,
	expectedNonce: string,
): DesignSelection | null {
	const expectedMarker = `${DESIGN_SELECTION_MARKER}${expectedNonce}:`;
	if (
		!message.startsWith(expectedMarker) ||
		message.length > MAX_DESIGN_MESSAGE_LENGTH
	) {
		return null;
	}
	try {
		const value = JSON.parse(message.slice(expectedMarker.length)) as Record<
			string,
			unknown
		>;
		if (value.version !== 1) return null;
		if (value.cancelled === true) return { version: 1, cancelled: true };
		if (
			typeof value.tagName !== "string" ||
			!/^[a-z][a-z0-9-]{0,79}$/i.test(value.tagName) ||
			typeof value.selector !== "string" ||
			typeof value.text !== "string"
		) {
			return null;
		}

		const sanitizeRecord = (
			raw: unknown,
			allowedKeys: Set<string>,
		): Record<string, string> => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
			const result: Record<string, string> = {};
			for (const [key, entry] of Object.entries(raw)) {
				if (allowedKeys.has(key) && typeof entry === "string") {
					result[key] = entry.slice(0, 180);
				}
			}
			return result;
		};
		const rectValue =
			value.rect && typeof value.rect === "object" && !Array.isArray(value.rect)
				? (value.rect as Record<string, unknown>)
				: null;
		const rectNumbers = rectValue
			? [rectValue.x, rectValue.y, rectValue.width, rectValue.height]
			: [];
		const rect =
			rectValue &&
			rectNumbers.every(
				(entry) =>
					typeof entry === "number" &&
					Number.isFinite(entry) &&
					Math.abs(entry) <= 10_000_000,
			)
				? {
						x: rectValue.x as number,
						y: rectValue.y as number,
						width: Math.max(0, rectValue.width as number),
						height: Math.max(0, rectValue.height as number),
					}
				: undefined;
		const pageValue =
			value.page && typeof value.page === "object" && !Array.isArray(value.page)
				? (value.page as Record<string, unknown>)
				: null;

		return {
			version: 1,
			tagName: value.tagName.toLowerCase(),
			selector: value.selector.slice(0, 500),
			text: value.text.slice(0, 180),
			attributes: sanitizeRecord(value.attributes, DESIGN_ATTRIBUTE_KEYS),
			styles: sanitizeRecord(value.styles, DESIGN_STYLE_KEYS),
			...(rect ? { rect } : {}),
			...(pageValue &&
			typeof pageValue.path === "string" &&
			typeof pageValue.title === "string"
				? {
						page: {
							path: pageValue.path.slice(0, 500),
							title: pageValue.title.slice(0, 180),
						},
					}
				: {}),
		};
	} catch {
		return null;
	}
}

function sanitizeUrl(url: string): string {
	if (/^https?:\/\//i.test(url) || url.startsWith("about:")) {
		return url;
	}
	if (url.startsWith("localhost") || url.startsWith("127.0.0.1")) {
		return `http://${url}`;
	}
	if (url.includes(".")) {
		return `https://${url}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

class BrowserManager extends EventEmitter {
	private paneWebContentsIds = new Map<string, number>();
	private consoleLogs = new Map<string, ConsoleEntry[]>();
	private consoleListeners = new Map<string, () => void>();
	private designModePanes = new Set<string>();
	private designModeNonces = new Map<string, string>();

	register(paneId: string, webContentsId: number): void {
		// Clean up previous console listener if re-registering with a new webContentsId
		const prevId = this.paneWebContentsIds.get(paneId);
		if (prevId != null && prevId !== webContentsId) {
			const cleanup = this.consoleListeners.get(paneId);
			if (cleanup) {
				cleanup();
				this.consoleListeners.delete(paneId);
			}
		}
		this.paneWebContentsIds.set(paneId, webContentsId);
		const wc = webContents.fromId(webContentsId);
		if (!wc || wc.isDestroyed() || wc.getType() !== "webview") {
			this.paneWebContentsIds.delete(paneId);
			throw new Error(
				"Only attached webviews can be registered as browser panes",
			);
		}
		wc.setBackgroundThrottling(false);
		wc.setWindowOpenHandler(({ url }) => {
			if (url && url !== "about:blank" && isAllowedWebviewUrl(url)) {
				this.emit(`new-window:${paneId}`, url);
			}
			return { action: "deny" as const };
		});
		this.setupConsoleCapture(paneId, wc);
	}

	unregister(paneId: string): void {
		const cleanup = this.consoleListeners.get(paneId);
		if (cleanup) {
			cleanup();
			this.consoleListeners.delete(paneId);
		}
		this.paneWebContentsIds.delete(paneId);
		this.consoleLogs.delete(paneId);
		this.designModePanes.delete(paneId);
		this.designModeNonces.delete(paneId);
	}

	unregisterAll(): void {
		for (const paneId of [...this.paneWebContentsIds.keys()]) {
			this.unregister(paneId);
		}
	}

	getWebContents(paneId: string): Electron.WebContents | null {
		const id = this.paneWebContentsIds.get(paneId);
		if (id == null) return null;
		const wc = webContents.fromId(id);
		if (!wc || wc.isDestroyed() || wc.getType() !== "webview") return null;
		return wc;
	}

	navigate(paneId: string, url: string): void {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		wc.loadURL(sanitizeUrl(url));
	}

	async screenshot(paneId: string): Promise<string> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		const image = await wc.capturePage();
		clipboard.writeImage(image);
		return image.toPNG().toString("base64");
	}

	async evaluateJS(paneId: string, code: string): Promise<unknown> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		return wc.executeJavaScript(code);
	}

	async setDesignMode(paneId: string, enabled: boolean): Promise<void> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		if (enabled && !isLocalDesignUrl(wc.getURL())) {
			throw new Error(
				"Design Mode is limited to localhost pages to protect private browsing data.",
			);
		}

		const nonce = enabled ? randomUUID() : undefined;
		if (enabled && nonce) {
			this.designModePanes.add(paneId);
			this.designModeNonces.set(paneId, nonce);
		} else {
			this.designModePanes.delete(paneId);
			this.designModeNonces.delete(paneId);
		}

		try {
			const detail = JSON.stringify({ enabled, nonce });
			await wc.executeJavaScript(
				`document.dispatchEvent(new CustomEvent("ade-design-mode", { detail: ${detail} }))`,
			);
		} catch (error) {
			this.designModePanes.delete(paneId);
			this.designModeNonces.delete(paneId);
			throw error;
		}
	}

	getConsoleLogs(paneId: string): ConsoleEntry[] {
		return this.consoleLogs.get(paneId) ?? [];
	}

	openDevTools(paneId: string): void {
		const wc = this.getWebContents(paneId);
		if (!wc) return;
		wc.openDevTools({ mode: "detach" });
	}

	async getDevToolsUrl(browserPaneId: string): Promise<string | null> {
		const wc = this.getWebContents(browserPaneId);
		if (!wc) return null;

		const cdpPort = app.commandLine.getSwitchValue("remote-debugging-port");
		if (!cdpPort) return null;

		try {
			const targetUrl = wc.getURL();
			const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
			const targets = (await res.json()) as Array<{
				id: string;
				url: string;
				type: string;
				webSocketDebuggerUrl?: string;
			}>;

			const webviewTargets = targets.filter(
				(t) => t.type === "page" || t.type === "webview",
			);

			// Strategy 1: Exact URL match
			let target = webviewTargets.find((t) => t.url === targetUrl);

			// Strategy 2: Match ignoring trailing slash / fragment differences
			if (!target && targetUrl) {
				const normalize = (u: string) =>
					u.replace(/\/?(#.*)?$/, "").toLowerCase();
				const normalizedTarget = normalize(targetUrl);
				target = webviewTargets.find(
					(t) => normalize(t.url) === normalizedTarget,
				);
			}

			// Strategy 3: If only one webview target exists, use it
			if (!target) {
				const webviewOnly = webviewTargets.filter((t) => t.type === "webview");
				if (webviewOnly.length === 1) {
					target = webviewOnly[0];
				}
			}

			if (!target) return null;

			return `http://127.0.0.1:${cdpPort}/devtools/inspector.html?ws=127.0.0.1:${cdpPort}/devtools/page/${target.id}`;
		} catch {
			return null;
		}
	}

	private setupConsoleCapture(paneId: string, wc: Electron.WebContents): void {
		const LEVEL_MAP: Record<number, ConsoleEntry["level"]> = {
			0: "log",
			1: "warn",
			2: "error",
			3: "info",
		};

		const handler = (
			_event: Electron.Event,
			level: number,
			message: string,
		) => {
			if (this.designModePanes.has(paneId) && isLocalDesignUrl(wc.getURL())) {
				const nonce = this.designModeNonces.get(paneId);
				const selection = nonce ? parseDesignSelection(message, nonce) : null;
				if (selection) {
					this.designModePanes.delete(paneId);
					this.designModeNonces.delete(paneId);
					this.emit(`design-selection:${paneId}`, selection);
					return;
				}
			}
			const entries = this.consoleLogs.get(paneId) ?? [];
			entries.push({
				level: LEVEL_MAP[level] ?? "log",
				message,
				timestamp: Date.now(),
			});
			if (entries.length > MAX_CONSOLE_ENTRIES) {
				entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
			}
			this.consoleLogs.set(paneId, entries);
			this.emit(`console:${paneId}`, entries[entries.length - 1]);
		};
		const navigationHandler = (
			_event: Electron.Event,
			_url: string,
			isInPlace: boolean,
			isMainFrame: boolean,
		) => {
			if (isMainFrame && !isInPlace && this.designModePanes.has(paneId)) {
				this.designModePanes.delete(paneId);
				this.designModeNonces.delete(paneId);
				this.emit(`design-selection:${paneId}`, {
					version: 1,
					cancelled: true,
				} satisfies DesignSelection);
			}
		};

		wc.on("console-message", handler);
		wc.on("did-start-navigation", navigationHandler);
		this.consoleListeners.set(paneId, () => {
			try {
				wc.off("console-message", handler);
				wc.off("did-start-navigation", navigationHandler);
			} catch {
				// webContents may be destroyed
			}
		});
	}
}

export const browserManager = new BrowserManager();
