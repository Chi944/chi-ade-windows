import { describe, expect, it } from "bun:test";
import type { HealthReport } from "main/lib/diagnostics/health";
import {
	buildHealthViewModel,
	getHealthStatusPresentation,
} from "./health-view-model";

const report: HealthReport = {
	generatedAt: "2026-07-16T00:00:00.000Z",
	summary: { pass: 2, warning: 1, fail: 1 },
	checks: [
		{
			id: "sync-root",
			group: "storage",
			label: "ADE data folder",
			status: "pass",
			message: "Writable.",
		},
		{
			id: "app-state",
			group: "state",
			label: "Application state",
			status: "fail",
			message: "Invalid.",
			remediation: "Restore a snapshot.",
		},
		{
			id: "command-claude",
			group: "tools",
			label: "Claude Code",
			status: "warning",
			message: "Unavailable.",
		},
		{
			id: "notifications",
			group: "notifications",
			label: "Notifications",
			status: "pass",
			message: "Supported.",
		},
	],
};

describe("health settings view model", () => {
	it("groups checks in a stable order and derives each group's worst status", () => {
		const view = buildHealthViewModel(report);

		expect(view.overallStatus).toBe("fail");
		expect(view.groups.map((group) => group.id)).toEqual([
			"storage",
			"state",
			"tools",
			"notifications",
		]);
		expect(view.groups.map((group) => group.status)).toEqual([
			"pass",
			"fail",
			"warning",
			"pass",
		]);
		expect(view.groups[1]?.checks[0]?.remediation).toBe("Restore a snapshot.");
	});

	it("provides an explicit empty state before the first run", () => {
		expect(buildHealthViewModel(undefined)).toEqual({
			overallStatus: "unknown",
			summary: { pass: 0, warning: 0, fail: 0 },
			groups: [],
			generatedAt: null,
		});
	});

	it("maps status labels and tones without embedding backend details", () => {
		expect(getHealthStatusPresentation("pass")).toEqual({
			label: "Pass",
			tone: "success",
		});
		expect(getHealthStatusPresentation("warning")).toEqual({
			label: "Warning",
			tone: "warning",
		});
		expect(getHealthStatusPresentation("fail")).toEqual({
			label: "Fail",
			tone: "danger",
		});
	});
});
