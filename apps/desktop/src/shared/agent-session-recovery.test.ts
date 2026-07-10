import { describe, expect, it } from "bun:test";
import {
	buildAgentResumeCommand,
	extractAgentSessionId,
	isValidAgentSessionId,
} from "./agent-session-recovery";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("agent session recovery", () => {
	it("extracts Claude and Codex conversation ids", () => {
		expect(
			extractAgentSessionId("claude", `claude --resume ${SESSION_ID}`),
		).toBe(SESSION_ID);
		expect(extractAgentSessionId("codex", `thread-id: ${SESSION_ID}`)).toBe(
			SESSION_ID,
		);
	});

	it("builds runtime-specific continuation commands", () => {
		expect(
			buildAgentResumeCommand({ runtime: "claude", sessionId: SESSION_ID }),
		).toBe(`claude --resume ${SESSION_ID} --dangerously-skip-permissions`);
		expect(
			buildAgentResumeCommand({ runtime: "codex", sessionId: SESSION_ID }),
		).toBe(`codex resume ${SESSION_ID}`);
		expect(
			buildAgentResumeCommand({
				runtime: "huggingface",
				sessionId: SESSION_ID,
			}),
		).toBe(
			`codex -c 'model_provider="huggingface"' -c 'model_providers.huggingface.name="Hugging Face"' -c 'model_providers.huggingface.base_url="https://router.huggingface.co/v1"' -c 'model_providers.huggingface.env_key="HF_TOKEN"' -c 'model_providers.huggingface.wire_api="responses"' --ask-for-approval on-request --sandbox workspace-write resume ${SESSION_ID}`,
		);
		expect(
			buildAgentResumeCommand({
				runtime: "ollama",
				sessionId: SESSION_ID,
			}),
		).toBe(
			`codex --oss --local-provider ollama --ask-for-approval on-request --sandbox workspace-write resume ${SESSION_ID}`,
		);
		expect(
			buildAgentResumeCommand({
				runtime: "opencode",
				sessionId: "ses_safe_123",
			}),
		).toBe("opencode --session ses_safe_123");
	});

	it("does not guess a conversation or accept command-like session ids", () => {
		expect(buildAgentResumeCommand({ runtime: "claude" })).toBeNull();
		expect(buildAgentResumeCommand({ runtime: "codex" })).toBeNull();
		expect(buildAgentResumeCommand({ runtime: "opencode" })).toBeNull();
		expect(buildAgentResumeCommand({ runtime: "gemini" })).toBeNull();
		expect(
			buildAgentResumeCommand({
				runtime: "codex",
				sessionId: `${SESSION_ID} && calc.exe`,
			}),
		).toBeNull();
		expect(isValidAgentSessionId("opencode", "ses_safe-123")).toBe(true);
		expect(isValidAgentSessionId("opencode", "ses_bad;calc.exe")).toBe(false);
	});
});
