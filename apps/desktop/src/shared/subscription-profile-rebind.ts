import type { AgentRuntime } from "@superset/local-db";
import type { BaseTabsState, Pane } from "shared/tabs-types";

interface SanitizeSubscriptionProfilesForPersistenceInput {
	state: TabsState;
	remoteWorkspaceIds?: ReadonlySet<string>;
}

type TabsState = BaseTabsState;

export function sanitizeSubscriptionProfilesForPersistence({
	state,
	remoteWorkspaceIds,
}: SanitizeSubscriptionProfilesForPersistenceInput): TabsState {
	const remoteTabIds = new Set(
		state.tabs
			.filter((tab) => remoteWorkspaceIds?.has(tab.workspaceId))
			.map((tab) => tab.id),
	);
	let nextPanes: TabsState["panes"] | undefined;

	for (const [paneId, pane] of Object.entries(state.panes)) {
		const isRemote = remoteTabIds.has(pane.tabId);
		const hasTransientSelection = pane.subscriptionProfileId !== undefined;
		const nextPinned = isRemote
			? undefined
			: pane.subscriptionProfilePinned === true ||
					hasTransientSelection ||
					pane.subscriptionProfileNeedsRebind === true
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

	return nextPanes ? { ...state, panes: nextPanes } : state;
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
