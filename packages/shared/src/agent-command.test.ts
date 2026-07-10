import { describe, expect, it } from "bun:test";
import {
	buildAgentPromptCommand,
	buildOpenCodeModelCommand,
	buildOpenCodeProviderConfig,
	buildProviderModelCommand,
	buildSubscriptionConnectCommand,
	getAgentPresetCommands,
	isValidOpenCodeModelId,
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

	it("lets Codex select the current CLI default model", () => {
		const commands = getAgentPresetCommands({ windows: true });
		expect(commands.codex[0]).not.toContain("--model");
		expect(commands.codex[0]).toContain("--sandbox danger-full-access");
	});
});

describe("OpenCode model providers", () => {
	it("builds Hugging Face and Ollama OpenAI-compatible config", () => {
		const config = JSON.parse(
			buildOpenCodeProviderConfig({
				huggingface: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
				ollama: "qwen3-coder:30b",
			}) ?? "{}",
		);

		expect(config.provider.huggingface.options).toEqual({
			baseURL: "https://router.huggingface.co/v1",
			apiKey: "{env:HF_TOKEN}",
		});
		expect(config.provider.ollama.options).toEqual({
			baseURL: "http://127.0.0.1:11434/v1",
		});
		expect(
			config.provider.huggingface.models["Qwen/Qwen3-Coder-480B-A35B-Instruct"],
		).toBeDefined();
		expect(config.provider.ollama.models["qwen3-coder:30b"]).toBeDefined();
	});

	it("launches the selected model in the native OpenCode TUI", () => {
		expect(
			buildOpenCodeModelCommand({
				provider: "huggingface",
				modelId: "Qwen/Qwen3-Coder",
			}),
		).toBe('opencode -m "huggingface/Qwen/Qwen3-Coder"');
		expect(
			buildOpenCodeModelCommand({
				provider: "ollama",
				modelId: "qwen3-coder:30b",
			}),
		).toBe('opencode -m "ollama/qwen3-coder:30b"');
	});

	it("uses Codex for Hugging Face and Ollama without downloading model weights", () => {
		const huggingFace = buildProviderModelCommand({
			provider: "huggingface",
			modelId: "Qwen/Qwen3-Coder",
		});
		expect(huggingFace).toContain(
			'model_providers.huggingface.base_url="https://router.huggingface.co/v1"',
		);
		expect(huggingFace).toContain(
			'model_providers.huggingface.env_key="HF_TOKEN"',
		);
		expect(huggingFace).toContain(
			'model_providers.huggingface.wire_api="responses"',
		);
		expect(huggingFace).toContain("--ask-for-approval on-request");
		expect(huggingFace).toContain("--sandbox workspace-write");
		expect(huggingFace).not.toContain("danger-full-access");

		const ollama = buildProviderModelCommand({
			provider: "ollama",
			modelId: "qwen3-coder:30b",
		});
		expect(ollama).toContain(
			'codex --oss --local-provider ollama -m "qwen3-coder:30b"',
		);
		expect(ollama).toContain("--ask-for-approval on-request");
		expect(ollama).toContain("--sandbox workspace-write");
		expect(ollama).not.toContain("danger-full-access");
	});

	it("rejects model IDs that could inject shell commands", () => {
		expect(isValidOpenCodeModelId("org/model:latest")).toBe(true);
		expect(isValidOpenCodeModelId("model && calc.exe")).toBe(false);
		expect(() =>
			buildOpenCodeModelCommand({
				provider: "ollama",
				modelId: "model; rm -rf /",
			}),
		).toThrow();
	});
});

describe("subscription connection commands", () => {
	it("uses the CLIs' interactive login flows without handling credentials", () => {
		expect(
			buildSubscriptionConnectCommand({ provider: "claude", windows: true }),
		).toBe("claude auth login");
		expect(
			buildSubscriptionConnectCommand({ provider: "codex", windows: false }),
		).toBe('CODEX_HOME="$HOME/.codex" codex login');
	});

	it("forces Windows Codex login into the shared global home", () => {
		const command = buildSubscriptionConnectCommand({
			provider: "codex",
			windows: true,
		});
		const encoded = command.split(" ").at(-1) ?? "";
		const script = Buffer.from(encoded, "base64").toString("utf16le");

		expect(script).toContain(
			"$env:CODEX_HOME=[IO.Path]::Combine($HOME,'.codex')",
		);
		expect(script).toContain("& codex login");
	});
});
