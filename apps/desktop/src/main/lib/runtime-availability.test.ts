import { describe, expect, it, mock } from "bun:test";

mock.module("@superset/shared/agent-binaries", () => ({
	CHECKED_BINARIES: ["claude", "codex", "opencode", "git"],
}));
mock.module("main/lib/agent-setup/utils", () => ({
	findRealBinaries: () => [],
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

	it("settles when a child never exits", async () => {
		const startedAt = Date.now();
		const result = await probeBinaryCommand(
			process.execPath,
			["-e", "setInterval(() => {}, 1_000)"],
			{ timeoutMs: 50 },
		);

		expect(result).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});
