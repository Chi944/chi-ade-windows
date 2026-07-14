import { describe, expect, it } from "bun:test";
import { normalizeExecutionMode } from "@superset/local-db/schema/zod";
import {
	chunkPresetCommands,
	distributePresetCommands,
	getPresetLaunchPlan,
} from "./preset-launch";

describe("normalizeExecutionMode", () => {
	it("returns new-tab for new-tab mode", () => {
		expect(normalizeExecutionMode("new-tab")).toBe("new-tab");
	});

	it("returns new-tab-split-pane for new-tab-split-pane mode", () => {
		expect(normalizeExecutionMode("new-tab-split-pane")).toBe(
			"new-tab-split-pane",
		);
	});

	it("maps legacy and unknown modes to split-pane", () => {
		expect(normalizeExecutionMode("split-pane")).toBe("split-pane");
		expect(normalizeExecutionMode("parallel")).toBe("split-pane");
		expect(normalizeExecutionMode("sequential")).toBe("split-pane");
		expect(normalizeExecutionMode(undefined)).toBe("split-pane");
	});
});

describe("getPresetLaunchPlan", () => {
	it("uses active tab split mode for active-tab target + split-pane + multiple commands", () => {
		expect(
			getPresetLaunchPlan({
				mode: "split-pane",
				target: "active-tab",
				commandCount: 2,
				hasActiveTab: true,
			}),
		).toBe("active-tab-multi-pane");
	});

	it("falls back to new-tab path when active tab is unavailable", () => {
		expect(
			getPresetLaunchPlan({
				mode: "split-pane",
				target: "active-tab",
				commandCount: 2,
				hasActiveTab: false,
			}),
		).toBe("new-tab-multi-pane");
	});

	it("uses new-tab path when mode is new-tab even if target is active-tab", () => {
		expect(
			getPresetLaunchPlan({
				mode: "new-tab",
				target: "active-tab",
				commandCount: 3,
				hasActiveTab: true,
			}),
		).toBe("new-tab-per-command");
	});

	it("uses new-tab multi-pane path when mode is new-tab-split-pane", () => {
		expect(
			getPresetLaunchPlan({
				mode: "new-tab-split-pane",
				target: "active-tab",
				commandCount: 3,
				hasActiveTab: true,
			}),
		).toBe("new-tab-multi-pane");
	});

	it("defaults new-tab target with split-pane mode to tab multi-pane for multiple commands", () => {
		expect(
			getPresetLaunchPlan({
				mode: "split-pane",
				target: "new-tab",
				commandCount: 2,
				hasActiveTab: true,
			}),
		).toBe("new-tab-multi-pane");
	});
});

describe("chunkPresetCommands", () => {
	it("keeps every command in order across six-pane tab groups", () => {
		const commands = Array.from(
			{ length: 14 },
			(_, index) => `command-${index}`,
		);
		const groups = chunkPresetCommands(commands);

		expect(groups.map((group) => group.length)).toEqual([6, 6, 2]);
		expect(groups.flat()).toEqual(commands);
	});

	it("does not mutate the caller's command array", () => {
		const commands = ["one", "two", "three"];
		const groups = chunkPresetCommands(commands, 2);

		expect(groups).toEqual([["one", "two"], ["three"]]);
		expect(commands).toEqual(["one", "two", "three"]);
	});

	it("rejects an invalid group size", () => {
		expect(() => chunkPresetCommands(["one"], 0)).toThrow(
			"maxPerTab must be a positive integer",
		);
	});
});

describe("distributePresetCommands", () => {
	it("fills active-tab capacity and groups every overflow command", () => {
		const commands = Array.from(
			{ length: 14 },
			(_, index) => `command-${index}`,
		);
		const distribution = distributePresetCommands({
			commands,
			activeTabCapacity: 2,
		});

		expect(distribution.activeTabCommands).toEqual(commands.slice(0, 2));
		expect(distribution.overflowTabGroups.map((group) => group.length)).toEqual(
			[6, 6],
		);
		expect([
			...distribution.activeTabCommands,
			...distribution.overflowTabGroups.flat(),
		]).toEqual(commands);
	});

	it("sends all commands to overflow when the active tab is full", () => {
		const commands = ["one", "two"];
		const distribution = distributePresetCommands({
			commands,
			activeTabCapacity: 0,
		});

		expect(distribution.activeTabCommands).toEqual([]);
		expect(distribution.overflowTabGroups).toEqual([commands]);
	});
});
