import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getSupersetHomeDir } from "./app-environment";

/**
 * Per-agent home directory layout (ADE).
 *
 * Each Agent (a `workspaces` row) owns a home dir under the app data dir:
 *
 *   <APP_DATA>/agents/<agentId>/
 *   ├── worktree/        the git repo/worktree; the CLI's cwd
 *   ├── memory/          canonical memory (source of truth, never committed)
 *   └── .codex/          Codex config + generated AGENTS.md (codex runtime only)
 *
 * Paths are DERIVED from the agent (workspace) id, not stored in the DB. See
 * docs/memory.md. `<APP_DATA>` is SUPERSET_HOME_DIR (~/.ade[-<ws>]).
 */

/**
 * Root of the agents directory. Resolved lazily (per call) rather than captured
 * in a module-level const so a late ADE_HOME_DIR override still routes paths
 * correctly — see getSupersetHomeDir in app-environment.ts.
 */
function agentsDir(): string {
	return join(getSupersetHomeDir(), "agents");
}

/** Root of an agent's home directory. */
export function getAgentHome(agentId: string): string {
	return join(agentsDir(), agentId);
}

/** The agent's git worktree (the runtime CLI's cwd). */
export function getAgentWorktreePath(agentId: string): string {
	return join(getAgentHome(agentId), "worktree");
}

/** The agent's canonical memory directory. */
export function getAgentMemoryDir(agentId: string): string {
	return join(getAgentHome(agentId), "memory");
}

/** CODEX_HOME for a codex-runtime agent (isolates its config/history). */
export function getAgentCodexHome(agentId: string): string {
	return join(getAgentHome(agentId), ".codex");
}

/** Whether a worktree is the copy owned by ADE for this agent. */
export function isManagedAgentWorktree(
	agentId: string,
	worktreePath: string,
): boolean {
	const expected = resolve(getAgentWorktreePath(agentId));
	const actual = resolve(worktreePath);
	return process.platform === "win32"
		? expected.toLowerCase() === actual.toLowerCase()
		: expected === actual;
}

/**
 * Remove only ADE-owned state for an agent. For a zero-copy agent, its linked
 * repository lives outside this directory and is deliberately untouched.
 */
export async function removeAgentHome(agentId: string): Promise<void> {
	const root = resolve(agentsDir());
	const home = resolve(getAgentHome(agentId));
	const childPath = relative(root, home);

	if (
		!childPath ||
		childPath === ".." ||
		childPath.startsWith(`..${sep}`) ||
		isAbsolute(childPath)
	) {
		throw new Error(
			"Refusing to remove an agent home outside ADE's data directory",
		);
	}

	await rm(home, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 200,
	});
}
