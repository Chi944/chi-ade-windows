import {
	type AgentRuntime,
	normalizeExecutionMode,
	type TerminalPreset,
} from "@superset/local-db/schema/zod";
import { useCallback, useMemo } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { useCreateOrAttachWithTheme } from "renderer/hooks/useCreateOrAttachWithTheme";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	buildTerminalCommand,
	launchCommandInPane,
} from "renderer/lib/terminal/launch-command";
import {
	chunkPresetCommands,
	distributePresetCommands,
	getPresetLaunchPlan,
	type PresetMode,
	type PresetOpenTarget,
} from "./preset-launch";
import { useTabsStore } from "./store";
import type { AddTabOptions } from "./types";
import {
	getRemainingPaneCapacity,
	resolveActiveTabIdForWorkspace,
} from "./utils";

interface OpenPresetOptions {
	target?: PresetOpenTarget;
	modeOverride?: PresetMode;
	runtime?: AgentRuntime;
	subscriptionProfileId?: string | null;
}

interface PreparedPreset {
	mode: PresetMode;
	commands: string[];
	initialCwd?: string;
	name?: string;
	runtime?: AgentRuntime;
	subscriptionProfileId?: string | null;
}

interface PresetPaneLaunch {
	paneId: string;
	tabId: string;
	workspaceId: string;
	command: string;
	runtime?: AgentRuntime;
	subscriptionProfileId?: string | null;
}

function preparePreset(preset: TerminalPreset): PreparedPreset {
	return {
		mode: normalizeExecutionMode(preset.executionMode),
		commands: preset.commands,
		initialCwd: preset.cwd || undefined,
		name: preset.name || undefined,
	};
}

