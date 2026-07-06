/**
 * Workspace initialization progress types.
 * Used for streaming progress updates during workspace creation.
 */

export type WorkspaceInitStep =
	| "pending"
	// ADE agent-creation steps (see main/lib/agent-init.ts)
	| "creating_repo" // Creating / cloning the agent's repo
	| "scaffolding_memory" // Writing memory + bridge files
	// Legacy shared-repo worktree steps (dormant in ADE)
	| "syncing" // Syncing with remote
	| "verifying" // Verifying base branch exists
	| "fetching" // Fetching latest changes
	| "creating_worktree" // Creating git worktree
	| "copying_config" // Copying .superset configuration
	| "finalizing" // Final DB operations
	| "ready"
	| "failed";

export interface WorkspaceInitProgress {
	workspaceId: string;
	projectId: string;
	step: WorkspaceInitStep;
	message: string;
	error?: string;
}

export const INIT_STEP_MESSAGES: Record<WorkspaceInitStep, string> = {
	pending: "Preparing...",
	creating_repo: "Creating repository...",
	scaffolding_memory: "Initializing memory files...",
	syncing: "Syncing with remote...",
	verifying: "Verifying base branch...",
	fetching: "Fetching latest changes...",
	creating_worktree: "Creating git worktree...",
	copying_config: "Copying configuration...",
	finalizing: "Finalizing setup...",
	ready: "Ready",
	failed: "Failed",
};

/**
 * Order of steps for UI progress display (ADE agent creation).
 * Used to show completed/current/pending steps in the progress view.
 * The message for "creating_repo" is set dynamically (Creating vs Cloning).
 */
export const INIT_STEP_ORDER: WorkspaceInitStep[] = [
	"pending",
	"creating_repo",
	"scaffolding_memory",
	"ready",
];

/**
 * Get the index of a step in the progress order.
 * Returns -1 for "failed" since it's not part of the normal flow.
 */
export function getStepIndex(step: WorkspaceInitStep): number {
	if (step === "failed") return -1;
	return INIT_STEP_ORDER.indexOf(step);
}

/**
 * Check if a step is complete based on the current step.
 */
export function isStepComplete(
	step: WorkspaceInitStep,
	currentStep: WorkspaceInitStep,
): boolean {
	if (currentStep === "failed") return false;
	const stepIndex = getStepIndex(step);
	const currentIndex = getStepIndex(currentStep);
	return stepIndex < currentIndex;
}
