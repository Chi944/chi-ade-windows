import * as localDbZod from "@superset/local-db/schema/zod";

export const LOCAL_DB_TABLE_NAMES = [
	"agentMessageReceipts",
	"agentMessages",
	"browserHistory",
	"organizationMembers",
	"organizations",
	"projects",
	"remoteHosts",
	"remoteWorkspaceBindings",
	"settings",
	"sharedMemories",
	"tasks",
	"users",
	"workspaces",
	"worktrees",
] as const;

function mockTable(name: string): Record<string, string> {
	return {
		id: `${name}_id`,
		workspaceId: `${name}_workspace_id`,
	};
}

/**
 * Lightweight schema surface for tests that mock the native database itself.
 * Runtime validation constants come from the real zod module so they cannot
 * drift from production, while table objects remain dependency-free sentinels.
 */
export function createLocalDbSchemaMock(): Record<string, unknown> {
	return {
		...localDbZod,
		...Object.fromEntries(
			LOCAL_DB_TABLE_NAMES.map((name) => [name, mockTable(name)]),
		),
	};
}
