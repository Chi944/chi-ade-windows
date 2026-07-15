/**
 * Shared runtime contracts for UI state persisted from renderer Zustand stores.
 * These schemas are the single source used by startup, watcher, and tRPC
 * mutation boundaries.
 */
import { AGENT_RUNTIMES } from "@superset/local-db";
import { createDefaultHotkeysState, type HotkeysState } from "shared/hotkeys";
import type { BaseTab, BaseTabsState, Pane } from "shared/tabs-types";
import type { Theme } from "shared/themes";
import { z } from "zod";

export const MAX_APP_STATE_RECORD_ENTRIES = 5_000;
export const MAX_APP_STATE_TABS = 1_000;
export const MAX_APP_STATE_PANES = 5_000;
export const MAX_APP_STATE_HISTORY_ENTRIES = 1_000;
export const MAX_APP_STATE_CUSTOM_THEMES = 100;
export const MAX_APP_STATE_STRING_LENGTH = 32_768;

const shortStringSchema = z.string().max(4_096);
const requiredStringSchema = z.string().min(1).max(MAX_APP_STATE_STRING_LENGTH);
const optionalStringSchema = z.string().max(MAX_APP_STATE_STRING_LENGTH);
const finiteTimestampSchema = z.number().finite().nonnegative();

function boundedRecord<T extends z.ZodType>(valueSchema: T) {
	return z
		.record(requiredStringSchema, valueSchema)
		.superRefine((record, context) => {
			if (Object.keys(record).length > MAX_APP_STATE_RECORD_ENTRIES) {
				context.addIssue({
					code: "custom",
					message: `Record exceeds ${MAX_APP_STATE_RECORD_ENTRIES} entries`,
				});
			}
		});
}

const fileViewerStateSchema = z
	.strictObject({
		filePath: requiredStringSchema,
		absolutePath: optionalStringSchema.optional(),
		viewMode: z.enum(["rendered", "raw", "diff"]),
		isPinned: z.boolean(),
		diffLayout: z.enum(["inline", "side-by-side"]),
		diffCategory: z
			.enum(["against-base", "committed", "staged", "unstaged"])
			.optional(),
		commitHash: optionalStringSchema.optional(),
		oldPath: optionalStringSchema.optional(),
		// Renderer-only navigation hints are accepted at the RPC/load boundary
		// and deliberately removed before persistence.
		initialLine: z.number().finite().int().nonnegative().optional(),
		initialColumn: z.number().finite().int().nonnegative().optional(),
	})
	.transform(
		({ initialLine: _line, initialColumn: _column, ...persisted }) => persisted,
	);

const browserHistoryEntrySchema = z.strictObject({
	url: optionalStringSchema,
	title: shortStringSchema,
	timestamp: finiteTimestampSchema,
	faviconUrl: optionalStringSchema.optional(),
});

const browserLoadErrorSchema = z.strictObject({
	code: z.number().finite().int(),
	description: shortStringSchema,
	url: optionalStringSchema,
});

const browserPaneStateSchema = z.strictObject({
	currentUrl: optionalStringSchema,
	history: z
		.array(browserHistoryEntrySchema)
		.max(MAX_APP_STATE_HISTORY_ENTRIES),
	historyIndex: z.number().finite().int().min(-1),
	isLoading: z.boolean(),
	error: browserLoadErrorSchema.nullable().optional(),
	viewport: z
		.strictObject({
			name: shortStringSchema,
			width: z.number().finite().positive().max(100_000),
			height: z.number().finite().positive().max(100_000),
		})
		.nullable()
		.optional(),
});

export const paneSchema = z.strictObject({
	id: requiredStringSchema,
	tabId: requiredStringSchema,
	type: z.enum(["terminal", "webview", "file-viewer", "devtools"]),
	name: shortStringSchema,
	userTitle: shortStringSchema.optional(),
	isNew: z.boolean().optional(),
	status: z.enum(["idle", "working", "permission", "review"]).optional(),
	initialCwd: optionalStringSchema.optional(),
	url: optionalStringSchema.optional(),
	cwd: optionalStringSchema.nullable().optional(),
	cwdConfirmed: z.boolean().optional(),
	fileViewer: fileViewerStateSchema.optional(),
	browser: browserPaneStateSchema.optional(),
	devtools: z.strictObject({ targetPaneId: requiredStringSchema }).optional(),
	terminalProfileId: optionalStringSchema.optional(),
	agentRuntime: z.enum(AGENT_RUNTIMES).optional(),
	// Valid legacy device-local choices are accepted so Task 1 sanitization can
	// remove them. Arbitrary profile identifiers are rejected.
	subscriptionProfileId: z.uuid().nullable().optional(),
	subscriptionProfilePinned: z.boolean().optional(),
	subscriptionProfileNeedsRebind: z.boolean().optional(),
	allowKilledRestore: z.boolean().optional(),
});

export type PersistedMosaicNode =
	| string
	| {
			direction: "row" | "column";
			first: PersistedMosaicNode;
			second: PersistedMosaicNode;
			splitPercentage?: number;
	  };

