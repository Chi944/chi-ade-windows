import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import {
	getAgentHome,
	getAgentMemoryDir,
	getAgentWorktreePath,
} from "./agent-home";

/**
 * How an agent's repo is populated at creation time.
 * - init:  a fresh empty git repo (`git init` + empty initial commit)
 * - clone: clone a remote URL or a local path into the worktree
 * - existing: use an existing local git worktree in place (no copy)
 */
export type AgentRepoSource =
	| { type: "init" }
	| { type: "clone"; url: string }
	| { type: "existing"; path: string };

export interface AgentRepoResult {
	agentHome: string;
	worktreePath: string;
	memoryDir: string;
	branch: string;
}

export interface ExistingAgentRepo {
	worktreePath: string;
	branch: string;
}

/** Resolve and validate an existing checkout before ADE stores or scaffolds it. */
export async function resolveExistingAgentRepo(
	sourcePath: string,
): Promise<ExistingAgentRepo> {
	if (!sourcePath.trim()) {
		throw new Error("Existing repository path is required");
	}

	let selectedPath: string;
	try {
		selectedPath = realpathSync(sourcePath);
	} catch {
		throw new Error(`Existing repository path does not exist: ${sourcePath}`);
	}

	if (!statSync(selectedPath).isDirectory()) {
		throw new Error(
			`Existing repository path must be a directory: ${selectedPath}`,
		);
	}

	const git = simpleGit(selectedPath);
	let worktreePath: string;
	try {
		const gitRoot = (await git.revparse(["--show-toplevel"])).trim();
		worktreePath = realpathSync(gitRoot);
	} catch {
		throw new Error(
			`Path is not a Git repository or worktree: ${selectedPath}`,
		);
	}

	let branch: string;
	try {
		branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
	} catch {
		branch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
	}

	return { worktreePath, branch };
}

/**
 * Build an Agent's standalone repo + home layout on disk (ADE Phase B, risk #1).
 *
 * Managed init/clone sources live at <agent-home>/worktree. An existing source
 * reuses its local checkout in place; ADE still owns only the agent home's
 * canonical `memory/` dir. Returns the paths and checked-out branch so the
 * caller can persist a `worktrees` row.
 */
export async function setupAgentRepo({
	agentId,
	source,
}: {
	agentId: string;
	source: AgentRepoSource;
}): Promise<AgentRepoResult> {
	const agentHome = getAgentHome(agentId);
	const worktreePath = getAgentWorktreePath(agentId);
	const memoryDir = getAgentMemoryDir(agentId);

	if (source.type === "existing") {
		const existing = await resolveExistingAgentRepo(source.path);

		// External repositories keep their checkout in place. ADE owns only the
		// agent home (memory/config), which is safe to create after validation.
		mkdirSync(memoryDir, { recursive: true });
		return {
			agentHome,
			worktreePath: existing.worktreePath,
			memoryDir,
			branch: existing.branch,
		};
	}

	// Create the memory dir (this also creates <agent-home>). worktree/ is
	// created below by init/clone.
	mkdirSync(memoryDir, { recursive: true });

	// Retry-safety: if a valid repo already exists (previous attempt got this
	// far), reuse it. If a partial/non-repo dir exists, clear it so init/clone
	// starts clean.
	if (existsSync(join(worktreePath, ".git"))) {
		const branch =
			(
				await simpleGit(worktreePath)
					.revparse(["--abbrev-ref", "HEAD"])
					.catch(() => "main")
			).trim() || "main";
		return { agentHome, worktreePath, memoryDir, branch };
	}
	if (existsSync(worktreePath)) {
		rmSync(worktreePath, { recursive: true, force: true });
	}

	let branch: string;
	if (source.type === "clone") {
		await simpleGit().clone(source.url, worktreePath);
		branch =
			(await simpleGit(worktreePath)
				.revparse(["--abbrev-ref", "HEAD"])
				.catch(() => "main")) || "main";
		branch = branch.trim();
	} else {
		mkdirSync(worktreePath, { recursive: true });
		const git = simpleGit(worktreePath);
		try {
			await git.init(["--initial-branch=main"]);
		} catch {
			await git.init();
		}
		// Set a local identity so the empty initial commit works even when the
		// machine has no global git user configured. Fresh agent repos are
		// standalone, so a local identity is appropriate.
		await git.addConfig("user.name", "ADE Agent", false, "local");
		await git.addConfig("user.email", "agent@ade.local", false, "local");
		await git.raw(["commit", "--allow-empty", "-m", "Initial commit"]);
		branch =
			(await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "main")) ||
			"main";
		branch = branch.trim();
	}

	return { agentHome, worktreePath, memoryDir, branch };
}
