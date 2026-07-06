import { worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { getAgentWorktreePath } from "./agent-home";
import { localDb } from "./local-db";

/**
 * Resolve an agent's real worktree path — the single source of truth shared by
 * agent creation (agent-init.ts) and the launch backfill (agent-memory-backfill
 * .ts). The path lives on the `worktrees` row (joined via `workspaces
 * .worktreeId`), which is what the create flow persists.
 *
 * For the standard init/clone flows this equals the derived
 * <agent-home>/worktree, so behavior is unchanged. It exists so that if a
 * worktree is ever an EXTERNAL path (a local-path agent whose repo lives outside
 * the agent home), both the scaffold's bridge generation and the backfill target
 * the real repo instead of a derived dir that doesn't exist.
 *
 * Falls back to the derived path when the agent has no worktree row/id yet
 * (still initializing) or the lookup fails.
 */
export function resolveAgentWorktreePath(
	agentId: string,
	worktreeId: string | null | undefined,
): string {
	const derived = getAgentWorktreePath(agentId);
	if (!worktreeId) return derived;
	try {
		const row = localDb
			.select({ path: worktrees.path })
			.from(worktrees)
			.where(eq(worktrees.id, worktreeId))
			.get();
		return row?.path?.trim() || derived;
	} catch {
		return derived;
	}
}
