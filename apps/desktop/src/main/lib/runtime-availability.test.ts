import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("main/lib/agent-setup/utils", () => ({
	findRealBinariesAsync: async () => [],
}));

const { computeRuntimeAvailability, probeBinaryCommand, probeBinaryVersion } =
	await import("./runtime-availability");

describe("runtime availability", () => {
	it("requires a discovered binary to execute successfully", async () => {
		const result = await computeRuntimeAvailability({
			findBinaries: (binary) =>
				binary === "codex" ? ["store-alias", "working-codex"] : [],
			probeBinary: async (path) => path !== "store-alias",
		});

		expect(result.codex).toBe(true);
		expect(result.claude).toBe(false);
	});

	it("executes --version for a real binary and rejects a missing one", async () => {
		expect(await probeBinaryVersion(process.execPath)).toBe(true);
		expect(await probeBinaryVersion("definitely-missing-ade-binary")).toBe(
			false,
		);
	});

	it("executes a Windows command shim with quoted arguments", async () => {
		if (process.platform !== "win32") return;
		const directory = mkdtempSync(join(tmpdir(), "ade runtime probe "));
		const shim = join(directory, "working-cli.cmd");
		try {
			writeFileSync(
				shim,
				'@echo off\r\nif "%~1"=="--version" exit /b 0\r\nexit /b 1\r\n',
			);
			expect(await probeBinaryVersion(shim)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("settles when a child never exits", async () => {
		const startedAt = Date.now();
		const result = await probeBinaryCommand(
			process.execPath,
			["-e", "setInterval(() => {}, 1_000)"],
			{ timeoutMs: 50 },
		);

		expect(result).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(500);
	});
});
