import { remoteWorkspaceBindings, workspaces } from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import {
	enqueueAppStateMutation,
	getAppStateSnapshot,
	getDeviceId,
	takeStartupPeerPaneIds,
} from "main/lib/app-state";
import {
	type AppState,
	hotkeysStateSchema,
	MAX_APP_STATE_RECORD_ENTRIES,
	MAX_APP_STATE_STRING_LENGTH,
	type TabsState,
	type ThemeState,
	tabsStateSchema,
	themeStateSchema,
} from "main/lib/app-state/schemas";
import { hotkeysEmitter } from "main/lib/hotkeys-events";
import { localDb } from "main/lib/local-db";
import { getLocalWorkspaceIdentityResolutions } from "main/lib/sync/workspace-identity";
import { HistoryReader } from "main/lib/terminal-history";
import {
	buildOverridesFromBindings,
	HOTKEYS_STATE_VERSION,
	type HotkeysState,
} from "shared/hotkeys";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import {
	overlayTabsWorkspaceChanges,
	stampLocalTabsMutation,
} from "shared/tabs-sync";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const tabsSetInputSchema = z.union([
	z.strictObject({
		state: tabsStateSchema,
		changedWorkspaceIds: z
			.array(z.string().min(1).max(MAX_APP_STATE_STRING_LENGTH))
			.max(MAX_APP_STATE_RECORD_ENTRIES)
			.transform((workspaceIds) => [...new Set(workspaceIds)].sort()),
	}),
	tabsStateSchema.transform((state) => ({
		state,
		changedWorkspaceIds: null,
	})),
]);

function stampSyncEnvelopeBare(draft: AppState): void {
	draft.sync.deviceId = getDeviceId();
	draft.sync.lastWrittenAt = Date.now();
}

async function stampSyncEnvelopeForTabs(
	draft: AppState,
	input: TabsState,
): Promise<void> {
	const deviceId = getDeviceId();
	const workspaceIds = new Set([
		...draft.tabsState.tabs.map((tab) => tab.workspaceId),
		...input.tabs.map((tab) => tab.workspaceId),
	]);
	for (const workspaceId of Object.keys(draft.tabsState.activeTabIds)) {
		workspaceIds.add(workspaceId);
	}
	for (const workspaceId of Object.keys(input.activeTabIds)) {
		workspaceIds.add(workspaceId);
	}
	for (const workspaceId of Object.keys(draft.tabsState.tabHistoryStacks)) {
		workspaceIds.add(workspaceId);
	}
	for (const workspaceId of Object.keys(input.tabHistoryStacks)) {
		workspaceIds.add(workspaceId);
	}
	const identities = getLocalWorkspaceIdentityResolutions(
		[...workspaceIds].sort(),
	);

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
	const stamp = stampLocalTabsMutation({
		previousTabs: draft.tabsState,
		nextTabs: input,
		envelope: draft.sync,
		identities,
		deviceId,
		now: Date.now(),
		paneClaudeSessions,
	});
	draft.sync = stamp.envelope;
	for (const warning of stamp.warnings) {
		console.warn(`[ui-state] ${warning}`);
	}
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

function getTabsSnapshot(): TabsState {
	const snapshot = getAppStateSnapshot();
	return sanitizeSubscriptionProfilesForPersistence({
		state: snapshot.tabsState,
		...getSubscriptionProfileWorkspaceClassification(),
	});
}

export const createUiStateRouter = () =>
	router({
		tabs: router({
			get: publicProcedure.query(getTabsSnapshot),

			bootstrap: publicProcedure.query(() => ({
				state: getTabsSnapshot(),
				startupPeerPaneIds: takeStartupPeerPaneIds(),
			})),

			set: publicProcedure
				.input(tabsSetInputSchema)
				.mutation(async ({ input }) => {
					const persistedState = sanitizeSubscriptionProfilesForPersistence({
						state: input.state,
						...getSubscriptionProfileWorkspaceClassification(),
					});
					await enqueueAppStateMutation("ui-state.tabs.set", async (draft) => {
						const nextState = input.changedWorkspaceIds
							? overlayTabsWorkspaceChanges({
									currentTabs: draft.tabsState,
									incomingTabs: persistedState,
									changedWorkspaceIds: input.changedWorkspaceIds,
								})
							: persistedState;
						await stampSyncEnvelopeForTabs(draft, nextState);
						draft.tabsState = nextState;
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
