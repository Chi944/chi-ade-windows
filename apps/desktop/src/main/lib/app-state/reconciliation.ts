import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import type { PeerClaudeSessionHandoff } from "shared/tabs-sync";
import type { AppState, AppStateSyncEnvelope, TabsState } from "./schemas";

export type AppStateTrust = "trusted" | "recovered" | "untrusted";

export interface AppStateBindingReconciliationInput {
	stateTrust: AppStateTrust;
	durablePanes: ReadonlyArray<{
		paneId: string;
		provider: "claude" | "codex" | null;
		workspaceId?: string;
	}>;
	unresolvedWorkspaceIds?: ReadonlySet<string>;
}

export interface AppStateBindingReconciliationDependencies {
	resolveLocalWorkspaceId: (
		canonical: string,
		embeddedMeta?: AppStateSyncEnvelope["workspaceMetadata"][string],
		options?: { autoCreate?: boolean },
	) => string | null;
	getCanonicalForLocalWorkspaceId: (
		workspaceId: string,
	) => { canonical: string } | null;
	getRemoteWorkspaceIds: () => ReadonlySet<string>;
	reconcileBindings: (input: AppStateBindingReconciliationInput) => unknown;
}

export type AppStateBindingReconciliationOutcome =
	| { status: "completed"; result: unknown }
	| { status: "deferred"; warning: string }
	| { status: "failed"; warning: string };

export interface PreparedAppStateForStartup {
	state: AppState;
	outcome: AppStateBindingReconciliationOutcome;
	warnings: string[];
	startupPeerPaneIds: string[];
	startupPeerClaudeSessionHandoffs: PeerClaudeSessionHandoff[];
}

interface WorkspaceClassification {
	writerIsLocal: boolean;
	localizedWorkspaceIds: Map<string, string>;
	localWorkspaceIds: Set<string>;
	remoteWorkspaceIds: Set<string>;
	unresolvedWorkspaceIds: Set<string>;
	warnings: string[];
}

function addWarning(warnings: string[], warning: string): void {
	if (!warnings.includes(warning)) warnings.push(warning);
}

function workspaceIds(state: AppState): Set<string> {
	return new Set([
		...state.tabsState.tabs.map((tab) => tab.workspaceId),
		...Object.keys(state.tabsState.activeTabIds),
		...Object.keys(state.tabsState.tabHistoryStacks),
	]);
}

function classifyWorkspaces(
	state: AppState,
	localDeviceId: string,
	dependencies: AppStateBindingReconciliationDependencies,
): WorkspaceClassification {
	const writerIsLocal = state.sync.deviceId === localDeviceId;
	const knownRemoteIds = dependencies.getRemoteWorkspaceIds();
	const localizedWorkspaceIds = new Map<string, string>();
	const localWorkspaceIds = new Set<string>();
	const remoteWorkspaceIds = new Set<string>();
	const unresolvedWorkspaceIds = new Set<string>();
	const warnings: string[] = [];

	for (const writerWorkspaceId of workspaceIds(state)) {
		if (writerIsLocal) {
			localizedWorkspaceIds.set(writerWorkspaceId, writerWorkspaceId);
			if (knownRemoteIds.has(writerWorkspaceId)) {
				remoteWorkspaceIds.add(writerWorkspaceId);
				continue;
			}
			if (
				state.sync.localToCanonical[writerWorkspaceId] ||
				dependencies.getCanonicalForLocalWorkspaceId(writerWorkspaceId)
			) {
				localWorkspaceIds.add(writerWorkspaceId);
			} else {
				unresolvedWorkspaceIds.add(writerWorkspaceId);
			}
			continue;
		}

		const canonical = state.sync.localToCanonical[writerWorkspaceId];
		const localWorkspaceId = canonical
			? dependencies.resolveLocalWorkspaceId(
					canonical,
					state.sync.workspaceMetadata[canonical],
					{ autoCreate: false },
				)
			: null;
		if (!localWorkspaceId) {
			unresolvedWorkspaceIds.add(writerWorkspaceId);
			addWarning(
				warnings,
				"A peer workspace could not be resolved on this device.",
			);
			continue;
		}
		localizedWorkspaceIds.set(writerWorkspaceId, localWorkspaceId);
		if (knownRemoteIds.has(localWorkspaceId)) {
			remoteWorkspaceIds.add(localWorkspaceId);
		} else {
			localWorkspaceIds.add(localWorkspaceId);
		}
	}

	if (!writerIsLocal) {
		const writersByLocal = new Map<string, string[]>();
		for (const [writerWorkspaceId, localWorkspaceId] of localizedWorkspaceIds) {
			const writers = writersByLocal.get(localWorkspaceId) ?? [];
			writers.push(writerWorkspaceId);
			writersByLocal.set(localWorkspaceId, writers);
		}
		for (const [localWorkspaceId, writers] of writersByLocal) {
			if (writers.length <= 1) continue;
			for (const writerWorkspaceId of writers) {
				localizedWorkspaceIds.delete(writerWorkspaceId);
				unresolvedWorkspaceIds.add(writerWorkspaceId);
			}
			localWorkspaceIds.delete(localWorkspaceId);
			remoteWorkspaceIds.delete(localWorkspaceId);
			addWarning(warnings, "A peer workspace mapping collision was rejected.");
		}
	}

	return {
		writerIsLocal,
		localizedWorkspaceIds,
		localWorkspaceIds,
		remoteWorkspaceIds,
		unresolvedWorkspaceIds,
		warnings,
	};
}