export const mosaicNodeSchema: z.ZodType<PersistedMosaicNode> = z.lazy(() =>
	z.union([
		requiredStringSchema,
		z.strictObject({
			direction: z.enum(["row", "column"]),
			first: mosaicNodeSchema,
			second: mosaicNodeSchema,
			splitPercentage: z.number().finite().min(0).max(100).optional(),
		}),
	]),
);

export interface PersistedTab extends BaseTab {
	layout: PersistedMosaicNode;
}

export interface TabsState extends Omit<BaseTabsState, "tabs"> {
	tabs: PersistedTab[];
}

export const tabSchema = z.strictObject({
	id: requiredStringSchema,
	name: shortStringSchema,
	userTitle: shortStringSchema.optional(),
	workspaceId: requiredStringSchema,
	createdAt: finiteTimestampSchema,
	layout: mosaicNodeSchema,
});

const tabsStateFields = {
	tabs: z.array(tabSchema).max(MAX_APP_STATE_TABS),
	panes: boundedRecord(paneSchema).superRefine((panes, context) => {
		if (Object.keys(panes).length > MAX_APP_STATE_PANES) {
			context.addIssue({
				code: "custom",
				message: `Pane record exceeds ${MAX_APP_STATE_PANES} entries`,
			});
		}
	}),
	activeTabIds: boundedRecord(requiredStringSchema.nullable()),
	focusedPaneIds: boundedRecord(requiredStringSchema),
	tabHistoryStacks: boundedRecord(
		z.array(requiredStringSchema).max(MAX_APP_STATE_HISTORY_ENTRIES),
	),
};

export const tabsStateSchema = z
	.strictObject({
		...tabsStateFields,
		// The closed-tab undo stack is intentionally process-local. Recognize it
		// so current renderer payloads are accepted, then remove it.
		closedTabsStack: z.array(z.unknown()).max(20).optional(),
	})
	.transform(
		({ closedTabsStack: _closedTabsStack, ...persisted }) => persisted,
	);

export const legacyTabsStateSchema = z
	.strictObject({
		tabs: tabsStateFields.tabs.optional(),
		panes: tabsStateFields.panes.optional(),
		activeTabIds: tabsStateFields.activeTabIds.optional(),
		focusedPaneIds: tabsStateFields.focusedPaneIds.optional(),
		tabHistoryStacks: tabsStateFields.tabHistoryStacks.optional(),
		closedTabsStack: z.array(z.unknown()).max(20).optional(),
	})
	.transform(
		({
			tabs,
			panes,
			activeTabIds,
			focusedPaneIds,
			tabHistoryStacks,
			closedTabsStack: _closedTabsStack,
		}) => ({
			tabs: tabs ?? [],
			panes: panes ?? {},
			activeTabIds: activeTabIds ?? {},
			focusedPaneIds: focusedPaneIds ?? {},
			tabHistoryStacks: tabHistoryStacks ?? {},
		}),
	);

const uiColorsSchema = z.strictObject({
	background: shortStringSchema,
	foreground: shortStringSchema,
	card: shortStringSchema,
	cardForeground: shortStringSchema,
	popover: shortStringSchema,
	popoverForeground: shortStringSchema,
	primary: shortStringSchema,
	primaryForeground: shortStringSchema,
	secondary: shortStringSchema,
	secondaryForeground: shortStringSchema,
	muted: shortStringSchema,
	mutedForeground: shortStringSchema,
	accent: shortStringSchema,
	accentForeground: shortStringSchema,
	tertiary: shortStringSchema,
	tertiaryActive: shortStringSchema,
	destructive: shortStringSchema,
	destructiveForeground: shortStringSchema,
	border: shortStringSchema,
	input: shortStringSchema,
	ring: shortStringSchema,
	sidebar: shortStringSchema,
	sidebarForeground: shortStringSchema,
	sidebarPrimary: shortStringSchema,
	sidebarPrimaryForeground: shortStringSchema,
	sidebarAccent: shortStringSchema,
	sidebarAccentForeground: shortStringSchema,
	sidebarBorder: shortStringSchema,
	sidebarRing: shortStringSchema,
	chart1: shortStringSchema,
	chart2: shortStringSchema,
	chart3: shortStringSchema,
	chart4: shortStringSchema,
	chart5: shortStringSchema,
	highlightMatch: shortStringSchema,
	highlightActive: shortStringSchema,
});

const terminalColorsSchema = z.strictObject({
	background: shortStringSchema,
	foreground: shortStringSchema,
	cursor: shortStringSchema,
	cursorAccent: shortStringSchema.optional(),
	selectionBackground: shortStringSchema.optional(),
	selectionForeground: shortStringSchema.optional(),
	black: shortStringSchema,
	red: shortStringSchema,
	green: shortStringSchema,
	yellow: shortStringSchema,
	blue: shortStringSchema,
	magenta: shortStringSchema,
	cyan: shortStringSchema,
	white: shortStringSchema,
	brightBlack: shortStringSchema,
	brightRed: shortStringSchema,
	brightGreen: shortStringSchema,
	brightYellow: shortStringSchema,
	brightBlue: shortStringSchema,
	brightMagenta: shortStringSchema,
	brightCyan: shortStringSchema,
	brightWhite: shortStringSchema,
});

