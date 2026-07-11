import { describe, expect, it } from "bun:test";
import {
	assertRendererIpcEventChannel,
	isValidDeepLinkPath,
} from "./ipc-policy";

describe("renderer IPC policy", () => {
	it("allows only the deep-link event channel", () => {
		expect(() =>
			assertRendererIpcEventChannel("deep-link-navigate"),
		).not.toThrow();
		expect(() => assertRendererIpcEventChannel("terminal:spawn")).toThrow(
			"Blocked renderer IPC channel",
		);
	});

	it("accepts bounded application paths", () => {
		expect(isValidDeepLinkPath("/workspace/abc?pane=terminal")).toBe(true);
		expect(isValidDeepLinkPath("/settings/terminal")).toBe(true);
	});

	it("rejects malformed or external-looking paths", () => {
		expect(isValidDeepLinkPath("https://example.com")).toBe(false);
		expect(isValidDeepLinkPath("//example.com/path")).toBe(false);
		expect(isValidDeepLinkPath("/workspace/abc\0tail")).toBe(false);
		expect(isValidDeepLinkPath(`/${"a".repeat(4096)}`)).toBe(false);
	});
});
