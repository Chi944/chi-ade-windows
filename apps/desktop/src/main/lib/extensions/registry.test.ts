import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExtensionsDirectory, scanExtensions } from "./registry";

const originalHome = process.env.ADE_HOME_DIR;
const testHome = join(tmpdir(), `ade-extensions-${process.pid}`);

afterEach(() => {
	if (originalHome === undefined) delete process.env.ADE_HOME_DIR;
	else process.env.ADE_HOME_DIR = originalHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("extension registry", () => {
	it("loads declarative agents and resolves in-package skills", () => {
		process.env.ADE_HOME_DIR = testHome;
		const extensionDir = join(getExtensionsDirectory(), "example");
		mkdirSync(join(extensionDir, "skills", "review"), { recursive: true });
		writeFileSync(
			join(extensionDir, "skills", "review", "SKILL.md"),
			"# Review",
		);
		writeFileSync(
			join(extensionDir, "ade-extension.json"),
			JSON.stringify({
				manifestVersion: 1,
				id: "example.extension",
				name: "Example",
				version: "1.0.0",
				agents: [
					{ id: "agent", name: "Example Agent", command: "example-agent" },
				],
				skills: [{ name: "review", path: "skills/review/SKILL.md" }],
			}),
		);

		const entries = scanExtensions();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.status).toBe("ready");
		if (entries[0]?.status === "ready") {
			expect(entries[0].manifest.agents[0]?.command).toBe("example-agent");
			expect(entries[0].resolvedSkills[0]?.path).toEndWith("SKILL.md");
		}
	});

	it("rejects traversal in skill paths", () => {
		process.env.ADE_HOME_DIR = testHome;
		const extensionDir = join(getExtensionsDirectory(), "bad");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "ade-extension.json"),
			JSON.stringify({
				manifestVersion: 1,
				id: "bad.extension",
				name: "Bad",
				version: "1.0.0",
				skills: [{ name: "escape", path: "../secret" }],
			}),
		);
		expect(scanExtensions()[0]?.status).toBe("invalid");
	});

	it("rejects skill links that resolve outside the extension", () => {
		process.env.ADE_HOME_DIR = testHome;
		const extensionDir = join(getExtensionsDirectory(), "linked");
		const outsideDir = join(testHome, "outside");
		mkdirSync(join(extensionDir, "skills"), { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "SKILL.md"), "# Outside");
		symlinkSync(
			outsideDir,
			join(extensionDir, "skills", "linked"),
			process.platform === "win32" ? "junction" : "dir",
		);
		writeFileSync(
			join(extensionDir, "ade-extension.json"),
			JSON.stringify({
				manifestVersion: 1,
				id: "linked.extension",
				name: "Linked",
				version: "1.0.0",
				skills: [{ name: "escape", path: "skills/linked/SKILL.md" }],
			}),
		);

		expect(scanExtensions()[0]?.status).toBe("invalid");
	});
});
