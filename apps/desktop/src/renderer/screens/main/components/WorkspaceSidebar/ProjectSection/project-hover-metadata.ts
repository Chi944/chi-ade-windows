interface WorkspaceReference {
	id: string;
}

interface TabReference {
	id: string;
	workspaceId: string;
}

interface PaneReference {
	tabId: string;
	type: string;
}

export function countProjectTerminalThreads({
	workspaces,
	tabs,
	panes,
}: {
	workspaces: WorkspaceReference[];
	tabs: TabReference[];
	panes: Record<string, PaneReference>;
}): number {
	const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
	const projectTabIds = new Set(
		tabs
			.filter((tab) => workspaceIds.has(tab.workspaceId))
			.map((tab) => tab.id),
	);

	// A split tab can contain multiple independent agent terminals. Count each
	// terminal pane so the hover total matches the live sessions the user sees.
	return Object.values(panes).filter(
		(pane) => pane.type === "terminal" && projectTabIds.has(pane.tabId),
	).length;
}

export function getProjectOwnerLabel({
	githubOwner,
	profileName,
}: {
	githubOwner: string | null;
	profileName: string | null | undefined;
}): string {
	return githubOwner?.trim() || profileName?.trim() || "Local profile";
}

export function getProjectPathLabel(mainRepoPath: string): string {
	return mainRepoPath || "Agent-owned folders (no shared root)";
}
