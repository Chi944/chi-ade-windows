import { describe, expect, it } from "bun:test";
import config, { getNodePtyFiles } from "./electron-builder";

describe("platform package identity", () => {
	it("uses a filesystem-safe Linux executable name", () => {
		expect(config.linux).toMatchObject({ executableName: "ade" });
	});
});

describe("node-pty package filters", () => {
	it.each([
		"arm64",
		"x64",
	] as const)("keeps only the %s macOS runtime prebuild", (arch) => {
		const files = getNodePtyFiles("darwin", arch);

		expect(files).toContain(`prebuilds/darwin-${arch}/**/*`);
		expect(files).not.toContain(
			`prebuilds/darwin-${arch === "arm64" ? "x64" : "arm64"}/**/*`,
		);
		expect(files).not.toContain("prebuilds/win32-x64/**/*");
		expect(files).not.toContain("src/**/*");
		expect(files).not.toContain("build/**/*");
	});

	it("rejects unsupported macOS architectures", () => {
		expect(() => getNodePtyFiles("darwin", "ia32")).toThrow(
			"Unsupported macOS node-pty architecture: ia32",
		);
	});

	it("preserves the Windows x64 runtime filter", () => {
		const files = getNodePtyFiles("win32", "x64");

		expect(files).toContain("prebuilds/win32-x64/**/*");
		expect(files).toContain("!prebuilds/win32-x64/**/*.pdb");
	});
});
