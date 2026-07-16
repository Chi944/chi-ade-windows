import { randomUUID } from "node:crypto";
import { remoteWorkspaceBindings, workspaces } from "@superset/local-db";
import {
	enqueueAppStateMutationAtRevision,
	getAppStateRevision,
	getAppStateSnapshot,
} from "main/lib/app-state";
import { getCanonicalForLocalWorkspaceId } from "main/lib/sync/workspace-identity";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import {
	hashTabsState,
	type PeerClaudeSessionHandoff,
	planTabsMerge,
	type TabsMergePlan,
} from "shared/tabs-sync";
import { localDb } from "../local-db";
import { writeClaudeSessionIdToHistory } from "../terminal-history";
import type { AppState } from "./schemas";
import {
	type CachedPeerAppStateEvent,
	peerAppStateEventCache,
} from "./watcher";
import type {
	AppStateConditionalMutationCommit,
	AppStateMutator,
} from "./write-queue";

const DEFAULT_RESULT_CACHE_CAPACITY = 64;
const DEFAULT_RESULT_CACHE_TTL_MS = 5 * 60_000;
export const SUPPRESSION_TOKEN_TTL_MS = 30_000;

export interface RebasePeerUpdateInput {
	eventId: string;
	baseRevision: number;
	canonicalToLocal: Record<string, string>;
}

export interface TabsSuppressionToken {
	token: string;
	revision: number;
	tabsHash: string;
	expiresAt: number;
}

export type RebasePeerUpdateResult =
	| {
			status: "committed";
			revision: number;
			tabsState: TabsMergePlan["tabsState"];
			sync: TabsMergePlan["envelope"];
			warnings: string[];
			winningWorkspaces: string[];
			importedPeerPaneIds: string[];
			suppressionToken: TabsSuppressionToken;
	  }
	| { status: "stale"; revision: number }
	| {
			status: "rejected";
			reason:
				| "peer-event-unavailable"
				| "invalid-workspace-mapping"
				| "duplicate-event-conflict"
				| "commit-failed";
	  };

export interface PeerSyncServiceDependencies {
	getEvent: (eventId: string) => CachedPeerAppStateEvent | null;
	enqueueAtRevision: <T>(
		label: string,
		revision: number,
		mutate: AppStateMutator<T>,
	) => Promise<AppStateConditionalMutationCommit<T>>;
	getRevision: () => number;
	getSnapshot: () => AppState;
	verifyMapping: (
		canonical: string,
		localWorkspaceId: string,
	) => boolean | Promise<boolean>;
	persistHandoff: (handoff: PeerClaudeSessionHandoff) => Promise<void>;
	sanitizeTabsState?: (
		state: TabsMergePlan["tabsState"],
	) => TabsMergePlan["tabsState"];
	tokenFactory?: () => string;
	now?: () => number;
	resultCacheCapacity?: number;
	resultCacheTtlMs?: number;
}

interface ProcessedResult {
	fingerprint: string;
	result: Extract<RebasePeerUpdateResult, { status: "committed" }>;
	expiresAt: number;
}

class InvalidWorkspaceMappingError extends Error {}

function sanitizeMergedTabsState(
	state: TabsMergePlan["tabsState"],
): TabsMergePlan["tabsState"] {
	const remoteWorkspaceIds = new Set(
		localDb
			.select({ workspaceId: remoteWorkspaceBindings.workspaceId })
			.from(remoteWorkspaceBindings)
			.all()
			.map(({ workspaceId }) => workspaceId),
	);
	const localWorkspaceIds = new Set(
		localDb
			.select({ workspaceId: workspaces.id })
			.from(workspaces)
			.all()
			.map(({ workspaceId }) => workspaceId)
			.filter((workspaceId) => !remoteWorkspaceIds.has(workspaceId)),
	);
	return sanitizeSubscriptionProfilesForPersistence({
		state,
		localWorkspaceIds,
		remoteWorkspaceIds,
	});
}

