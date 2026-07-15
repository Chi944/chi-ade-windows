import { z } from "zod";
import {
	type AppState,
	createDefaultAppState,
	legacyHotkeysStateSchema,
	legacySyncEnvelopeSchema,
	legacyTabsStateSchema,
	legacyThemeStateSchema,
	type PersistedMosaicNode,
} from "./schemas";

export { MAX_APP_STATE_RECORD_ENTRIES } from "./schemas";

export const MAX_APP_STATE_JSON_BYTES = 8 * 1024 * 1024;

export interface NormalizeAppStateOptions {
	deviceId: string;
}

export type AppStateValidationErrorCode =
	| "invalid-json"
	| "invalid-shape"
	| "too-large";

export class AppStateValidationError extends Error {
	readonly code: AppStateValidationErrorCode;

	constructor(code: AppStateValidationErrorCode, message: string) {
		super(message);
		this.name = "AppStateValidationError";
		this.code = code;
	}
}

const legacyAppStateSchema = z.strictObject({
	tabsState: legacyTabsStateSchema.optional(),
	themeState: legacyThemeStateSchema.optional(),
	hotkeysState: legacyHotkeysStateSchema.optional(),
	sync: legacySyncEnvelopeSchema.optional(),
});

function assertPayloadSize(value: unknown): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new AppStateValidationError(
			"invalid-shape",
			"App state must be JSON serializable",
		);
	}
	if (
		serialized !== undefined &&
		Buffer.byteLength(serialized, "utf8") > MAX_APP_STATE_JSON_BYTES
	) {
		throw new AppStateValidationError(
			"too-large",
			`App state exceeds ${MAX_APP_STATE_JSON_BYTES} bytes`,
		);
	}
}

function validationMessage(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "state";
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

function assertDurableTabsCore(input: unknown): void {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return;
	}
	const tabsState = (input as Record<string, unknown>).tabsState;
	if (
		typeof tabsState !== "object" ||
		tabsState === null ||
		Array.isArray(tabsState) ||
		!Object.hasOwn(tabsState, "tabs") ||
		!Object.hasOwn(tabsState, "panes")
	) {
		throw new AppStateValidationError(
			"invalid-shape",
			"Persisted app state is missing the durable tabs and panes core",
		);
	}
}

function collectLayoutPaneIds(
	layout: PersistedMosaicNode,
	ids: string[],
): void {
	if (typeof layout === "string") {
		ids.push(layout);
		return;
	}
	collectLayoutPaneIds(layout.first, ids);
	collectLayoutPaneIds(layout.second, ids);
}

