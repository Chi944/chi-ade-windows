import { createHash, timingSafeEqual } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
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

/**
 * Remove credential files created by ADE versions that copied or symlinked the
 * global Codex auth file into every agent home. Symlinks are removed directly;
 * a regular file is removed only when its bounded content exactly matches the
 * current global auth file. This preserves a genuine login created inside an
 * isolated agent home. Provider-owned profile homes are outside `agents/`.
 */
export function removeLegacyAgentCodexAuthFiles(
	globalAuthPath = join(homedir(), ".codex", "auth.json"),
): number {
	const migrationDir = join(getSupersetHomeDir(), "security-migrations");
	const migrationMarker = join(
		migrationDir,
		"removed-legacy-agent-codex-auth-v1",
	);
	if (existsSync(migrationMarker)) return 0;

	const root = agentsDir();
	if (!existsSync(root)) {
		mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
		writeFileSync(migrationMarker, "completed\n", { mode: 0o600 });
		return 0;
	}
	let removed = 0;
	let incomplete = false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const agentHome = join(root, entry.name);
		const codexHome = join(agentHome, ".codex");
		const authPath = join(codexHome, "auth.json");
		try {
			const codexHomeStat = lstatSync(codexHome);
			if (codexHomeStat.isSymbolicLink()) continue;
			const relativeCodexHome = relative(
				realpathSync(agentHome),
				realpathSync(codexHome),
			);
			if (
				relativeCodexHome.startsWith(`..${sep}`) ||
				relativeCodexHome === ".." ||
				isAbsolute(relativeCodexHome)
			) {
				continue;
			}
			const authStat = lstatSync(authPath);
			if (
				authStat.isSymbolicLink() ||
				(authStat.isFile() && authFilesMatch(authPath, globalAuthPath))
			) {
				unlinkSync(authPath);
				removed += 1;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
		}
	}
	if (!incomplete) {
		mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
		writeFileSync(migrationMarker, "completed\n", { mode: 0o600 });
	}
	return removed;
}

function authFilesMatch(leftPath: string, rightPath: string): boolean {
	const MAX_AUTH_FILE_BYTES = 1024 * 1024;
	try {
		const left = lstatSync(leftPath);
		const right = lstatSync(rightPath);
		if (
			!left.isFile() ||
			!right.isFile() ||
			left.isSymbolicLink() ||
			right.isSymbolicLink() ||
			left.size !== right.size ||
			left.size > MAX_AUTH_FILE_BYTES ||
			statSync(leftPath).size !== left.size ||
			statSync(rightPath).size !== right.size
		) {
			return false;
		}
		const digest = (path: string) =>
			createHash("sha256").update(readFileSync(path)).digest();
		return timingSafeEqual(digest(leftPath), digest(rightPath));
	} catch {
		return false;
	}
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