function mappingFingerprint(input: RebasePeerUpdateInput): string {
	return JSON.stringify({
		canonicalToLocal: Object.fromEntries(
			Object.entries(input.canonicalToLocal).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	});
}

function peerCanonicalIds(event: CachedPeerAppStateEvent): Set<string> {
	return new Set(event.canonicalWorkspaceIds);
}

export function createPeerSyncService(
	dependencies: PeerSyncServiceDependencies,
): {
	rebasePeerUpdate: (
		input: RebasePeerUpdateInput,
	) => Promise<RebasePeerUpdateResult>;
} {
	const now = dependencies.now ?? Date.now;
	const capacity = Math.max(
		1,
		dependencies.resultCacheCapacity ?? DEFAULT_RESULT_CACHE_CAPACITY,
	);
	const ttlMs = Math.max(
		1,
		dependencies.resultCacheTtlMs ?? DEFAULT_RESULT_CACHE_TTL_MS,
	);
	const processed = new Map<string, ProcessedResult>();
	const inFlight = new Map<
		string,
		{
			fingerprint: string;
			promise: Promise<RebasePeerUpdateResult>;
		}
	>();
	const createSuppressionToken = (
		revision: number,
		tabsState: TabsMergePlan["tabsState"],
	): TabsSuppressionToken => ({
		token: dependencies.tokenFactory?.() ?? randomUUID(),
		revision,
		tabsHash: hashTabsState(tabsState),
		expiresAt: now() + SUPPRESSION_TOKEN_TTL_MS,
	});

	const purgeProcessed = () => {
		const currentTime = now();
		for (const [eventId, entry] of processed) {
			if (entry.expiresAt <= currentTime) processed.delete(eventId);
		}
	};

	const remember = (
		eventId: string,
		fingerprint: string,
		result: Extract<RebasePeerUpdateResult, { status: "committed" }>,
	) => {
		purgeProcessed();
		processed.set(eventId, {
			fingerprint,
			result: structuredClone(result),
			expiresAt: now() + ttlMs,
		});
		while (processed.size > capacity) {
			const oldest = processed.keys().next().value;
			if (typeof oldest !== "string") break;
			processed.delete(oldest);
		}
	};

	const validateMappings = async (
		event: CachedPeerAppStateEvent,
		mapping: Record<string, string>,
	): Promise<boolean> => {
		const allowedCanonicalIds = peerCanonicalIds(event);
		const localIds = new Set<string>();
		for (const [canonical, localWorkspaceId] of Object.entries(mapping)) {
			if (
				!allowedCanonicalIds.has(canonical) ||
				localIds.has(localWorkspaceId) ||
				!(await dependencies.verifyMapping(canonical, localWorkspaceId))
			) {
				return false;
			}
			localIds.add(localWorkspaceId);
		}
		return true;
	};

	const execute = async (
		input: RebasePeerUpdateInput,
	): Promise<RebasePeerUpdateResult> => {
		purgeProcessed();
		const fingerprint = mappingFingerprint(input);
		const prior = processed.get(input.eventId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return { status: "rejected", reason: "duplicate-event-conflict" };
			}
			const currentRevision = dependencies.getRevision();
			const replay =
				currentRevision === prior.result.revision
					? structuredClone(prior.result)
					: (() => {
							const snapshot = dependencies.getSnapshot();
							return {
								...structuredClone(prior.result),
								revision: currentRevision,
								tabsState: snapshot.tabsState,
								sync: snapshot.sync,
								winningWorkspaces: [],
								importedPeerPaneIds: prior.result.importedPeerPaneIds.filter(
									(paneId) => Object.hasOwn(snapshot.tabsState.panes, paneId),
								),
							};
						})();
			replay.suppressionToken = createSuppressionToken(
				replay.revision,
				replay.tabsState,
			);
			return replay;
		}

		const event = dependencies.getEvent(input.eventId);
		if (!event) {
			return { status: "rejected", reason: "peer-event-unavailable" };
		}
		if (!(await validateMappings(event, input.canonicalToLocal))) {
			return { status: "rejected", reason: "invalid-workspace-mapping" };
		}

		try {
			const commit = await dependencies.enqueueAtRevision(
				"sync.rebase-peer-update",
				input.baseRevision,
				async (draft) => {
					if (!(await validateMappings(event, input.canonicalToLocal))) {
						throw new InvalidWorkspaceMappingError();
					}
					const plan = planTabsMerge({
						localTabs: draft.tabsState,
						localEnvelope: draft.sync,
						peerTabs: event.state.tabsState,
						peerEnvelope: event.state.sync,
						canonicalToLocal: input.canonicalToLocal,
					});
					for (const handoff of plan.peerClaudeSessionHandoffs) {
						await dependencies.persistHandoff(handoff);
					}
					plan.tabsState =
						dependencies.sanitizeTabsState?.(plan.tabsState) ?? plan.tabsState;
					draft.tabsState = plan.tabsState;
					draft.sync = plan.envelope;
					return plan;
				},
			);

			if (commit.status === "stale") {
				return { status: "stale", revision: commit.revision };
			}
			const result: Extract<RebasePeerUpdateResult, { status: "committed" }> = {
				status: "committed",
				revision: commit.revision,
				tabsState: commit.state.tabsState,
				sync: commit.state.sync,
				warnings: commit.result.warnings,
				winningWorkspaces: commit.result.winningCanonicalIds,
				importedPeerPaneIds: commit.result.importedPeerPaneIds.filter(
					(paneId) => Object.hasOwn(commit.state.tabsState.panes, paneId),
				),
				suppressionToken: createSuppressionToken(
					commit.revision,
					commit.state.tabsState,
				),
			};
			remember(input.eventId, fingerprint, result);
			return result;
		} catch (error) {
			return error instanceof InvalidWorkspaceMappingError
				? { status: "rejected", reason: "invalid-workspace-mapping" }
				: { status: "rejected", reason: "commit-failed" };
		}
	};

	let tail: Promise<void> = Promise.resolve();
	return {
		rebasePeerUpdate(input) {
			const fingerprint = mappingFingerprint(input);
			const pending = inFlight.get(input.eventId);
			if (pending) {
				return pending.fingerprint === fingerprint
					? pending.promise
					: Promise.resolve({
							status: "rejected" as const,
							reason: "duplicate-event-conflict" as const,
						});
			}
			const operation = tail.then(() => execute(input));
			const entry = { fingerprint, promise: operation };
			inFlight.set(input.eventId, entry);
			const clear = () => {
				if (inFlight.get(input.eventId) === entry) {
					inFlight.delete(input.eventId);
				}
			};
			void operation.then(clear, clear);
			tail = operation.then(() => undefined).catch(() => undefined);
			return operation;
		},
	};
}

export const peerSyncService = createPeerSyncService({
	getEvent: (eventId) => peerAppStateEventCache.get(eventId),
	enqueueAtRevision: enqueueAppStateMutationAtRevision,
	getRevision: getAppStateRevision,
	getSnapshot: getAppStateSnapshot,
	verifyMapping: (canonical, localWorkspaceId) =>
		getCanonicalForLocalWorkspaceId(localWorkspaceId)?.canonical === canonical,
	persistHandoff: async (handoff) => {
		await writeClaudeSessionIdToHistory(
			handoff.workspaceId,
			handoff.paneId,
			handoff.claudeSessionId,
		);
	},
	sanitizeTabsState: sanitizeMergedTabsState,
});
