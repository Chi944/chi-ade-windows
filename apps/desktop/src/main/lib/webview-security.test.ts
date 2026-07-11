import { describe, expect, it } from "bun:test";
import {
	APP_WEBVIEW_PARTITION,
	hardenWebviewPreferences,
	isAllowedWebviewPartition,
	isAllowedWebviewUrl,
	shouldGrantAppPermission,
} from "./webview-security";

describe("webview security policy", () => {
	it("allows only normal browser URLs and an empty page", () => {
		expect(isAllowedWebviewUrl("https://example.com/path")).toBe(true);
		expect(isAllowedWebviewUrl("http://127.0.0.1:41729/devtools")).toBe(true);
		expect(isAllowedWebviewUrl("about:blank")).toBe(true);
		expect(isAllowedWebviewUrl(undefined)).toBe(true);

		expect(isAllowedWebviewUrl("file:///Users/me/.ssh/id_ed25519")).toBe(false);
		expect(isAllowedWebviewUrl("javascript:alert(1)")).toBe(false);
		expect(isAllowedWebviewUrl("chrome-extension://example/page.html")).toBe(
			false,
		);
		expect(isAllowedWebviewUrl("about:gpu")).toBe(false);
		expect(isAllowedWebviewUrl("not a URL")).toBe(false);
	});

	it("pins guests to the application browser partition", () => {
		expect(isAllowedWebviewPartition(undefined)).toBe(true);
		expect(isAllowedWebviewPartition(APP_WEBVIEW_PARTITION)).toBe(true);
		expect(isAllowedWebviewPartition("persist:attacker")).toBe(false);
	});

	it("strips privileged guest preferences", () => {
		const preferences = {
			additionalArguments: ["--inspect"],
			allowRunningInsecureContent: true,
			contextIsolation: false,
			nodeIntegration: true,
			partition: "persist:attacker",
			preload: "/tmp/attacker.js",
			sandbox: false,
			webSecurity: false,
			webviewTag: true,
		} as Electron.WebPreferences;
		const params = {
			partition: "persist:superset",
			preload: "/tmp/attacker.js",
			webpreferences: "nodeIntegration=yes",
		};

		hardenWebviewPreferences(preferences, params);

		expect(preferences.preload).toBeUndefined();
		expect(preferences.additionalArguments).toBeUndefined();
		expect(preferences.nodeIntegration).toBe(false);
		expect(preferences.contextIsolation).toBe(true);
		expect(preferences.sandbox).toBe(true);
		expect(preferences.webSecurity).toBe(true);
		expect(preferences.webviewTag).toBe(false);
		expect(preferences.partition).toBe(APP_WEBVIEW_PARTITION);
		expect(params.preload).toBeUndefined();
		expect(params.webpreferences).toBeUndefined();
		expect(params.partition).toBe(APP_WEBVIEW_PARTITION);
	});

	it("grants only clipboard access to the trusted application window", () => {
		expect(shouldGrantAppPermission("window", "clipboard-read")).toBe(true);
		expect(
			shouldGrantAppPermission("window", "clipboard-sanitized-write"),
		).toBe(true);
		expect(shouldGrantAppPermission("window", "media")).toBe(false);
		expect(shouldGrantAppPermission("webview", "clipboard-read")).toBe(false);
		expect(shouldGrantAppPermission(undefined, "clipboard-read")).toBe(false);
	});
});
