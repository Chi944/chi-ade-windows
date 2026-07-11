import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";

const TEST_ROOT = join(
	realpathSync(tmpdir()),
	`ade-agent-repo-test-${process.pid}-${Date.now()}`,
);
const TEST_HOME = join(TEST_ROOT, "ade-home");
const ORIGINAL_ADE_HOME = process.env.ADE_HOME_DIR;

let getAgentMemoryDir: (agentId: string) => string;
let getAgentWorktreePath: (agentId: string) => string;
let setupAgentRepo: typeof import("./agent-repo").setupAgentRepo;

beforeAll(async () => {
	process.env.ADE_HOME_DIR = TEST_HOME;
	mkdirSync(TEST_ROOT, { recursive: true });

	const home = await import("./agent-home");
	getAgentMemoryDir = home.getAgentMemoryDir;
	getAgentWorktreePath = home.getAgentWorktreePath;
	setupAgentRepo = (await import("./agent-repo")).setupAgentRepo;
});

afterAll(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
	if (ORIGINAL_ADE_HOME === undefined) {
		delete process.env.ADE_HOME_DIR;
	} else {
		process.env.ADE_HOME_DIR = ORIGINAL_ADE_HOME;
	}
});

async function createRepo(path: string, branch: string): Promise<void> {
	mkdirSync(path, { recursive: true });
	const git = simpleGit(path);
	await git.init([`--initial-branch=${branch}`]);
	await git.addConfig("user.name", "ADE Test", false, "local");
	await git.addConfig("user.email", "test@ade.local", false, "local");
	await git.addConfig("commit.gpgsign", "false", false, "local");
	writeFileSync(join(path, "sentinel.txt"), "keep me", "utf8");
	await git.add("sentinel.txt");
	await git.commit("Initial commit");
}

describe("setupAgentRepo existing source", () => {
	it("uses an existing repository in place and creates only ADE memory", async () => {
		const agentId = "existing-repo";
		const repoPath = join(TEST_ROOT, "repos", "project");
		await createRepo(repoPath, "feature/existing");

		const result = await setupAgentRepo({
			agentId,
			source: { type: "existing", path: join(repoPath, ".") },
		});

		expect(result.worktreePath).toBe(await realpath(repoPath));
		expect(result.branch).toBe("feature/existing");
		expect(result.memoryDir).toBe(getAgentMemoryDir(agentId));
		expect(existsSync(result.memoryDir)).toBe(true);
		expect(existsSync(getAgentWorktreePath(agentId))).toBe(false);
		expect(existsSync(join(repoPath, "sentinel.txt"))).toBe(true);
	});

	it("accepts a linked Git worktree whose .git entry is a file", async () => {
		const agentId = "existing-worktree";
		const repoPath = join(TEST_ROOT, "repos", "main-project");
		const linkedPath = join(TEST_ROOT, "repos", "linked-worktree");
		await createRepo(repoPath, "main");
		await simpleGit(repoPath).raw([
			"worktree",
			"add",
			"-b",
			"feature/linked",
			linkedPath,
		]);

		const result = await setupAgentRepo({
			agentId,
			source: { type: "existing", path: linkedPath },
		});

		expect(result.worktreePath).toBe(await realpath(linkedPath));
		expect(result.branch).toBe("feature/linked");
		expect(existsSync(getAgentWorktreePath(agentId))).toBe(false);
	}, 15_000);

	it("rejects a directory nested inside a repository", async () => {
		const agentId = "nested-repo-directory";
		const repoPath = join(TEST_ROOT, "repos", "nested-project");
		const nestedPath = join(repoPath, "src");
		await createRepo(repoPath, "main");
		mkdirSync(nestedPath, { recursive: true });

		await expect(
			setupAgentRepo({
				agentId,
				source: { type: "existing", path: nestedPath },
			}),
		).rejects.toThrow("not a Git repository or worktree");
		expect(existsSync(getAgentMemoryDir(agentId))).toBe(false);
	});

	it("rejects a missing path without creating an agent home", async () => {
		const agentId = "missing-repo";
		const missingPath = join(TEST_ROOT, "missing");

		await expect(
			setupAgentRepo({
				agentId,
				source: { type: "existing", path: missingPath },
			}),
		).rejects.toThrow("does not exist");
		expect(existsSync(getAgentMemoryDir(agentId))).toBe(false);
	});

	it("rejects a non-Git directory without modifying it", async () => {
		const agentId = "not-a-repo";
		const directory = join(TEST_ROOT, "not-a-repo");
		const sentinel = join(directory, "sentinel.txt");
		mkdirSync(directory, { recursive: true });
		writeFileSync(sentinel, "keep me", "utf8");

		await expect(
			setupAgentRepo({
				agentId,
				source: { type: "existing", path: directory },
			}),
		).rejects.toThrow("not a Git repository or worktree");
		expect(existsSync(sentinel)).toBe(true);
		expect(existsSync(getAgentMemoryDir(agentId))).toBe(false);
	});
});
