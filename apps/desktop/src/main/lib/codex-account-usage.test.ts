import { describe, expect, it } from "bun:test";
import {
	getCodexUsageReadError,
	parseCodexRateLimitWindows,
} from "./codex-account-usage";

describe("Codex account usage", () => {
	it("keeps both primary and secondary rate-limit windows", () => {
		const windows = parseCodexRateLimitWindows({
			rateLimitsByLimitId: {
				codex: {
					limitName: "Codex subscription",
					primary: {
						usedPercent: 42,
						windowDurationMins: 300,
						resetsAt: 1_800_000_000,
					},
					secondary: {
						usedPercent: 87,
						windowDurationMins: 10_080,
						resetsAt: 1_800_500_000,
					},
				},
			},
		});

		expect(windows).toHaveLength(2);
		expect(windows.map((window) => window.id)).toEqual([
			"codex:primary",
			"codex:secondary",
		]);
		expect(windows[1]?.usedPercent).toBe(87);
		expect(windows[1]?.windowDurationMins).toBe(10_080);
	});

	it("clamps malformed percentages and ignores missing windows", () => {
		expect(
			parseCodexRateLimitWindows({
				rateLimits: { limitId: "fallback", primary: { usedPercent: 140 } },
			}),
		).toEqual([expect.objectContaining({ id: "fallback", usedPercent: 100 })]);
		expect(parseCodexRateLimitWindows({ rateLimits: {} })).toEqual([]);
	});

	it("surfaces partial usage and rate-limit RPC failures", () => {
		expect(
			getCodexUsageReadError({
				account: false,
				rateLimits: true,
				usage: false,
			}),
		).toBe("Codex rate-limit status is unavailable");
		expect(
			getCodexUsageReadError({
				account: false,
				rateLimits: false,
				usage: true,
			}),
		).toBe("Codex usage summary is unavailable");
	});
});
