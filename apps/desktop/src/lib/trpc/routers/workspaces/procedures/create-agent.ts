import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { workspaces, worktrees } from "@superset/local-db";
import { and, eq, isNotNull } from "drizzle-orm";
import { getAgentWorktreePath } from "main/lib/agent-home";
import { beginAgentInit } from "main/lib/agent-init";
import { resolveExistingAgentRepo } from "main/lib/agent-repo";
import { localDb } from "main/lib/local-db";
import { v4 as uuidv4 } from "uuid";
import { publicProcedure, router } from "../../..";
import {
	activateProject,
	getMaxWorkspaceTabOrder,
	getProject,
	setLastActiveWorkspace,
} from "../utils/db-helpers";
import { createAgentInput } from "./create-agent-input";

function repoPathKey(repoPath: string): string {
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(repoPath);
	} catch {
		canonicalPath = resolve(repoPath);
	}
	return process.platform === "win32"
		? canonicalPath.toLocaleLowerCase("en-US")
		: canonicalPath;
}

/**
 * ADE: create an Agent (a `workspaces` row) with its OWN standalone git repo.
 *
 * Unlike the shared-repo `create` procedure (`git worktree add` off the
 * project's mainRepoPath), an Agent owns a repo at <agent-home>/worktree. The
 * DB rows are inserted immediately with a null gitStatus, then a BACKGROUND job
 * (beginAgentInit) builds the repo + memory scaffold and streams progress to
 * WorkspaceInitializingView — a slow clone must never block this call. The
 * Agent's Category is the `projectId`; project.mainRepoPath is not read.
 */
export const createAgentProcedures = () => {
	return router({
		createAgent: publicProcedure
			.input(createAgentInput)
			.mutation(async ({ input }) => {
				const project = getProject(input.projectId);
				if (!project) {
					throw new Error(`Category ${input.projectId} not found`);
				}

				const agentId = uuidv4();
				let source = input.repo;
				let worktreePath = getAgentWorktreePath(agentId);
				// Clone/init sources begin with a placeholder; the background job
				// resolves their real branch. Existing repositories resolve below.
				let branch = "main";

				if (source.type === "existing") {
					const existing = await resolveExistingAgentRepo(source.path);
					const existingPathKey = repoPathKey(existing.worktreePath);
					const duplicate = localDb
						.select({ name: workspaces.name, path: worktrees.path })
						.from(workspaces)
						.innerJoin(worktrees, eq(workspaces.worktreeId, worktrees.id))
						.where(
							and(
								isNotNull(workspaces.runtime),
								isNotNull(workspaces.worktreeId),
							),
						)
						.all()
						.find(({ path }) => repoPathKey(path) === existingPathKey);

					if (duplicate) {
						throw new Error(
							`This repository is already linked to agent "${duplicate.name}". One zero-copy repository can belong to only one ADE agent.`,
						);
					}

					worktreePath = existing.worktreePath;
					branch = existing.branch;
					source = { type: "existing", path: existing.worktreePath };
				}

				// gitStatus is null until the init job completes, so the content
				// view shows the checklist (see workspace/$workspaceId/page.tsx
				// hasIncompleteInit) rather than a broken terminal.
				const worktree = localDb
					.insert(worktrees)
					.values({
						projectId: input.projectId,
						path: worktreePath,
						branch,
						baseBranch: branch,
						gitStatus: null,
					})
					.returning()
					.get();

				const maxTabOrder = getMaxWorkspaceTabOrder(input.projectId);
				const workspace = localDb
					.insert(workspaces)
					.values({
						id: agentId,
						projectId: input.projectId,
						worktreeId: worktree.id,
						type: "worktree",
						branch,
						name: input.name,
						runtime: input.runtime,
						isUnnamed: false,
						tabOrder: maxTabOrder + 1,
					})
					.returning()
					.get();

				activateProject(project);
				setLastActiveWorkspace(agentId);

				// Build the repo + memory scaffold in the background.
				beginAgentInit(agentId, {
					categoryId: input.projectId,
					worktreeId: worktree.id,
					agentName: input.name,
					role: input.role,
					runtime: input.runtime,
					source,
				});

				return {
					workspace,
					worktreePath,
					worktreeId: worktree.id,
					isInitializing: true,
				};
			}),
	});
};
