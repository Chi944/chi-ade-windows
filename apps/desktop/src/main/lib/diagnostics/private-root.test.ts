import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { resolveLocalPrivateRoot } from "./private-root";

function namespaceFor(path: string): string {
	return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

describe("resolveLocalPrivateRoot", () => {
	test("uses LOCALAPPDATA and a path-safe home namespace on Windows", () => {
		const adeHomeDir = "C:\\Users\\A User\\.ade";
		const resolvedHome = win32.resolve(adeHomeDir);
		expect(
			resolveLocalPrivateRoot({
				adeHomeDir,
				platform: "win32",
				env: { LOCALAPPDATA: "D:\\Local App Data" },
				homeDir: "C:\\Users\\A User",
			}),
		).toBe(
			win32.join(
				"D:\\Local App Data",
				"ADE",
				"private",
				namespaceFor(resolvedHome),
			),
		);
	});

	test("uses Application Support on macOS", () => {
		const adeHomeDir = "/Users/chi/.ade";
		expect(
			resolveLocalPrivateRoot({
				adeHomeDir,
				platform: "darwin",
				env: {},
				homeDir: "/Users/chi",
			}),
		).toBe(
			posix.join(
				"/Users/chi/Library/Application Support",
				"ADE",
				"private",
				namespaceFor(posix.resolve(adeHomeDir)),
			),
		);
	});

	test("uses XDG_DATA_HOME or the Linux data fallback", () => {
		const adeHomeDir = "/home/chi/.ade";
		const namespace = namespaceFor(posix.resolve(adeHomeDir));
		expect(
			resolveLocalPrivateRoot({
				adeHomeDir,
				platform: "linux",
				env: { XDG_DATA_HOME: "/mnt/private-data" },
				homeDir: "/home/chi",
			}),
		).toBe(posix.join("/mnt/private-data/ADE/private", namespace));
		expect(
			resolveLocalPrivateRoot({
				adeHomeDir,
				platform: "linux",
				env: {},
				homeDir: "/home/chi",
			}),
		).toBe(posix.join("/home/chi/.local/share/ADE/private", namespace));
	});

	test("rejects a missing Windows local-data base and an empty ADE home", () => {
		expect(() =>
			resolveLocalPrivateRoot({
				adeHomeDir: "C:\\Users\\chi\\.ade",
				platform: "win32",
				env: {},
				homeDir: "C:\\Users\\chi",
			}),
		).toThrow("Windows local application data directory is unavailable");
		expect(() =>
			resolveLocalPrivateRoot({
				adeHomeDir: "",
				platform: "linux",
				env: {},
				homeDir: "/home/chi",
			}),
		).toThrow("ADE home directory is required");
	});
});