export function useTabsWithPresets() {
	const { data: newTabPresets = [] } =
		electronTrpc.settings.getNewTabPresets.useQuery();

	const storeAddTab = useTabsStore((s) => s.addTab);
	const storeAddTabWithMultiplePanes = useTabsStore(
		(s) => s.addTabWithMultiplePanes,
	);
	const storeAddPane = useTabsStore((s) => s.addPane);
	const storeAddPanesToTab = useTabsStore((s) => s.addPanesToTab);
	const storeSplitPaneVertical = useTabsStore((s) => s.splitPaneVertical);
	const storeSplitPaneHorizontal = useTabsStore((s) => s.splitPaneHorizontal);
	const storeSplitPaneAuto = useTabsStore((s) => s.splitPaneAuto);
	const renameTab = useTabsStore((s) => s.renameTab);
	const createOrAttach = useCreateOrAttachWithTheme();
	const writeToTerminal = electronTrpc.terminal.write.useMutation();

	const firstPreset = newTabPresets[0] ?? null;
	const firstPresetCommand = useMemo(
		() => (firstPreset ? buildTerminalCommand(firstPreset.commands) : null),
		[firstPreset],
	);

	const firstPresetOptions: AddTabOptions | undefined = useMemo(() => {
		if (!firstPreset) return undefined;
		return {
			initialCwd: firstPreset.cwd || undefined,
		};
	}, [firstPreset]);

	const applyTabName = useCallback(
		(tabId: string, name?: string) => {
			if (name) {
				renameTab(tabId, name);
			}
		},
		[renameTab],
	);

	const resolveActiveWorkspaceTabId = useCallback((workspaceId: string) => {
		const state = useTabsStore.getState();
		return resolveActiveTabIdForWorkspace({
			workspaceId,
			tabs: state.tabs,
			activeTabIds: state.activeTabIds,
			tabHistoryStacks: state.tabHistoryStacks,
		});
	}, []);

	const launchPresetCommand = useCallback(
		({
			paneId,
			tabId,
			workspaceId,
			command,
			runtime,
			subscriptionProfileId,
		}: PresetPaneLaunch) => {
			void launchCommandInPane({
				paneId,
				tabId,
				workspaceId,
				command,
				runtime,
				subscriptionProfileId,
				createOrAttach: (input) => createOrAttach.mutateAsync(input),
				write: (input) => writeToTerminal.mutateAsync(input),
			}).catch((error) => {
				console.error("[useTabsWithPresets] Failed to launch preset command:", {
					paneId,
					tabId,
					workspaceId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		},
		[createOrAttach, writeToTerminal],
	);

	const launchPresetCommands = useCallback(
		(launches: PresetPaneLaunch[]) => {
			for (const launch of launches) {
				launchPresetCommand(launch);
			}
		},
		[launchPresetCommand],
	);

	const resolveWorkspaceIdForTab = useCallback((tabId: string) => {
		const tab = useTabsStore
			.getState()
			.tabs.find((tabItem) => tabItem.id === tabId);
		return tab?.workspaceId ?? null;
	}, []);

	const launchFirstPresetInPane = useCallback(
		(tabId: string, paneId: string) => {
			if (firstPresetCommand === null) return;
			const workspaceId = resolveWorkspaceIdForTab(tabId);
			if (!workspaceId) return;
			launchPresetCommand({
				paneId,
				tabId,
				workspaceId,
				command: firstPresetCommand,
			});
		},
		[firstPresetCommand, launchPresetCommand, resolveWorkspaceIdForTab],
	);

	const launchFirstPresetInFocusedPane = useCallback(
		(tabId: string, previousFocusedPaneId: string | undefined) => {
			if (firstPresetCommand === null) return;
			const state = useTabsStore.getState();
			const paneId = state.focusedPaneIds[tabId];
			if (!paneId || paneId === previousFocusedPaneId) return;
			const tab = state.tabs.find((tabItem) => tabItem.id === tabId);
			if (!tab) return;
			launchPresetCommand({
				paneId,
				tabId,
				workspaceId: tab.workspaceId,
				command: firstPresetCommand,
			});
		},
		[firstPresetCommand, launchPresetCommand],
	);

	const executePresetInNewTab = useCallback(
		(workspaceId: string, preset: PreparedPreset) => {
			const hasMultipleCommands = preset.commands.length > 1;

			if (preset.mode === "new-tab" && hasMultipleCommands) {
				let firstResult: { tabId: string; paneId: string } | null = null;
				const launches: PresetPaneLaunch[] = [];

				for (const command of preset.commands) {
					const result = storeAddTab(workspaceId, {
						initialCwd: preset.initialCwd,
						agentRuntime: preset.runtime,
						subscriptionProfileId: preset.subscriptionProfileId,
					});
					if (!firstResult) {
						firstResult = result;
					}
					launches.push({
						paneId: result.paneId,
						tabId: result.tabId,
						workspaceId,
						command,
						runtime: preset.runtime,
						subscriptionProfileId: preset.subscriptionProfileId,
					});
					applyTabName(result.tabId, preset.name);
				}

				if (firstResult) {
					launchPresetCommands(launches);
					return firstResult;
				}

				const fallback = storeAddTab(workspaceId, {
					initialCwd: preset.initialCwd,
					agentRuntime: preset.runtime,
					subscriptionProfileId: preset.subscriptionProfileId,
				});
				applyTabName(fallback.tabId, preset.name);
				return fallback;
			}

			if (hasMultipleCommands) {
				let firstResult: { tabId: string; paneId: string } | null = null;
				const launches: PresetPaneLaunch[] = [];

				for (const commandGroup of chunkPresetCommands(preset.commands)) {
					const multiPane = storeAddTabWithMultiplePanes(workspaceId, {
						commands: commandGroup,
						initialCwd: preset.initialCwd,
						agentRuntime: preset.runtime,
						subscriptionProfileId: preset.subscriptionProfileId,
					});
					const createdCount = Math.min(
						multiPane.paneIds.length,
						commandGroup.length,
					);

					if (createdCount > 0) {
						firstResult ??= {
							tabId: multiPane.tabId,
							paneId: multiPane.paneIds[0],
						};
						applyTabName(multiPane.tabId, preset.name);
					}

					for (let index = 0; index < createdCount; index++) {
						launches.push({
							paneId: multiPane.paneIds[index],
							tabId: multiPane.tabId,
							workspaceId,
							command: commandGroup[index],
							runtime: preset.runtime,
							subscriptionProfileId: preset.subscriptionProfileId,
						});
					}

					// Store limits should accept every pre-chunked command. If a store
					// implementation ever returns fewer panes, preserve the remainder in
					// individual tabs instead of silently losing commands.
					for (const command of commandGroup.slice(createdCount)) {
						const fallback = storeAddTab(workspaceId, {
							initialCwd: preset.initialCwd,
							agentRuntime: preset.runtime,
							subscriptionProfileId: preset.subscriptionProfileId,
						});
						firstResult ??= fallback;
						applyTabName(fallback.tabId, preset.name);
						launches.push({
							paneId: fallback.paneId,
							tabId: fallback.tabId,
							workspaceId,
							command,
							runtime: preset.runtime,
							subscriptionProfileId: preset.subscriptionProfileId,
						});
					}
				}

				launchPresetCommands(launches);
				if (firstResult) return firstResult;
			}

			const command = buildTerminalCommand(preset.commands);
			const result = storeAddTab(workspaceId, {
				initialCwd: preset.initialCwd,
				agentRuntime: preset.runtime,
				subscriptionProfileId: preset.subscriptionProfileId,
			});
			if (command !== null) {
				launchPresetCommand({
					paneId: result.paneId,
					tabId: result.tabId,
					workspaceId,
					command,
					runtime: preset.runtime,
					subscriptionProfileId: preset.subscriptionProfileId,
				});
			}
			applyTabName(result.tabId, preset.name);
			return result;
		},
		[
			storeAddTab,
			storeAddTabWithMultiplePanes,
			applyTabName,
			launchPresetCommand,
			launchPresetCommands,
		],
	);

	const executePreset = useCallback(
		(workspaceId: string, preset: PreparedPreset, target: PresetOpenTarget) => {
			const activeTabId =
				target === "active-tab" && preset.mode === "split-pane"
					? resolveActiveWorkspaceTabId(workspaceId)
					: null;

			const plan = getPresetLaunchPlan({
				mode: preset.mode,
				target,
				commandCount: preset.commands.length,
				hasActiveTab: !!activeTabId,
			});

			if (plan === "active-tab-multi-pane" && activeTabId) {
				const activeTab = useTabsStore
					.getState()
					.tabs.find((tab) => tab.id === activeTabId);
				const capacity = activeTab
					? getRemainingPaneCapacity(activeTab.layout)
					: 0;
				const distribution = distributePresetCommands({
					commands: preset.commands,
					activeTabCapacity: capacity,
				});
				const activeCommands = distribution.activeTabCommands;
				let overflowCommands = distribution.overflowTabGroups.flat();
				let activeResult: { tabId: string; paneId: string } | null = null;

				const paneIds =
					activeCommands.length > 0
						? storeAddPanesToTab(activeTabId, {
								commands: activeCommands,
								initialCwd: preset.initialCwd,
								agentRuntime: preset.runtime,
								subscriptionProfileId: preset.subscriptionProfileId,
							})
						: [];
				const createdCount = Math.min(paneIds.length, activeCommands.length);
				if (createdCount > 0) {
					const launches: PresetPaneLaunch[] = paneIds
						.slice(0, createdCount)
						.flatMap((paneId, index) => {
							const command = activeCommands[index];
							if (command === undefined) return [];
							return [
								{
									paneId,
									tabId: activeTabId,
									workspaceId,
									command,
									runtime: preset.runtime,
									subscriptionProfileId: preset.subscriptionProfileId,
								},
							];
						});
					launchPresetCommands(launches);
					activeResult = { tabId: activeTabId, paneId: paneIds[0] };
				}
				overflowCommands = [
					...activeCommands.slice(createdCount),
					...overflowCommands,
				];

				if (overflowCommands.length > 0) {
					const overflowResult = executePresetInNewTab(workspaceId, {
						...preset,
						commands: overflowCommands,
					});
					return activeResult ?? overflowResult;
				}

				if (activeResult) return activeResult;
				return executePresetInNewTab(workspaceId, preset);
			}

			if (plan === "active-tab-single" && activeTabId) {
				const activeTab = useTabsStore
					.getState()
					.tabs.find((tab) => tab.id === activeTabId);
				if (!activeTab || getRemainingPaneCapacity(activeTab.layout) === 0) {
					return executePresetInNewTab(workspaceId, preset);
				}

				const command = buildTerminalCommand(preset.commands);
				const paneId = storeAddPane(activeTabId, {
					initialCwd: preset.initialCwd,
					agentRuntime: preset.runtime,
					subscriptionProfileId: preset.subscriptionProfileId,
				});
				if (paneId) {
					if (command !== null) {
						launchPresetCommand({
							paneId,
							tabId: activeTabId,
							workspaceId,
							command,
							runtime: preset.runtime,
							subscriptionProfileId: preset.subscriptionProfileId,
						});
					}
					return { tabId: activeTabId, paneId };
				}
				return executePresetInNewTab(workspaceId, preset);
			}

			return executePresetInNewTab(workspaceId, preset);
		},
		[
			resolveActiveWorkspaceTabId,
			storeAddPanesToTab,
			storeAddPane,
			executePresetInNewTab,
			launchPresetCommands,
			launchPresetCommand,
		],
	);

	const openPreset = useCallback(
		(
			workspaceId: string,
			preset: TerminalPreset,
			options?: OpenPresetOptions,
		) => {
			const prepared = preparePreset(preset);
			const target = options?.target ?? "new-tab";
			const mode = options?.modeOverride ?? prepared.mode;
			return executePreset(
				workspaceId,
				{
					...prepared,
					mode,
					runtime: options?.runtime,
					subscriptionProfileId: options?.subscriptionProfileId,
				},
				target,
			);
		},
		[executePreset],
	);

	const addTab = useCallback(
		(workspaceId: string, options?: AddTabOptions) => {
			if (options) {
				return storeAddTab(workspaceId, options);
			}

			if (newTabPresets.length === 0) {
				return storeAddTab(workspaceId);
			}

			const firstResult = openPreset(workspaceId, newTabPresets[0], {
				target: "new-tab",
			});
			for (let i = 1; i < newTabPresets.length; i++) {
				openPreset(workspaceId, newTabPresets[i], { target: "new-tab" });
			}

			return { tabId: firstResult.tabId, paneId: firstResult.paneId };
		},
		[storeAddTab, newTabPresets, openPreset],
	);

	const addPane = useCallback(
		(tabId: string, options?: AddTabOptions) => {
			if (options) {
				return storeAddPane(tabId, options);
			}
			const paneId = storeAddPane(tabId, firstPresetOptions);
			if (paneId) {
				launchFirstPresetInPane(tabId, paneId);
			}
			return paneId;
		},
		[storeAddPane, firstPresetOptions, launchFirstPresetInPane],
	);

	const splitPaneVertical = useCallback(
		(
			tabId: string,
			sourcePaneId: string,
			path?: MosaicBranch[],
			options?: AddTabOptions,
		) => {
			if (options) {
				return storeSplitPaneVertical(tabId, sourcePaneId, path, options);
			}
			const previousFocusedPaneId =
				useTabsStore.getState().focusedPaneIds[tabId];
			storeSplitPaneVertical(tabId, sourcePaneId, path, firstPresetOptions);
			launchFirstPresetInFocusedPane(tabId, previousFocusedPaneId);
		},
		[
			storeSplitPaneVertical,
			firstPresetOptions,
			launchFirstPresetInFocusedPane,
		],
	);

	const splitPaneHorizontal = useCallback(
		(
			tabId: string,
			sourcePaneId: string,
			path?: MosaicBranch[],
			options?: AddTabOptions,
		) => {
			if (options) {
				return storeSplitPaneHorizontal(tabId, sourcePaneId, path, options);
			}
			const previousFocusedPaneId =
				useTabsStore.getState().focusedPaneIds[tabId];
			storeSplitPaneHorizontal(tabId, sourcePaneId, path, firstPresetOptions);
			launchFirstPresetInFocusedPane(tabId, previousFocusedPaneId);
		},
		[
			storeSplitPaneHorizontal,
			firstPresetOptions,
			launchFirstPresetInFocusedPane,
		],
	);

	const splitPaneAuto = useCallback(
		(
			tabId: string,
			sourcePaneId: string,
			dimensions: { width: number; height: number },
			path?: MosaicBranch[],
			options?: AddTabOptions,
		) => {
			if (options) {
				return storeSplitPaneAuto(
					tabId,
					sourcePaneId,
					dimensions,
					path,
					options,
				);
			}
			const previousFocusedPaneId =
				useTabsStore.getState().focusedPaneIds[tabId];
			storeSplitPaneAuto(
				tabId,
				sourcePaneId,
				dimensions,
				path,
				firstPresetOptions,
			);
			launchFirstPresetInFocusedPane(tabId, previousFocusedPaneId);
		},
		[storeSplitPaneAuto, firstPresetOptions, launchFirstPresetInFocusedPane],
	);

	return {
		addTab,
		addPane,
		splitPaneVertical,
		splitPaneHorizontal,
		splitPaneAuto,
		openPreset,
	};
}
