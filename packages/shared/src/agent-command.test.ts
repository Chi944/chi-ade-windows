import { describe, expect, it } from "bun:test";
import {
	buildAgentPromptCommand,
	getAgentPresetCommands,
} from "./agent-command";

describe("buildAgentPromptCommand", () => {
	it("adds `--` before codex prompt payload", () => {
		const command = buildAgentPromptCommand({
			prompt: "- Only modified file: runtime.ts",
			randomId: "1234-5678",
			agent: "codex",
		});

		expect(command).toContain(
			"--sandbox danger-full-access -- \"$(cat <<'SUPERSET_PROMPT_12345678'",
		);
		expect(command).toContain("- Only modified file: runtime.ts");
	});

	it("does not change non-codex commands", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "claude",
		});

		expect(command).toStartWith(
			"claude --dangerously-skip-permissions \"$(cat <<'SUPERSET_PROMPT_abcdefgh'",
		);
	});

	it("encodes Windows prompts without shell interpolation", () => {
		const prompt = 'line one\n$env:PATH; "quoted"; \u{1f600}';
		const command = buildAgentPromptCommand({
			prompt,
			randomId: "unused",
			agent: "codex",
			windows: true,
		});

		expect(command).toStartWith(
			"powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ",
		);
		const encodedScript = command.split(" ").at(-1) ?? "";
		const script = Buffer.from(encodedScript, "base64").toString("utf16le");
		const encodedPrompt = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
		expect(encodedPrompt).toBeTruthy();
		expect(Buffer.from(encodedPrompt ?? "", "base64").toString("utf8")).toBe(
			prompt,
		);
		expect(script).toContain("--sandbox danger-full-access -- $prompt");
		expect(script).not.toContain(prompt);
	});

	it("uses cmd-compatible OpenRouter presets on Windows", () => {
		const commands = getAgentPresetCommands({ windows: true });
		expect(commands.kimi[0]).toStartWith('cmd /c "');
		expect(commands.kimi[0]).toContain(
			"set ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%",
		);
	});
});