function assertTabsInvariants(state: AppState): void {
	const tabsById = new Map<string, AppState["tabsState"]["tabs"][number]>();
	const workspaceTabs = new Map<string, Set<string>>();

	for (const tab of state.tabsState.tabs) {
		if (tabsById.has(tab.id)) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Duplicate tab id: ${tab.id}`,
			);
		}
		tabsById.set(tab.id, tab);
		const ids = workspaceTabs.get(tab.workspaceId) ?? new Set<string>();
		ids.add(tab.id);
		workspaceTabs.set(tab.workspaceId, ids);
	}

	for (const [paneKey, pane] of Object.entries(state.tabsState.panes)) {
		if (pane.id !== paneKey) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Pane record key ${paneKey} does not match pane id ${pane.id}`,
			);
		}
		if (!tabsById.has(pane.tabId)) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Pane ${pane.id} refers to missing tab ${pane.tabId}`,
			);
		}
		if (pane.browser) {
			const { history, historyIndex } = pane.browser;
			const validHistoryIndex =
				history.length === 0
					? historyIndex === -1
					: historyIndex >= 0 && historyIndex < history.length;
			if (!validHistoryIndex) {
				throw new AppStateValidationError(
					"invalid-shape",
					`Browser pane ${pane.id} has an invalid history index`,
				);
			}
		}
		if (pane.devtools) {
			const target = state.tabsState.panes[pane.devtools.targetPaneId];
			if (!target || target.type !== "webview" || target.tabId !== pane.tabId) {
				throw new AppStateValidationError(
					"invalid-shape",
					`DevTools pane ${pane.id} refers to an invalid browser pane`,
				);
			}
		}
	}

	for (const tab of state.tabsState.tabs) {
		const layoutPaneIds: string[] = [];
		collectLayoutPaneIds(tab.layout, layoutPaneIds);
		const uniqueLayoutPaneIds = new Set(layoutPaneIds);
		if (uniqueLayoutPaneIds.size !== layoutPaneIds.length) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Tab ${tab.id} layout contains a duplicate pane`,
			);
		}
		for (const paneId of layoutPaneIds) {
			const pane = state.tabsState.panes[paneId];
			if (!pane || pane.tabId !== tab.id) {
				throw new AppStateValidationError(
					"invalid-shape",
					`Tab ${tab.id} layout refers to an invalid pane ${paneId}`,
				);
			}
		}
		for (const pane of Object.values(state.tabsState.panes)) {
			if (pane.tabId === tab.id && !uniqueLayoutPaneIds.has(pane.id)) {
				throw new AppStateValidationError(
					"invalid-shape",
					`Pane ${pane.id} is missing from tab ${tab.id} layout`,
				);
			}
		}
	}

	for (const [tabId, paneId] of Object.entries(
		state.tabsState.focusedPaneIds,
	)) {
		const pane = state.tabsState.panes[paneId];
		if (!tabsById.has(tabId) || !pane || pane.tabId !== tabId) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Focused pane ${paneId} does not belong to tab ${tabId}`,
			);
		}
	}

	for (const [workspaceId, tabId] of Object.entries(
		state.tabsState.activeTabIds,
	)) {
		if (tabId !== null && !workspaceTabs.get(workspaceId)?.has(tabId)) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Active tab ${tabId} does not belong to workspace ${workspaceId}`,
			);
		}
	}

	for (const [workspaceId, history] of Object.entries(
		state.tabsState.tabHistoryStacks,
	)) {
		if (new Set(history).size !== history.length) {
			throw new AppStateValidationError(
				"invalid-shape",
				`Tab history for workspace ${workspaceId} contains duplicates`,
			);
		}
		for (const tabId of history) {
			if (!workspaceTabs.get(workspaceId)?.has(tabId)) {
				throw new AppStateValidationError(
					"invalid-shape",
					`History tab ${tabId} does not belong to workspace ${workspaceId}`,
				);
			}
		}
	}
}

export function normalizeAppState(
	input: unknown,
	options: NormalizeAppStateOptions,
): AppState {
	assertPayloadSize(input);
	const parsed = legacyAppStateSchema.safeParse(input);
	if (!parsed.success) {
		throw new AppStateValidationError(
			"invalid-shape",
			`Invalid app-state shape: ${validationMessage(parsed.error)}`,
		);
	}

	const defaults = createDefaultAppState(options.deviceId);
	const legacySync = parsed.data.sync;
	const normalized: AppState = {
		tabsState: parsed.data.tabsState ?? defaults.tabsState,
		themeState: parsed.data.themeState ?? defaults.themeState,
		hotkeysState: parsed.data.hotkeysState ?? defaults.hotkeysState,
		sync: {
			deviceId: legacySync?.deviceId ?? options.deviceId,
			lastWrittenAt: legacySync?.lastWrittenAt ?? 0,
			perWorkspaceWrittenAt: legacySync?.perWorkspaceWrittenAt ?? {},
			workspaceMetadata: legacySync?.workspaceMetadata ?? {},
			localToCanonical: legacySync?.localToCanonical ?? {},
			paneClaudeSessions: legacySync?.paneClaudeSessions ?? {},
		},
	};

	assertTabsInvariants(normalized);
	return normalized;
}

export function parseAppStateJson(
	raw: string,
	options: NormalizeAppStateOptions,
): AppState {
	if (Buffer.byteLength(raw, "utf8") > MAX_APP_STATE_JSON_BYTES) {
		throw new AppStateValidationError(
			"too-large",
			`App-state JSON exceeds ${MAX_APP_STATE_JSON_BYTES} bytes`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new AppStateValidationError(
			"invalid-json",
			"App-state JSON could not be parsed",
		);
	}
	assertDurableTabsCore(parsed);
	return normalizeAppState(parsed, options);
}
