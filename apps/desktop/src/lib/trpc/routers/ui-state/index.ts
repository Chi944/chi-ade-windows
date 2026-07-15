import { remoteWorkspaceBindings, workspaces } from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import {
	enqueueAppStateMutation,
	getAppStateSnapshot,
	getDeviceId,
} from "main/lib/app-state";
import {
	type AppState,
	hotkeysStateSchema,
	type TabsState,
	type ThemeState,
	tabsStateSchema,
	themeStateSchema,
} from "main/lib/app-state/schemas";
import { hotkeysEmitter } from "main/lib/hotkeys-events";
import { localDb } from "main/lib/local-db";
import { HistoryReader } from "main/lib/terminal-history";
import {
	buildOverridesFromBindings,
	HOTKEYS_STATE_VERSION,
	type HotkeysState,
} from "shared/hotkeys";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import { publicProcedure, router } from "../..";

function stampSyncEnvelopeBare(draft: AppState): void {
	draft.sync.deviceId = getDeviceId();
	draft.sync.lastWrittenAt = Date.now();
}

/**
 * Stamp a tabs mutation without creating new path-based workspace metadata.
 * Existing legacy mappings remain readable for migration until Task 3 replaces
 * them with portable repository identities.
 */
async function stampSyncEnvelopeForTabs(
	draft: AppState,
	input: TabsState,
): Promise<void> {
	const deviceId = getDeviceId();
	const now = Date.now();
	draft.sync.deviceId = deviceId;
	draft.sync.lastWrittenAt = now;

	const workspaceIds = new Set(input.tabs.map((tab) => tab.workspaceId));
	for (const workspaceId of Object.keys(input.activeTabIds)) {
		workspaceIds.add(workspaceId);
	}
	for (const workspaceId of Object.keys(input.tabHistoryStacks)) {
		workspaceIds.add(workspaceId);
	}

	const retainedLocalToCanonical: Record<string, string> = {};
	for (const workspaceId of workspaceIds) {
		const canonical = draft.sync.localToCanonical[workspaceId];
		if (!canonical) continue;
		retainedLocalToCanonical[workspaceId] = canonical;
		draft.sync.perWorkspaceWrittenAt[canonical] = {
			deviceId,
			at: now,
		};
	}
	draft.sync.localToCanonical = retainedLocalToCanonical;

	const workspaceIdByTabId = new Map(
		input.tabs.map((tab) => [tab.id, tab.workspaceId] as const),
	);
	const paneClaudeSessions: Record<string, string> = {};
	for (const [paneId, pane] of Object.entries(input.panes)) {
		if (pane.type !== "terminal") continue;
		const workspaceId = workspaceIdByTabId.get(pane.tabId);
		if (!workspaceId) continue;
		const metadata = await new HistoryReader(
			workspaceId,
			paneId,
		).readMetadata();
		if (metadata?.claudeSessionId) {
			paneClaudeSessions[paneId] = metadata.claudeSessionId;
		}
	}
	draft.sync.paneClaudeSessions = paneClaudeSessions;
}

function getSubscriptionProfileWorkspaceClassification(): {
	remoteWorkspaceIds: ReadonlySet<string>;
	localWorkspaceIds: ReadonlySet<string>;
} {
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
	return { remoteWorkspaceIds, localWorkspaceIds };
}

export const createUiStateRouter = () =>
	router({
		tabs: router({
			get: publicProcedure.query((): TabsState => {
				const snapshot = getAppStateSnapshot();
				return sanitizeSubscriptionProfilesForPersistence({
					state: snapshot.tabsState,
					...getSubscriptionProfileWorkspaceClassification(),
				});
			}),

			set: publicProcedure
				.input(tabsStateSchema)
				.mutation(async ({ input }) => {
					const persistedState = sanitizeSubscriptionProfilesForPersistence({
						state: input,
						...getSubscriptionProfileWorkspaceClassification(),
					});
					await enqueueAppStateMutation("ui-state.tabs.set", async (draft) => {
						draft.tabsState = persistedState;
						await stampSyncEnvelopeForTabs(draft, persistedState);
					});
					return { success: true };
				}),
		}),

		theme: router({
			get: publicProcedure.query(
				(): ThemeState => getAppStateSnapshot().themeState,
			),

			set: publicProcedure
				.input(themeStateSchema)
				.mutation(async ({ input }) => {
					await enqueueAppStateMutation("ui-state.theme.set", (draft) => {
						draft.themeState = input;
						stampSyncEnvelopeBare(draft);
					});
					return { success: true };
				}),
		}),

		hotkeys: router({
			get: publicProcedure.query(
				(): HotkeysState => getAppStateSnapshot().hotkeysState,
			),

			set: publicProcedure
				.input(hotkeysStateSchema)
				.mutation(async ({ input }) => {
					const version =
						input.version === HOTKEYS_STATE_VERSION
							? input.version
							: HOTKEYS_STATE_VERSION;
					const normalized: HotkeysState = {
						version,
						byPlatform: {
							darwin: buildOverridesFromBindings(
								input.byPlatform.darwin,
								"darwin",
							),
							win32: buildOverridesFromBindings(
								input.byPlatform.win32,
								"win32",
							),
							linux: buildOverridesFromBindings(
								input.byPlatform.linux,
								"linux",
							),
						},
					};

					await enqueueAppStateMutation("ui-state.hotkeys.set", (draft) => {
						draft.hotkeysState = normalized;
						stampSyncEnvelopeBare(draft);
					});
					hotkeysEmitter.emit("change", {
						version: normalized.version,
						updatedAt: new Date().toISOString(),
					});
					return { success: true };
				}),

			subscribe: publicProcedure.subscription(() =>
				observable<{ version: number; updatedAt: string }>((emit) => {
					const onChange = (data: { version: number; updatedAt: string }) =>
						emit.next(data);
					hotkeysEmitter.on("change", onChange);
					return () => hotkeysEmitter.off("change", onChange);
				}),
			),
		}),
	});
