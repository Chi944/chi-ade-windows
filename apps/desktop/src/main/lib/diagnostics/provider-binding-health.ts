export type ProviderBindingHealthProvider = "claude" | "codex";

export interface ProviderBindingHealthPane {
	id: string;
	provider: ProviderBindingHealthProvider;
	workspaceId?: string;
	pinned: boolean;
	needsRebind: boolean;
	remote: boolean;
}

export type ProviderBindingReconciliationHealth =
	| { status: "completed"; result: unknown }
	| { status: "deferred" }
	| { status: "failed" };

export interface ProviderBindingHealthSummary {
	available: true;
	accountCount: number;
	bindingCount: number;
	unboundPaneCount: number;
	deferredCleanupCount: number;
}

function completedDeferredCount(
	reconciliation: ProviderBindingReconciliationHealth | undefined,
): number {
	if (reconciliation?.status !== "completed") return 1;
	if (!reconciliation.result || typeof reconciliation.result !== "object") {
		return 1;
	}
	const value = (reconciliation.result as Record<string, unknown>)
		.preservedUnresolvedBindings;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: 1;
}

export async function summarizeProviderBindingHealth(options: {
	accountCount: number;
	panes: readonly ProviderBindingHealthPane[];
	reconciliation?: ProviderBindingReconciliationHealth;
	readBinding: (input: {
		provider: ProviderBindingHealthProvider;
		paneId: string;
		workspaceId: string;
	}) => Promise<boolean>;
}): Promise<ProviderBindingHealthSummary> {
	let bindingCount = 0;
	let unboundPaneCount = 0;
	let unresolvedWorkspaceCount = 0;

	for (const pane of options.panes) {
		if (pane.remote || (!pane.pinned && !pane.needsRebind)) continue;
		if (!pane.workspaceId) {
			unboundPaneCount += 1;
			unresolvedWorkspaceCount += 1;
			continue;
		}
		const bound = await options.readBinding({
			provider: pane.provider,
			paneId: pane.id,
			workspaceId: pane.workspaceId,
		});
		if (bound) bindingCount += 1;
		if (!bound || pane.needsRebind) unboundPaneCount += 1;
	}

	return {
		available: true,
		accountCount: options.accountCount,
		bindingCount,
		unboundPaneCount,
		deferredCleanupCount:
			completedDeferredCount(options.reconciliation) + unresolvedWorkspaceCount,
	};
}
