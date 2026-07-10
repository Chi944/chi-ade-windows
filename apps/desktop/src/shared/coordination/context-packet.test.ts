import { describe, expect, it } from "bun:test";
import {
	buildContextPacket,
	DEFAULT_CONTEXT_PACKET_TOKEN_BUDGET,
	estimateContextTokens,
	MAX_CONTEXT_PACKET_TOKEN_BUDGET,
} from "./context-packet";

describe("buildContextPacket", () => {
	it("normalizes and deduplicates a structured handoff deterministically", () => {
		const input = {
			objective: "  Finish the coordination layer.  ",
			summary: "Messages persist across\r\nrestarts.",
			decisions: ["Use SQLite", "Use SQLite", " Keep provider IDs separate "],
			files: ["src/broker.ts", "src/broker.ts"],
			commands: ["bun test  --watch", "bun test  --watch"],
			blockers: ["Signing credentials are unavailable"],
			nextSteps: ["Wire the inbox UI"],
			artifacts: ["coordination-report.json"],
		};

		const first = buildContextPacket(input);
		const second = buildContextPacket(input);

		expect(first).toEqual(second);
		expect(first).toEqual({
			content: [
				"## Objective",
				"Finish the coordination layer.",
				"",
				"## Next steps",
				"- Wire the inbox UI",
				"",
				"## Blockers",
				"- Signing credentials are unavailable",
				"",
				"## Decisions",
				"- Use SQLite",
				"- Keep provider IDs separate",
				"",
				"## Artifacts",
				"- coordination-report.json",
				"",
				"## Files",
				"- src/broker.ts",
				"",
				"## Commands",
				"- bun test  --watch",
				"",
				"## Summary",
				"Messages persist across\nrestarts.",
			].join("\n"),
			estimatedTokens: estimateContextTokens(first.content),
			truncated: false,
		});
	});

	it("keeps actionable handoffs ahead of oversized background summaries", () => {
		const result = buildContextPacket(
			{
				nextSteps: ["Continue from the verified checkpoint"],
				decisions: ["Keep handoffs lossless"],
				summary: "background ".repeat(10_000),
			},
			{ maxEstimatedTokens: 40 },
		);

		expect(result.truncated).toBe(true);
		expect(result.content).toContain("Continue from the verified checkpoint");
		expect(result.content).toContain("Keep handoffs lossless");
	});

	it("enforces the default budget and reports truncation", () => {
		const result = buildContextPacket({ summary: "context ".repeat(10_000) });

		expect(result.truncated).toBe(true);
		expect(result.content.endsWith("…")).toBe(true);
		expect(result.estimatedTokens).toBeLessThanOrEqual(
			DEFAULT_CONTEXT_PACKET_TOKEN_BUDGET,
		);
	});

	it("honors a smaller budget without splitting Unicode characters", () => {
		const result = buildContextPacket(
			{ objective: "coordinate 🤝 across agents ".repeat(20) },
			{ maxEstimatedTokens: 12 },
		);

		expect(result.truncated).toBe(true);
		expect(result.estimatedTokens).toBeLessThanOrEqual(12);
		expect(result.content).not.toContain("�");
	});

	it("caps caller-supplied budgets at the safe hard limit", () => {
		const result = buildContextPacket(
			{ summary: "x".repeat(100_000) },
			{ maxEstimatedTokens: Number.MAX_SAFE_INTEGER },
		);

		expect(result.truncated).toBe(true);
		expect(result.estimatedTokens).toBeLessThanOrEqual(
			MAX_CONTEXT_PACKET_TOKEN_BUDGET,
		);
	});

	it("returns an empty packet when no context is supplied", () => {
		expect(buildContextPacket({})).toEqual({
			content: "",
			estimatedTokens: 0,
			truncated: false,
		});
	});
});
