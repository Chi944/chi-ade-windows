import type {
	AppStateSyncEnvelope,
	TabsState,
} from "../main/lib/app-state/schemas";

export interface WorkspaceClock {
	deviceId: string;
	at: number;
}

export interface PortableWorkspaceIdentity {
	canonical: string;
	metadata: AppStateSyncEnvelope["workspaceMetadata"][string];
}

export type LocalWorkspaceIdentityResolution =
	| ({ status: "verified" } & PortableWorkspaceIdentity)
	| { status: "missing" | "ambiguous" | "deleted" | "unresolved" };

export interface SeededWorkspaceClocks {
	clocks: Record<string, WorkspaceClock>;
	warnings: string[];
}

export interface LocalTabsStampResult {
	envelope: AppStateSyncEnvelope;
	changedCanonicalIds: string[];
	warnings: string[];
}

export interface PeerClaudeSessionHandoff {
	paneId: string;
	workspaceId: string;
	claudeSessionId: string;
}

export interface TabsMergePlan {
	tabsState: TabsState;
	envelope: AppStateSyncEnvelope;
	winningCanonicalIds: string[];
	rejectedCanonicalIds: string[];
	nextClocks: Record<string, WorkspaceClock>;
	peerClaudeSessionHandoffs: PeerClaudeSessionHandoff[];
	importedPeerPaneIds: string[];
	warnings: string[];
}

function isWorkspaceClock(value: unknown): value is WorkspaceClock {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as WorkspaceClock).deviceId === "string" &&
		(value as WorkspaceClock).deviceId.length > 0 &&
		typeof (value as WorkspaceClock).at === "number" &&
		Number.isFinite((value as WorkspaceClock).at) &&
		(value as WorkspaceClock).at >= 0
	);
}

export function compareWorkspaceClocks(
	left: WorkspaceClock,
	right: WorkspaceClock,
): number {
	if (left.at !== right.at) return left.at < right.at ? -1 : 1;
	if (left.deviceId === right.deviceId) return 0;
	return left.deviceId < right.deviceId ? -1 : 1;
}

function addWarning(warnings: string[], warning: string): void {
	if (!warnings.includes(warning)) warnings.push(warning);
}

