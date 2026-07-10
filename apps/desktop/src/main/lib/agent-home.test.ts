import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ADE_HOME = process.env.ADE_HOME_DIR;
const TEST_HOME = join(
	tmpdir(),
	`ade-agent-home-test-${process.pid}-${Date.now()}`,
);

let getAgentHome: typeof import("./agent-home").getAgentHome;
let getAgentWorktreePath: typeof import("./agent-home").getAgentWorktreePath;
let isManagedAgentWorktree: typeof import("./agent-home").isManagedAgentWorktree;
let removeAgentHome: typeof import("./agent-home").removeAgentHome;
let removeLegacyAgentCodexAuthFiles: typeof import("./agent-home").removeLegacyAgentCodexAuthFiles;

beforeAll(async () => {
	process.env.ADE_HOME_DIR = TEST_HOME;
	const home = await import("./agent-home");
	getAgentHome = home.getAgentHome;
	getAgentWorktreePath = home.getAgentWorktreePath;
	isManagedAgentWorktree = home.isManagedAgentWorktree;
	removeAgentHome = home.removeAgentHome;
	removeLegacyAgentCodexAuthFiles = home.removeLegacyAgentCodexAuthFiles;
});

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	if (ORIGINAL_ADE_HOME === undefined) {
		delete process.env.ADE_HOME_DIR;
	} else {
		process.env.ADE_HOME_DIR = ORIGINAL_ADE_HOME;
	}
});

describe("agent home ownership", () => {
	it("recognizes only the derived ADE-managed worktree", () => {
		const agentId = "managed-agent";
		expect(isManagedAgentWorktree(agentId, getAgentWorktreePath(agentId))).toBe(
			true,
		);
		expect(
			isManagedAgentWorktree(agentId, join(TEST_HOME, "external-repo")),
		).toBe(false);
	});

	it("removes ADE-owned state without touching an external repository", async () => {
		const agentId = "external-agent";
		const agentHome = getAgentHome(agentId);
		const externalRepo = join(TEST_HOME, "external-repo");
		mkdirSync(join(agentHome, "memory"), { recursive: true });
		mkdirSync(externalRepo, { recursive: true });
		writeFileSync(join(externalRepo, "sentinel.txt"), "keep", "utf8");

		await removeAgentHome(agentId);

		expect(existsSync(agentHome)).toBe(false);
		expect(existsSync(join(externalRepo, "sentinel.txt"))).toBe(true);
	});

	it("rejects a path traversal agent id", async () => {
		await expect(removeAgentHome("..")).rejects.toThrow(
			"outside ADE's data directory",
		);
	});

	it("removes legacy app-owned Codex auth copies without touching profile data", () => {
		const globalAuth = join(TEST_HOME, "global-codex", "auth.json");
		const legacyAuth = join(
			getAgentHome("legacy-agent"),
			".codex",
			"auth.json",
		);
		const profileAuth = join(
			TEST_HOME,
			"provider-accounts",
			"codex",
			"profile-id",
			"auth.json",
		);
		const externalCodexHome = join(TEST_HOME, "external-codex-home");
		const externalAuth = join(externalCodexHome, "auth.json");
		const userOwnedAuth = join(
			getAgentHome("user-owned-agent"),
			".codex",
			"auth.json",
		);
		const linkedCodexHome = join(getAgentHome("linked-agent"), ".codex");
		mkdirSync(join(legacyAuth, ".."), { recursive: true });
		mkdirSync(join(globalAuth, ".."), { recursive: true });
		mkdirSync(join(userOwnedAuth, ".."), { recursive: true });
		mkdirSync(join(profileAuth, ".."), { recursive: true });
		mkdirSync(externalCodexHome, { recursive: true });
		mkdirSync(getAgentHome("linked-agent"), { recursive: true });
		symlinkSync(
			externalCodexHome,
			linkedCodexHome,
			process.platform === "win32" ? "junction" : "dir",
		);
		writeFileSync(legacyAuth, "legacy-secret", "utf8");
		writeFileSync(globalAuth, "legacy-secret", "utf8");
		writeFileSync(userOwnedAuth, "separate-login-secret", "utf8");
		writeFileSync(profileAuth, "provider-owned-secret", "utf8");
		writeFileSync(externalAuth, "external-secret", "utf8");

		expect(removeLegacyAgentCodexAuthFiles(globalAuth)).toBe(1);
		expect(existsSync(legacyAuth)).toBe(false);
		expect(existsSync(userOwnedAuth)).toBe(true);
		expect(existsSync(profileAuth)).toBe(true);
		expect(existsSync(externalAuth)).toBe(true);

		writeFileSync(legacyAuth, "new-login-secret", "utf8");
		expect(removeLegacyAgentCodexAuthFiles(globalAuth)).toBe(0);
		expect(existsSync(legacyAuth)).toBe(true);
	});
});
