import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ADE_HOME = process.env.ADE_HOME_DIR;
const TEST_HOME = join(
	tmpdir(),
	`ade-agent-home-test-${process.pid}-${Date.now()}`,
);
process.env.ADE_HOME_DIR = TEST_HOME;

let getAgentHome: typeof import("./agent-home").getAgentHome;
let getAgentWorktreePath: typeof import("./agent-home").getAgentWorktreePath;
let isManagedAgentWorktree: typeof import("./agent-home").isManagedAgentWorktree;
let removeAgentHome: typeof import("./agent-home").removeAgentHome;

beforeAll(async () => {
	const home = await import("./agent-home");
	getAgentHome = home.getAgentHome;
	getAgentWorktreePath = home.getAgentWorktreePath;
	isManagedAgentWorktree = home.isManagedAgentWorktree;
	removeAgentHome = home.removeAgentHome;
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
});