export function seedWorkspaceClocks(
	envelope: AppStateSyncEnvelope,
): SeededWorkspaceClocks {
	const clocks: Record<string, WorkspaceClock> = {};
	const warnings: string[] = [];
	for (const source of [
		envelope.perWorkspaceWrittenAt,
		envelope.workspaceTombstones,
	]) {
		for (const [canonical, value] of Object.entries(source)) {
			if (!isWorkspaceClock(value)) {
				addWarning(warnings, "A workspace clock was invalid and was ignored.");
				continue;
			}
			const current = clocks[canonical];
			if (!current || compareWorkspaceClocks(value, current) > 0) {
				clocks[canonical] = { ...value };
			}
		}
	}
	return { clocks, warnings };
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.flatMap((key) => {
			const entry = record[key];
			return entry === undefined
				? []
				: [`${JSON.stringify(key)}:${stableJson(entry)}`];
		})
		.join(",")}}`;
}

function fnv1a64(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= BigInt(value.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}

export function hashTabsState(tabsState: TabsState): string {
	return fnv1a64(stableJson(tabsState));
}

function workspaceIds(tabsState: TabsState): Set<string> {
	const ids = new Set(tabsState.tabs.map((tab) => tab.workspaceId));
	for (const workspaceId of Object.keys(tabsState.activeTabIds)) {
		ids.add(workspaceId);
	}
	for (const workspaceId of Object.keys(tabsState.tabHistoryStacks)) {
		ids.add(workspaceId);
	}
	return ids;
}

function workspaceSlice(tabsState: TabsState, workspaceId: string): TabsState {
	const tabs = tabsState.tabs.filter((tab) => tab.workspaceId === workspaceId);
	const tabIds = new Set(tabs.map((tab) => tab.id));
	return {
		tabs,
		panes: Object.fromEntries(
			Object.entries(tabsState.panes).filter(([, pane]) =>
				tabIds.has(pane.tabId),
			),
		),
		activeTabIds: Object.hasOwn(tabsState.activeTabIds, workspaceId)
			? { [workspaceId]: tabsState.activeTabIds[workspaceId] }
			: {},
		focusedPaneIds: Object.fromEntries(
			Object.entries(tabsState.focusedPaneIds).filter(([tabId]) =>
				tabIds.has(tabId),
			),
		),
		tabHistoryStacks: Object.hasOwn(tabsState.tabHistoryStacks, workspaceId)
			? { [workspaceId]: tabsState.tabHistoryStacks[workspaceId] }
			: {},
	};
}

export function changedTabsWorkspaceIds(
	previousTabs: TabsState,
	nextTabs: TabsState,
): string[] {
	const ids = new Set([
		...workspaceIds(previousTabs),
		...workspaceIds(nextTabs),
	]);
	return [...ids]
		.filter(
			(workspaceId) =>
				hashTabsState(workspaceSlice(previousTabs, workspaceId)) !==
				hashTabsState(workspaceSlice(nextTabs, workspaceId)),
		)
		.sort();
}

/** Overlay renderer-local workspace changes onto the latest main snapshot. */
export function overlayTabsWorkspaceChanges(input: {
	currentTabs: TabsState;
	incomingTabs: TabsState;
	changedWorkspaceIds: readonly string[];
}): TabsState {
	const changedWorkspaceIds = new Set(input.changedWorkspaceIds);
	const retainedTabs = input.currentTabs.tabs.filter(
		(tab) => !changedWorkspaceIds.has(tab.workspaceId),
	);
	const incomingTabs = input.incomingTabs.tabs.filter((tab) =>
		changedWorkspaceIds.has(tab.workspaceId),
	);
	const retainedTabIds = new Set(retainedTabs.map((tab) => tab.id));
	const incomingTabIds = new Set(incomingTabs.map((tab) => tab.id));
	const panes = Object.fromEntries(
		Object.entries(input.currentTabs.panes).filter(([, pane]) =>
			retainedTabIds.has(pane.tabId),
		),
	);
	for (const [paneId, pane] of Object.entries(input.incomingTabs.panes)) {
		if (incomingTabIds.has(pane.tabId)) panes[paneId] = pane;
	}
	const activeTabIds = Object.fromEntries(
		Object.entries(input.currentTabs.activeTabIds).filter(
			([workspaceId]) => !changedWorkspaceIds.has(workspaceId),
		),
	);
	const tabHistoryStacks = Object.fromEntries(
		Object.entries(input.currentTabs.tabHistoryStacks).filter(
			([workspaceId]) => !changedWorkspaceIds.has(workspaceId),
		),
	);
	for (const workspaceId of changedWorkspaceIds) {
		if (Object.hasOwn(input.incomingTabs.activeTabIds, workspaceId)) {
			activeTabIds[workspaceId] = input.incomingTabs.activeTabIds[workspaceId];
		}
		if (Object.hasOwn(input.incomingTabs.tabHistoryStacks, workspaceId)) {
			tabHistoryStacks[workspaceId] =
				input.incomingTabs.tabHistoryStacks[workspaceId];
		}
	}
	const focusedPaneIds = Object.fromEntries(
		Object.entries(input.currentTabs.focusedPaneIds).filter(([tabId]) =>
			retainedTabIds.has(tabId),
		),
	);
	for (const [tabId, paneId] of Object.entries(
		input.incomingTabs.focusedPaneIds,
	)) {
		if (incomingTabIds.has(tabId)) focusedPaneIds[tabId] = paneId;
	}
	return {
		tabs: [...retainedTabs, ...incomingTabs],
		panes,
		activeTabIds,
		focusedPaneIds,
		tabHistoryStacks,
	};
}

function workspaceSessionSlice(
	tabsState: TabsState,
	paneClaudeSessions: Record<string, string>,
	workspaceId: string,
): Record<string, string> {
	const tabIds = new Set(
		tabsState.tabs
			.filter((tab) => tab.workspaceId === workspaceId)
			.map((tab) => tab.id),
	);
	return Object.fromEntries(
		Object.entries(paneClaudeSessions).filter(([paneId]) => {
			const pane = tabsState.panes[paneId];
			return pane ? tabIds.has(pane.tabId) : false;
		}),
	);
}

function maxKnownTimestamp(envelope: AppStateSyncEnvelope): number {
	let latest = Number.isFinite(envelope.lastWrittenAt)
		? envelope.lastWrittenAt
		: 0;
	for (const clock of Object.values(seedWorkspaceClocks(envelope).clocks)) {
		latest = Math.max(latest, clock.at);
	}
	return latest;
}

export function stampLocalTabsMutation(input: {
	previousTabs: TabsState;
	nextTabs: TabsState;
	envelope: AppStateSyncEnvelope;
	identities: Record<string, LocalWorkspaceIdentityResolution | undefined>;
	deviceId: string;
	now: number;
	paneClaudeSessions: Record<string, string>;
}): LocalTabsStampResult {
	const nextEnvelope = structuredClone(input.envelope);
	const warnings: string[] = [];
	const changedWorkspaceIds: string[] = [];
	const ids = new Set([
		...workspaceIds(input.previousTabs),
		...workspaceIds(input.nextTabs),
	]);
	for (const workspaceId of ids) {
		if (
			hashTabsState(workspaceSlice(input.previousTabs, workspaceId)) !==
				hashTabsState(workspaceSlice(input.nextTabs, workspaceId)) ||
			stableJson(
				workspaceSessionSlice(
					input.previousTabs,
					input.envelope.paneClaudeSessions,
					workspaceId,
				),
			) !==
				stableJson(
					workspaceSessionSlice(
						input.nextTabs,
						input.paneClaudeSessions,
						workspaceId,
					),
				)
		) {
			changedWorkspaceIds.push(workspaceId);
		}
	}

	const timestamp = Math.max(input.now, maxKnownTimestamp(input.envelope) + 1);
	const changedCanonicalIds: string[] = [];
	const changedWorkspaceIdSet = new Set(changedWorkspaceIds);
	const claimedCanonicalIds = new Map<string, string>();
	const invalidatePersistedIdentity = (workspaceId: string): void => {
		const staleCanonical = nextEnvelope.localToCanonical[workspaceId];
		delete nextEnvelope.localToCanonical[workspaceId];
		if (
			!staleCanonical ||
			Object.values(nextEnvelope.localToCanonical).includes(staleCanonical)
		) {
			return;
		}
		delete nextEnvelope.perWorkspaceWrittenAt[staleCanonical];
		if (!nextEnvelope.workspaceTombstones[staleCanonical]) {
			delete nextEnvelope.workspaceMetadata[staleCanonical];
		}
	};
	// Proven ambiguity or a verified canonical change can be discovered during a
	// different workspace mutation, so clear stale mappings globally. A transient
	// read failure is destructive only for the workspace actually being changed.
	for (const workspaceId of ids) {
		const resolution = input.identities[workspaceId];
		const persistedCanonical = input.envelope.localToCanonical[workspaceId];
		const hasTabs = input.nextTabs.tabs.some(
			(tab) => tab.workspaceId === workspaceId,
		);
		const shouldInvalidate =
			(resolution?.status === "verified" &&
				Boolean(persistedCanonical) &&
				persistedCanonical !== resolution.canonical) ||
			resolution?.status === "ambiguous" ||
			resolution?.status === "missing" ||
			(resolution?.status === "deleted" && hasTabs) ||
			((resolution === undefined || resolution.status === "unresolved") &&
				changedWorkspaceIdSet.has(workspaceId));
		if (shouldInvalidate) {
			invalidatePersistedIdentity(workspaceId);
		}
	}

	for (const workspaceId of changedWorkspaceIds.sort()) {
		const resolution = input.identities[workspaceId];
		const persistedCanonical = input.envelope.localToCanonical[workspaceId];
		const hasTabs = input.nextTabs.tabs.some(
			(tab) => tab.workspaceId === workspaceId,
		);
		const canUseDeletionFallback =
			!hasTabs && resolution?.status === "deleted" && persistedCanonical;
		const canonical =
			resolution?.status === "verified"
				? resolution.canonical
				: canUseDeletionFallback || undefined;
		if (!canonical) {
			invalidatePersistedIdentity(workspaceId);
			addWarning(
				warnings,
				resolution?.status === "ambiguous"
					? "A local workspace was not synchronized because its identity is ambiguous."
					: resolution?.status === "unresolved"
						? "A local workspace was not synchronized because its identity could not be read."
						: resolution?.status === "missing"
							? "A local workspace was not synchronized because it is missing."
							: resolution?.status === "deleted"
								? "A local workspace was not synchronized because a deleted identity remained active."
								: "A local workspace was not synchronized because its identity is unresolved.",
			);
			continue;
		}
		if (persistedCanonical && persistedCanonical !== canonical) {
			invalidatePersistedIdentity(workspaceId);
		}
		const claimedBy = claimedCanonicalIds.get(canonical);
		if (claimedBy && claimedBy !== workspaceId) {
			invalidatePersistedIdentity(workspaceId);
			addWarning(
				warnings,
				"A local workspace identity collision was rejected.",
			);
			continue;
		}
		claimedCanonicalIds.set(canonical, workspaceId);
		if (resolution?.status === "verified") {
			nextEnvelope.workspaceMetadata[canonical] = resolution.metadata;
			nextEnvelope.localToCanonical[workspaceId] = canonical;
		}
		const clock = { deviceId: input.deviceId, at: timestamp };
		nextEnvelope.perWorkspaceWrittenAt[canonical] = clock;
		if (hasTabs) {
			delete nextEnvelope.workspaceTombstones[canonical];
		} else {
			nextEnvelope.workspaceTombstones[canonical] = clock;
			delete nextEnvelope.localToCanonical[workspaceId];
		}
		changedCanonicalIds.push(canonical);
	}

	if (changedCanonicalIds.length > 0) {
		nextEnvelope.deviceId = input.deviceId;
		nextEnvelope.lastWrittenAt = timestamp;
	}
	const paneIds = new Set(Object.keys(input.nextTabs.panes));
	nextEnvelope.paneClaudeSessions = Object.fromEntries(
		Object.entries(input.paneClaudeSessions).filter(([paneId]) =>
			paneIds.has(paneId),
		),
	);
	return {
		envelope: nextEnvelope,
		changedCanonicalIds: changedCanonicalIds.sort(),
		warnings,
	};
}

function validPeerClockEntries(
	envelope: AppStateSyncEnvelope,
	warnings: string[],
): Map<string, { clock: WorkspaceClock; deletion: boolean }> {
	const result = new Map<
		string,
		{ clock: WorkspaceClock; deletion: boolean }
	>();
	for (const [canonical, value] of Object.entries(
		envelope.perWorkspaceWrittenAt,
	)) {
		if (!isWorkspaceClock(value)) {
			addWarning(
				warnings,
				"A peer workspace clock was invalid and was ignored.",
			);
			continue;
		}
		result.set(canonical, { clock: value, deletion: false });
	}
	for (const [canonical, value] of Object.entries(
		envelope.workspaceTombstones,
	)) {
		if (!isWorkspaceClock(value)) {
			addWarning(
				warnings,
				"A peer workspace clock was invalid and was ignored.",
			);
			continue;
		}
		const current = result.get(canonical);
		if (!current || compareWorkspaceClocks(value, current.clock) >= 0) {
			result.set(canonical, { clock: value, deletion: true });
		}
	}
	return result;
}

interface MergeCandidate {
	canonical: string;
	localWorkspaceId: string;
	peerWorkspaceId?: string;
	clock: WorkspaceClock;
	deletion: boolean;
}

export function planTabsMerge(input: {
	localTabs: TabsState;
	localEnvelope: AppStateSyncEnvelope;
	peerTabs: TabsState;
	peerEnvelope: AppStateSyncEnvelope;
	canonicalToLocal: Record<string, string>;
}): TabsMergePlan {
	const warnings: string[] = [];
	const rejected = new Set<string>();
	const localByCanonical = new Map<string, string>();
	const canonicalsByLocal = new Map<string, string[]>();
	for (const [canonical, localWorkspaceId] of Object.entries(
		input.canonicalToLocal,
	)) {
		localByCanonical.set(canonical, localWorkspaceId);
		const values = canonicalsByLocal.get(localWorkspaceId) ?? [];
		values.push(canonical);
		canonicalsByLocal.set(localWorkspaceId, values);
	}
	for (const canonicals of canonicalsByLocal.values()) {
		if (canonicals.length <= 1) continue;
		for (const canonical of canonicals) rejected.add(canonical);
		addWarning(warnings, "A peer workspace mapping collision was rejected.");
	}

	const peerWorkspaceIdsByCanonical = new Map<string, string[]>();
	for (const [peerWorkspaceId, canonical] of Object.entries(
		input.peerEnvelope.localToCanonical,
	)) {
		const values = peerWorkspaceIdsByCanonical.get(canonical) ?? [];
		values.push(peerWorkspaceId);
		peerWorkspaceIdsByCanonical.set(canonical, values);
	}
	const localClocks = seedWorkspaceClocks(input.localEnvelope).clocks;
	const peerEntries = validPeerClockEntries(input.peerEnvelope, warnings);
	const candidates: MergeCandidate[] = [];
	for (const [canonical, peer] of peerEntries) {
		if (rejected.has(canonical)) continue;
		const localWorkspaceId = localByCanonical.get(canonical);
		if (!localWorkspaceId) {
			addWarning(
				warnings,
				"A peer workspace could not be resolved on this device.",
			);
			continue;
		}
		const localClock = localClocks[canonical];
		if (localClock && compareWorkspaceClocks(peer.clock, localClock) <= 0) {
			continue;
		}
		const peerWorkspaceIds = peerWorkspaceIdsByCanonical.get(canonical) ?? [];
		if (!peer.deletion && peerWorkspaceIds.length !== 1) {
			rejected.add(canonical);
			addWarning(
				warnings,
				peerWorkspaceIds.length > 1
					? "A peer workspace mapping collision was rejected."
					: "A peer workspace could not be resolved on this device.",
			);
			continue;
		}
		const peerWorkspaceId = peerWorkspaceIds[0];
		const hasPeerTabs = Boolean(
			peerWorkspaceId &&
				input.peerTabs.tabs.some((tab) => tab.workspaceId === peerWorkspaceId),
		);
		candidates.push({
			canonical,
			localWorkspaceId,
			peerWorkspaceId,
			clock: peer.clock,
			deletion: peer.deletion || !hasPeerTabs,
		});
	}

	const candidateLocalIds = new Set(
		candidates.map((candidate) => candidate.localWorkspaceId),
	);
	const retainedTabs = input.localTabs.tabs.filter(
		(tab) => !candidateLocalIds.has(tab.workspaceId),
	);
	const retainedTabIds = new Set(retainedTabs.map((tab) => tab.id));
	const retainedPaneIds = new Set(
		Object.entries(input.localTabs.panes)
			.filter(([, pane]) => retainedTabIds.has(pane.tabId))
			.map(([paneId]) => paneId),
	);
	const accepted: MergeCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.deletion || !candidate.peerWorkspaceId) {
			accepted.push(candidate);
			continue;
		}
		const importedTabs = input.peerTabs.tabs.filter(
			(tab) => tab.workspaceId === candidate.peerWorkspaceId,
		);
		const importedTabIds = new Set(importedTabs.map((tab) => tab.id));
		const importedPaneIds = Object.entries(input.peerTabs.panes)
			.filter(([, pane]) => importedTabIds.has(pane.tabId))
			.map(([paneId]) => paneId);
		if (
			importedTabs.some((tab) => retainedTabIds.has(tab.id)) ||
			importedPaneIds.some((paneId) => retainedPaneIds.has(paneId))
		) {
			rejected.add(candidate.canonical);
			addWarning(
				warnings,
				"A peer tab or pane identity collision was rejected.",
			);
			continue;
		}
		accepted.push(candidate);
	}

	const acceptedLocalIds = new Set(
		accepted.map((candidate) => candidate.localWorkspaceId),
	);
	const mergedTabs = input.localTabs.tabs.filter(
		(tab) => !acceptedLocalIds.has(tab.workspaceId),
	);
	const mergedTabIds = new Set(mergedTabs.map((tab) => tab.id));
	const mergedPanes = Object.fromEntries(
		Object.entries(input.localTabs.panes).filter(([, pane]) =>
			mergedTabIds.has(pane.tabId),
		),
	);
	const mergedActiveTabIds = Object.fromEntries(
		Object.entries(input.localTabs.activeTabIds).filter(
			([workspaceId]) => !acceptedLocalIds.has(workspaceId),
		),
	);
	const mergedHistory = Object.fromEntries(
		Object.entries(input.localTabs.tabHistoryStacks).filter(
			([workspaceId]) => !acceptedLocalIds.has(workspaceId),
		),
	);
	const mergedFocused = Object.fromEntries(
		Object.entries(input.localTabs.focusedPaneIds).filter(([tabId]) =>
			mergedTabIds.has(tabId),
		),
	);
	const nextEnvelope = structuredClone(input.localEnvelope);
	const handoffs: PeerClaudeSessionHandoff[] = [];
	const importedPeerPaneIds = new Set<string>();

	for (const candidate of accepted) {
		nextEnvelope.perWorkspaceWrittenAt[candidate.canonical] = {
			...candidate.clock,
		};
		const peerMetadata =
			input.peerEnvelope.workspaceMetadata[candidate.canonical];
		if (peerMetadata) {
			nextEnvelope.workspaceMetadata[candidate.canonical] = peerMetadata;
		}
		if (candidate.deletion || !candidate.peerWorkspaceId) {
			nextEnvelope.workspaceTombstones[candidate.canonical] = {
				...candidate.clock,
			};
			delete nextEnvelope.localToCanonical[candidate.localWorkspaceId];
			mergedActiveTabIds[candidate.localWorkspaceId] = null;
			mergedHistory[candidate.localWorkspaceId] = [];
			continue;
		}

		delete nextEnvelope.workspaceTombstones[candidate.canonical];
		nextEnvelope.localToCanonical[candidate.localWorkspaceId] =
			candidate.canonical;
		const importedTabs = input.peerTabs.tabs
			.filter((tab) => tab.workspaceId === candidate.peerWorkspaceId)
			.map((tab) => ({
				...tab,
				workspaceId: candidate.localWorkspaceId,
			}));
		const importedTabIds = new Set(importedTabs.map((tab) => tab.id));
		for (const tab of importedTabs) {
			mergedTabs.push(tab);
			mergedTabIds.add(tab.id);
		}
		for (const [paneId, pane] of Object.entries(input.peerTabs.panes)) {
			if (!importedTabIds.has(pane.tabId)) continue;
			mergedPanes[paneId] = pane;
			importedPeerPaneIds.add(paneId);
			const claudeSessionId = input.peerEnvelope.paneClaudeSessions[paneId];
			if (claudeSessionId) {
				nextEnvelope.paneClaudeSessions[paneId] = claudeSessionId;
				handoffs.push({
					paneId,
					workspaceId: candidate.localWorkspaceId,
					claudeSessionId,
				});
			}
		}
		mergedActiveTabIds[candidate.localWorkspaceId] =
			input.peerTabs.activeTabIds[candidate.peerWorkspaceId] ?? null;
		mergedHistory[candidate.localWorkspaceId] =
			input.peerTabs.tabHistoryStacks[candidate.peerWorkspaceId] ?? [];
		for (const [tabId, paneId] of Object.entries(
			input.peerTabs.focusedPaneIds,
		)) {
			if (importedTabIds.has(tabId)) mergedFocused[tabId] = paneId;
		}
	}

	const finalPaneIds = new Set(Object.keys(mergedPanes));
	nextEnvelope.paneClaudeSessions = Object.fromEntries(
		Object.entries(nextEnvelope.paneClaudeSessions).filter(([paneId]) =>
			finalPaneIds.has(paneId),
		),
	);
	const tabsState: TabsState = {
		tabs: mergedTabs,
		panes: mergedPanes,
		activeTabIds: mergedActiveTabIds,
		focusedPaneIds: mergedFocused,
		tabHistoryStacks: mergedHistory,
	};
	return {
		tabsState,
		envelope: nextEnvelope,
		winningCanonicalIds: accepted
			.map((candidate) => candidate.canonical)
			.sort(),
		rejectedCanonicalIds: [...rejected].sort(),
		nextClocks: seedWorkspaceClocks(nextEnvelope).clocks,
		peerClaudeSessionHandoffs: handoffs,
		importedPeerPaneIds: [...importedPeerPaneIds].sort(),
		warnings,
	};
}
