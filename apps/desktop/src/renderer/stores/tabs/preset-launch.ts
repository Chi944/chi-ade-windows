import type { ExecutionMode } from "@superset/local-db/schema/zod";
import { MAX_PANES_PER_TAB } from "./utils";

export type PresetOpenTarget = "new-tab" | "active-tab";
export type PresetMode = ExecutionMode;

export type PresetLaunchPlan =
	| "new-tab-single"
	| "new-tab-multi-pane"
	| "new-tab-per-command"
	| "active-tab-single"
	| "active-tab-multi-pane";

/**
 * Split commands into complete, ordered groups that each fit in one tab.
 * Keeping this pure makes overflow behavior easy to verify independently from
 * the renderer store and prevents callers from silently dropping commands.
 */
export function chunkPresetCommands(
	commands: string[],
	maxPerTab = MAX_PANES_PER_TAB,
): string[][] {
	if (!Number.isInteger(maxPerTab) || maxPerTab <= 0) {
		throw new Error("maxPerTab must be a positive integer");
	}

	const groups: string[][] = [];
	for (let index = 0; index < commands.length; index += maxPerTab) {
		groups.push(commands.slice(index, index + maxPerTab));
	}
	return groups;
}

export function distributePresetCommands({
	commands,
	activeTabCapacity,
}: {
	commands: string[];
	activeTabCapacity: number;
}): { activeTabCommands: string[]; overflowTabGroups: string[][] } {
	if (!Number.isInteger(activeTabCapacity) || activeTabCapacity < 0) {
		throw new Error("activeTabCapacity must be a non-negative integer");
	}

	const activeCount = Math.min(activeTabCapacity, MAX_PANES_PER_TAB);
	const activeTabCommands = commands.slice(0, activeCount);
	return {
		activeTabCommands,
		overflowTabGroups: chunkPresetCommands(commands.slice(activeCount)),
	};
}

export function getPresetLaunchPlan({
	mode,
	target,
	commandCount,
	hasActiveTab,
}: {
	mode: PresetMode;
	target: PresetOpenTarget;
	commandCount: number;
	hasActiveTab: boolean;
}): PresetLaunchPlan {
	const hasMultipleCommands = commandCount > 1;
	const shouldUseActiveTab =
		target === "active-tab" && mode === "split-pane" && hasActiveTab;

	if (shouldUseActiveTab) {
		return hasMultipleCommands ? "active-tab-multi-pane" : "active-tab-single";
	}

	if (mode === "new-tab" && hasMultipleCommands) {
		return "new-tab-per-command";
	}

	return hasMultipleCommands ? "new-tab-multi-pane" : "new-tab-single";
}