function translateWorkspaceRecord<T>(
	record: Record<string, T>,
	localizedWorkspaceIds: ReadonlyMap<string, string>,
): Record<string, T> {
	return Object.fromEntries(
		Object.entries(record).flatMap(([writerWorkspaceId, value]) => {
			const localWorkspaceId = localizedWorkspaceIds.get(writerWorkspaceId);
			return localWorkspaceId
				? [[localWorkspaceId, structuredClone(value)] as const]
				: [];
		}),
	);
}

function localizeTabsState(
	state: TabsState,
	classification: WorkspaceClassification,
): TabsState {
	const tabs = state.tabs.flatMap((tab) => {
		const localWorkspaceId = classification.localizedWorkspaceIds.get(
			tab.workspaceId,
		);
		return localWorkspaceId ? [{ ...tab, workspaceId: localWorkspaceId }] : [];
	});
	const tabIds = new Set(tabs.map((tab) => tab.id));
	const panes = Object.fromEntries(
		Object.entries(state.panes)
			.filter(([, pane]) => tabIds.has(pane.tabId))
			.map(([paneId, pane]) => [paneId, structuredClone(pane)]),
	);
	const paneIds = new Set(Object.keys(panes));
	return {
		tabs,
		panes,
		activeTabIds: translateWorkspaceRecord(
			state.activeTabIds,
			classification.localizedWorkspaceIds,
		),
		focusedPaneIds: Object.fromEntries(
			Object.entries(state.focusedPaneIds).filter(
				([tabId, paneId]) => tabIds.has(tabId) && paneIds.has(paneId),
			),
		),
		tabHistoryStacks: translateWorkspaceRecord(
			state.tabHistoryStacks,
			classification.localizedWorkspaceIds,
		),
	};
}

function localizeState(
	state: AppState,
	localDeviceId: string,
	classification: WorkspaceClassification,
): AppState {
	const localizedTabs = localizeTabsState(state.tabsState, classification);
	const localizedPaneIds = new Set(Object.keys(localizedTabs.panes));
	const localToCanonical = Object.fromEntries(
		Object.entries(state.sync.localToCanonical).flatMap(
			([writerWorkspaceId, canonical]) => {
				const localWorkspaceId =
					classification.localizedWorkspaceIds.get(writerWorkspaceId);
				return localWorkspaceId ? [[localWorkspaceId, canonical] as const] : [];
			},
		),
	);
	const sanitizedTabs = sanitizeSubscriptionProfilesForPersistence({
		state: localizedTabs,
		localWorkspaceIds: classification.localWorkspaceIds,
		remoteWorkspaceIds: classification.remoteWorkspaceIds,
	});
	return {
		...structuredClone(state),
		tabsState: sanitizedTabs,
		sync: {
			...structuredClone(state.sync),
			deviceId: localDeviceId,
			localToCanonical,
			paneClaudeSessions: Object.fromEntries(
				Object.entries(state.sync.paneClaudeSessions).filter(([paneId]) =>
					localizedPaneIds.has(paneId),
				),
			),
		},
	};
}

