import type { AgentRuntime } from "@superset/local-db";
import type { BaseTabsState, Pane } from "shared/tabs-types";

interface SanitizeSubscriptionProfilesForPersistenceInput<
	T extends BaseTabsState,
> {
	state: T;
	remoteWorkspaceIds?: ReadonlySet<string>;
	localWorkspaceIds?: ReadonlySet<string>;
}

export function sanitizeSubscriptionProfilesForPersistence<
	T extends BaseTabsState,
>({
	state,
	remoteWorkspaceIds,
	localWorkspaceIds,
}: SanitizeSubscriptionProfilesForPersistenceInput<T>): T {
	const workspaceIdsByTabId = new Map(
		state.tabs.map((tab) => [tab.id, tab.workspaceId] as const),
	);
	let nextPanes: BaseTabsState["panes"] | undefined;

	for (const [paneId, pane] of Object.entries(state.panes)) {
		const workspaceId = workspaceIdsByTabId.get(pane.tabId);
		const isRemote = Boolean(
			workspaceId && remoteWorkspaceIds?.has(workspaceId),
		);
		const isLocal = Boolean(workspaceId && localWorkspaceIds?.has(workspaceId));
		const isUnresolved = Boolean(
			(remoteWorkspaceIds !== undefined || localWorkspaceIds !== undefined) &&
				!isRemote &&
				!isLocal,
		);
		const hasTransientSelection = pane.subscriptionProfileId !== undefined;
		const isProviderTerminal =
			pane.type === "terminal" &&
			(pane.agentRuntime === "claude" || pane.agentRuntime === "codex");
		const hasPortableMarker =
			pane.subscriptionProfilePinned === true ||
			hasTransientSelection ||
			pane.subscriptionProfileNeedsRebind === true;
		const nextPinned = isRemote
			? undefined
			: isUnresolved
				? isProviderTerminal && pane.subscriptionProfilePinned === true
					? true
					: undefined
				: isLocal
					? isProviderTerminal
						? true
						: undefined
					: isProviderTerminal && hasPortableMarker
						? true
						: undefined;
		if (
			!hasTransientSelection &&
			pane.subscriptionProfilePinned === nextPinned &&
			pane.subscriptionProfileNeedsRebind === undefined
		)
			continue;

		nextPanes ??= { ...state.panes };
		nextPanes[paneId] = {
			...pane,
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: nextPinned,
			subscriptionProfileNeedsRebind: undefined,
		};
	}

	return nextPanes ? ({ ...state, panes: nextPanes } as T) : state;
}

interface LocalSubscriptionBinding {
	provider: "claude" | "codex";
	profileId: string | null;
}

interface ResolveSubscriptionProfileGateInput {
	agentRuntime?: AgentRuntime;
	subscriptionProfileId?: string | null;
	subscriptionProfilePinned?: boolean;
	binding: LocalSubscriptionBinding | null | undefined;
	isBindingLoading: boolean;
}

export type SubscriptionProfileGate = "loading" | "ready" | "rebind";

export function resolveSubscriptionProfileGate({
	agentRuntime,
	subscriptionProfileId,
	subscriptionProfilePinned,
	binding,
	isBindingLoading,
}: ResolveSubscriptionProfileGateInput): SubscriptionProfileGate {
	if (agentRuntime !== "claude" && agentRuntime !== "codex") return "ready";
	if (subscriptionProfileId !== undefined) return "ready";
	if (!subscriptionProfilePinned) return "ready";
	if (isBindingLoading) return "loading";
	return binding?.provider === agentRuntime ? "ready" : "rebind";
}

export function rebindPaneSubscriptionProfile(
	pane: Pane,
	profileId: string | null,
): Pane {
	return {
		...pane,
		subscriptionProfileId: profileId,
		subscriptionProfilePinned: true,
		subscriptionProfileNeedsRebind: undefined,
	};
}