export const themeSchema = z.strictObject({
	id: requiredStringSchema,
	name: shortStringSchema,
	author: shortStringSchema.optional(),
	version: shortStringSchema.optional(),
	description: shortStringSchema.optional(),
	type: z.enum(["dark", "light"]),
	ui: uiColorsSchema,
	terminal: terminalColorsSchema.optional(),
	isBuiltIn: z.boolean().optional(),
	isCustom: z.boolean().optional(),
});

export const themeStateSchema = z.strictObject({
	activeThemeId: requiredStringSchema,
	customThemes: z.array(themeSchema).max(MAX_APP_STATE_CUSTOM_THEMES),
});

export const legacyThemeStateSchema = z
	.strictObject({
		activeThemeId: requiredStringSchema.optional(),
		customThemes: z
			.array(themeSchema)
			.max(MAX_APP_STATE_CUSTOM_THEMES)
			.optional(),
	})
	.transform(({ activeThemeId, customThemes }) => ({
		activeThemeId: activeThemeId ?? "dark",
		customThemes: customThemes ?? [],
	}));

const hotkeyBindingsSchema = boundedRecord(optionalStringSchema.nullable());

export const hotkeysStateSchema = z.strictObject({
	version: z.number().finite().int().nonnegative(),
	byPlatform: z.strictObject({
		darwin: hotkeyBindingsSchema,
		win32: hotkeyBindingsSchema,
		linux: hotkeyBindingsSchema,
	}),
});

export const legacyHotkeysStateSchema = z
	.strictObject({
		version: z.number().finite().int().nonnegative().optional(),
		byPlatform: z
			.strictObject({
				darwin: hotkeyBindingsSchema.optional(),
				win32: hotkeyBindingsSchema.optional(),
				linux: hotkeyBindingsSchema.optional(),
			})
			.optional(),
	})
	.transform(({ version, byPlatform }) => ({
		version: version ?? createDefaultHotkeysState().version,
		byPlatform: {
			darwin: byPlatform?.darwin ?? {},
			win32: byPlatform?.win32 ?? {},
			linux: byPlatform?.linux ?? {},
		},
	}));

const workspaceClockSchema = z.strictObject({
	deviceId: requiredStringSchema,
	at: finiteTimestampSchema,
});

const workspaceMetadataSchema = z.strictObject({
	// Task 3 migrates this legacy path-based identity to a normalized origin.
	// Task 2 validates but continues to accept the existing path contract.
	mainRepoPath: requiredStringSchema,
	branch: requiredStringSchema,
	type: z.enum(["worktree", "branch"]),
});

export const syncEnvelopeSchema = z.strictObject({
	deviceId: requiredStringSchema,
	lastWrittenAt: finiteTimestampSchema,
	perWorkspaceWrittenAt: boundedRecord(workspaceClockSchema),
	workspaceMetadata: boundedRecord(workspaceMetadataSchema),
	localToCanonical: boundedRecord(requiredStringSchema),
	paneClaudeSessions: boundedRecord(requiredStringSchema),
});

export const legacySyncEnvelopeSchema = z.strictObject({
	deviceId: requiredStringSchema.optional(),
	lastWrittenAt: finiteTimestampSchema.optional(),
	perWorkspaceWrittenAt: boundedRecord(workspaceClockSchema).optional(),
	workspaceMetadata: boundedRecord(workspaceMetadataSchema).optional(),
	localToCanonical: boundedRecord(requiredStringSchema).optional(),
	paneClaudeSessions: boundedRecord(requiredStringSchema).optional(),
});

export interface ThemeState {
	activeThemeId: string;
	customThemes: Theme[];
}

export interface AppStateSyncEnvelope {
	deviceId: string;
	lastWrittenAt: number;
	perWorkspaceWrittenAt: Record<string, { deviceId: string; at: number }>;
	workspaceMetadata: Record<
		string,
		{ mainRepoPath: string; branch: string; type: "worktree" | "branch" }
	>;
	localToCanonical: Record<string, string>;
	paneClaudeSessions: Record<string, string>;
}

export interface AppState {
	tabsState: TabsState;
	themeState: ThemeState;
	hotkeysState: HotkeysState;
	sync: AppStateSyncEnvelope;
}

export function createDefaultAppState(deviceId = ""): AppState {
	return {
		tabsState: {
			tabs: [],
			panes: {},
			activeTabIds: {},
			focusedPaneIds: {},
			tabHistoryStacks: {},
		},
		themeState: {
			activeThemeId: "dark",
			customThemes: [],
		},
		hotkeysState: createDefaultHotkeysState(),
		sync: {
			deviceId,
			lastWrittenAt: 0,
			perWorkspaceWrittenAt: {},
			workspaceMetadata: {},
			localToCanonical: {},
			paneClaudeSessions: {},
		},
	};
}

export const defaultAppState: AppState = createDefaultAppState();

export type { Pane };