function durablePanes(
	localizedState: AppState,
	originalState: AppState,
	classification: WorkspaceClassification,
): AppStateBindingReconciliationInput["durablePanes"] {
	const workspaceIdByTabId = new Map(
		localizedState.tabsState.tabs.map(
			(tab) => [tab.id, tab.workspaceId] as const,
		),
	);
	const durable = Object.values(localizedState.tabsState.panes).map((pane) => {
		const workspaceId = workspaceIdByTabId.get(pane.tabId);
		const provider =
			workspaceId &&
			!classification.remoteWorkspaceIds.has(workspaceId) &&
			pane.type === "terminal" &&
			(pane.agentRuntime === "claude" || pane.agentRuntime === "codex")
				? pane.agentRuntime
				: null;
		return { paneId: pane.id, provider, workspaceId };
	});
	if (classification.writerIsLocal) return durable;

	const originalWorkspaceIdByTabId = new Map(
		originalState.tabsState.tabs.map(
			(tab) => [tab.id, tab.workspaceId] as const,
		),
	);
	for (const pane of Object.values(originalState.tabsState.panes)) {
		const workspaceId = originalWorkspaceIdByTabId.get(pane.tabId);
		if (
			!workspaceId ||
			!classification.unresolvedWorkspaceIds.has(workspaceId)
		) {
			continue;
		}
		const provider =
			pane.type === "terminal" &&
			(pane.agentRuntime === "claude" || pane.agentRuntime === "codex")
				? pane.agentRuntime
				: null;
		durable.push({ paneId: pane.id, provider, workspaceId });
	}
	return durable;
}

function startupPeerData(
	state: AppState,
	classification: WorkspaceClassification,
): Pick<
	PreparedAppStateForStartup,
	"startupPeerPaneIds" | "startupPeerClaudeSessionHandoffs"
> {
	if (classification.writerIsLocal) {
		return {
			startupPeerPaneIds: [],
			startupPeerClaudeSessionHandoffs: [],
		};
	}
	const workspaceIdByTabId = new Map(
		state.tabsState.tabs.map((tab) => [tab.id, tab.workspaceId] as const),
	);
	const terminalPanes = Object.values(state.tabsState.panes)
		.filter((pane) => pane.type === "terminal")
		.sort((left, right) => left.id.localeCompare(right.id));
	return {
		startupPeerPaneIds: terminalPanes.map((pane) => pane.id),
		startupPeerClaudeSessionHandoffs: terminalPanes.flatMap((pane) => {
			const workspaceId = workspaceIdByTabId.get(pane.tabId);
			const claudeSessionId = state.sync.paneClaudeSessions[pane.id];
			return workspaceId && claudeSessionId
				? [{ paneId: pane.id, workspaceId, claudeSessionId }]
				: [];
		}),
	};
}

export function prepareAppStateForStartup(input: {
	state: AppState;
	trust: AppStateTrust;
	localDeviceId: string;
	dependencies: AppStateBindingReconciliationDependencies;
}): PreparedAppStateForStartup {
	if (input.trust !== "trusted") {
		return {
			state: structuredClone(input.state),
			outcome: {
				status: "deferred",
				warning:
					"Provider account binding cleanup was deferred because app state is not trusted.",
			},
			warnings: [],
			startupPeerPaneIds: [],
			startupPeerClaudeSessionHandoffs: [],
		};
	}

	let classification: WorkspaceClassification;
	try {
		classification = classifyWorkspaces(
			input.state,
			input.localDeviceId,
			input.dependencies,
		);
	} catch {
		const writerIsLocal = input.state.sync.deviceId === input.localDeviceId;
		const unresolvedWorkspaceIds = workspaceIds(input.state);
		classification = {
			writerIsLocal,
			localizedWorkspaceIds: writerIsLocal
				? new Map(
						[...unresolvedWorkspaceIds].map((workspaceId) => [
							workspaceId,
							workspaceId,
						]),
					)
				: new Map(),
			localWorkspaceIds: new Set(),
			remoteWorkspaceIds: new Set(),
			unresolvedWorkspaceIds,
			warnings: [
				"Workspace localization failed and unresolved peer workspaces were skipped.",
			],
		};
		const state = localizeState(
			input.state,
			input.localDeviceId,
			classification,
		);
		return {
			state,
			outcome: {
				status: "failed",
				warning:
					"Provider account binding cleanup failed and was safely deferred.",
			},
			warnings: classification.warnings,
			...startupPeerData(state, classification),
		};
	}

	const state = localizeState(input.state, input.localDeviceId, classification);
	try {
		const result = input.dependencies.reconcileBindings({
			stateTrust: "trusted",
			durablePanes: durablePanes(state, input.state, classification),
			unresolvedWorkspaceIds: classification.unresolvedWorkspaceIds,
		});
		return {
			state,
			outcome: { status: "completed", result },
			warnings: classification.warnings,
			...startupPeerData(state, classification),
		};
	} catch {
		return {
			state,
			outcome: {
				status: "failed",
				warning:
					"Provider account binding cleanup failed and was safely deferred.",
			},
			warnings: classification.warnings,
			...startupPeerData(state, classification),
		};
	}
}
