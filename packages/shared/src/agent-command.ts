export const AGENT_TYPES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"copilot",
	"cursor-agent",
	"kimi",
	"minimax",
	"glm",
	"huggingface",
	"ollama",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const TERMINAL_AGENT_TYPES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"copilot",
	"cursor-agent",
] as const satisfies readonly AgentType[];
export type TerminalAgentType = (typeof TERMINAL_AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
	claude: "Claude",
	codex: "Codex",
	gemini: "Gemini",
	opencode: "OpenCode",
	copilot: "Copilot",
	"cursor-agent": "Cursor Agent",
	kimi: "Kimi K2.7",
	minimax: "MiniMax M3",
	glm: "GLM 5.2",
	huggingface: "Hugging Face",
	ollama: "Ollama",
};

export const OPEN_CODE_MODEL_PROVIDERS = ["huggingface", "ollama"] as const;
export type OpenCodeModelProvider = (typeof OPEN_CODE_MODEL_PROVIDERS)[number];
export const MODEL_PROVIDER_RUNNERS = ["codex", "opencode"] as const;
export type ModelProviderRunner = (typeof MODEL_PROVIDER_RUNNERS)[number];

export const OPEN_CODE_PROVIDER_BASE_URLS: Record<
	OpenCodeModelProvider,
	string
> = {
	huggingface: "https://router.huggingface.co/v1",
	ollama: "http://127.0.0.1:11434/v1",
};

const OPEN_CODE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export function isValidOpenCodeModelId(modelId: string): boolean {
	return OPEN_CODE_MODEL_ID_PATTERN.test(modelId.trim());
}

export function buildOpenCodeProviderConfig(
	profiles: Partial<Record<OpenCodeModelProvider, string>>,
): string | null {
	const provider: Record<string, unknown> = {};

	for (const providerId of OPEN_CODE_MODEL_PROVIDERS) {
		const modelId = profiles[providerId]?.trim();
		if (!modelId) continue;
		if (!isValidOpenCodeModelId(modelId)) {
			throw new Error(`Invalid ${providerId} model ID`);
		}

		provider[providerId] = {
			npm: "@ai-sdk/openai-compatible",
			name: providerId === "huggingface" ? "Hugging Face" : "Ollama",
			options: {
				baseURL: OPEN_CODE_PROVIDER_BASE_URLS[providerId],
				...(providerId === "huggingface" ? { apiKey: "{env:HF_TOKEN}" } : {}),
			},
			models: {
				[modelId]: { name: modelId },
			},
		};
	}

	if (Object.keys(provider).length === 0) return null;
	return JSON.stringify({
		$schema: "https://opencode.ai/config.json",
		provider,
	});
}

export function buildOpenCodeModelCommand({
	provider,
	modelId,
}: {
	provider: OpenCodeModelProvider;
	modelId: string;
}): string {
	const trimmed = modelId.trim();
	if (!isValidOpenCodeModelId(trimmed)) {
		throw new Error(
			"Model ID may only contain letters, numbers, /, :, ., _, @, +, and -",
		);
	}
	return `opencode -m "${provider}/${trimmed}"`;
}

export function buildProviderModelCommand({
	provider,
	modelId,
	runner = "codex",
}: {
	provider: OpenCodeModelProvider;
	modelId: string;
	runner?: ModelProviderRunner;
}): string {
	const trimmed = modelId.trim();
	if (!isValidOpenCodeModelId(trimmed)) {
		throw new Error(
			"Model ID may only contain letters, numbers, /, :, ., _, @, +, and -",
		);
	}

	if (runner === "opencode") {
		return buildOpenCodeModelCommand({ provider, modelId: trimmed });
	}

	if (provider === "ollama") {
		return `codex --oss --local-provider ollama -m "${trimmed}" --ask-for-approval on-request --sandbox workspace-write`;
	}

	return [
		"codex",
		`-c 'model_provider="huggingface"'`,
		`-c 'model_providers.huggingface.name="Hugging Face"'`,
		`-c 'model_providers.huggingface.base_url="${OPEN_CODE_PROVIDER_BASE_URLS.huggingface}"'`,
		`-c 'model_providers.huggingface.env_key="HF_TOKEN"'`,
		`-c 'model_providers.huggingface.wire_api="responses"'`,
		`-m "${trimmed}"`,
		"--ask-for-approval on-request",
		"--sandbox workspace-write",
	].join(" ");
}

const OPENROUTER_MODELS = {
	kimi: "moonshotai/kimi-k2.7-code",
	minimax: "minimax/minimax-m3",
	glm: "z-ai/glm-5.2",
} as const;

function buildOpenRouterCommand(model: string, windows: boolean): string {
	const claudeArgs = `claude --model ${model} --dangerously-skip-permissions`;
	if (windows) {
		return `cmd /c "set ANTHROPIC_BASE_URL=https://openrouter.ai/api&&set ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%&&set ANTHROPIC_API_KEY=&&${claudeArgs}"`;
	}
	return `ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" ${claudeArgs}`;
}

export const AGENT_PRESET_COMMANDS: Record<AgentType, string[]> = {
	claude: ["claude --dangerously-skip-permissions"],
	codex: [
		'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
	],
	gemini: ["gemini --yolo"],
	opencode: ["opencode"],
	copilot: ["copilot --allow-all"],
	"cursor-agent": ["cursor-agent"],
	kimi: [buildOpenRouterCommand(OPENROUTER_MODELS.kimi, false)],
	minimax: [buildOpenRouterCommand(OPENROUTER_MODELS.minimax, false)],
	glm: [buildOpenRouterCommand(OPENROUTER_MODELS.glm, false)],
	huggingface: ["codex"],
	ollama: ["codex"],
};

export function getAgentPresetCommands({
	windows,
}: {
	windows: boolean;
}): Record<AgentType, string[]> {
	if (!windows) return AGENT_PRESET_COMMANDS;
	return {
		...AGENT_PRESET_COMMANDS,
		kimi: [buildOpenRouterCommand(OPENROUTER_MODELS.kimi, true)],
		minimax: [buildOpenRouterCommand(OPENROUTER_MODELS.minimax, true)],
		glm: [buildOpenRouterCommand(OPENROUTER_MODELS.glm, true)],
	};
}

export const AGENT_PRESET_DESCRIPTIONS: Record<AgentType, string> = {
	claude: "Danger mode: All permissions auto-approved",
	codex: "Danger mode: All permissions auto-approved",
	gemini: "Danger mode: All permissions auto-approved",
	opencode: "OpenCode: Open-source AI coding agent",
	copilot: "Danger mode: All permissions auto-approved",
	"cursor-agent": "Cursor AI agent for terminal-based coding assistance",
	kimi: "Kimi K2.7 via Claude Code + OpenRouter",
	minimax: "MiniMax M3 via Claude Code + OpenRouter",
	glm: "GLM 5.2 via Claude Code + OpenRouter",
	huggingface: "Hugging Face cloud model via Codex",
	ollama: "Existing Ollama model via Codex",
};

export interface TaskInput {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	priority: string;
	statusName: string | null;
	labels: string[] | null;
}

function buildPrompt(task: TaskInput): string {
	const metadata = [
		`Priority: ${task.priority}`,
		task.statusName && `Status: ${task.statusName}`,
		task.labels?.length && `Labels: ${task.labels.join(", ")}`,
	]
		.filter(Boolean)
		.join("\n");

	return `You are working on task "${task.title}" (${task.slug}).

${metadata}

## Task Description

${task.description || "No description provided."}

## Instructions

You are running fully autonomously. Do not ask questions or wait for user feedback — make all decisions independently based on the codebase and task description.

1. Explore the codebase to understand the relevant code and architecture
2. Create a detailed execution plan for this task including:
   - Purpose and scope of the changes
   - Key assumptions
   - Concrete implementation steps with specific files to modify
   - How to validate the changes work correctly
3. Implement the plan
4. Verify your changes work correctly (run relevant tests, typecheck, lint)
5. When done, use the Superset MCP \`update_task\` tool to update task "${task.id}" with a summary of what was done`;
}

function buildHeredoc(
	prompt: string,
	delimiter: string,
	command: string,
	suffix?: string,
): string {
	const closing = suffix ? `)" ${suffix}` : ')"';
	return [
		`${command} "$(cat <<'${delimiter}'`,
		prompt,
		delimiter,
		closing,
	].join("\n");
}

const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
	let result = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1] ?? 0;
		const third = bytes[index + 2] ?? 0;
		const value = (first << 16) | (second << 8) | third;
		result += BASE64_ALPHABET[(value >> 18) & 63];
		result += BASE64_ALPHABET[(value >> 12) & 63];
		result +=
			index + 1 < bytes.length ? BASE64_ALPHABET[(value >> 6) & 63] : "=";
		result += index + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : "=";
	}
	return result;
}

function encodeUtf8(value: string): string {
	return bytesToBase64(new TextEncoder().encode(value));
}

function encodeUtf16Le(value: string): string {
	const bytes = new Uint8Array(value.length * 2);
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		bytes[index * 2] = codeUnit & 0xff;
		bytes[index * 2 + 1] = codeUnit >> 8;
	}
	return bytesToBase64(bytes);
}

function buildPowerShellPromptCommand(
	prompt: string,
	launchCommand: string,
	setupCommands: string[] = [],
): string {
	const encodedPrompt = encodeUtf8(prompt);
	const script = [
		"$ErrorActionPreference='Stop'",
		`$prompt=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPrompt}'))`,
		...setupCommands,
		launchCommand,
		"exit $LASTEXITCODE",
	].join(";");
	return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodeUtf16Le(script)}`;
}

export const SUBSCRIPTION_PROVIDERS = ["claude", "codex"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export function buildSubscriptionConnectCommand({
	provider,
	windows: _windows,
}: {
	provider: SubscriptionProvider;
	windows: boolean;
}): string {
	if (provider === "claude") return "claude auth login";
	// CODEX_HOME is injected into the terminal environment for the selected
	// account profile. Let the official CLI own its login and token files.
	return "codex login";
}

const WINDOWS_AGENT_COMMANDS: Record<AgentType, (prompt: string) => string> = {
	claude: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			"& claude --dangerously-skip-permissions $prompt",
		),
	codex: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			`& codex -c 'model_reasoning_effort="high"' --ask-for-approval never --sandbox danger-full-access -- $prompt`,
		),
	gemini: (prompt) =>
		buildPowerShellPromptCommand(prompt, "& gemini --yolo $prompt"),
	opencode: (prompt) =>
		buildPowerShellPromptCommand(prompt, "& opencode --prompt $prompt"),
	copilot: (prompt) =>
		buildPowerShellPromptCommand(prompt, "& copilot -i $prompt --yolo"),
	"cursor-agent": (prompt) =>
		buildPowerShellPromptCommand(prompt, "& cursor-agent --yolo $prompt"),
	kimi: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			`& claude --model '${OPENROUTER_MODELS.kimi}' --dangerously-skip-permissions $prompt`,
			[
				"$env:ANTHROPIC_BASE_URL='https://openrouter.ai/api'",
				"$env:ANTHROPIC_AUTH_TOKEN=$env:OPENROUTER_API_KEY",
				"$env:ANTHROPIC_API_KEY=''",
			],
		),
	minimax: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			`& claude --model '${OPENROUTER_MODELS.minimax}' --dangerously-skip-permissions $prompt`,
			[
				"$env:ANTHROPIC_BASE_URL='https://openrouter.ai/api'",
				"$env:ANTHROPIC_AUTH_TOKEN=$env:OPENROUTER_API_KEY",
				"$env:ANTHROPIC_API_KEY=''",
			],
		),
	glm: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			`& claude --model '${OPENROUTER_MODELS.glm}' --dangerously-skip-permissions $prompt`,
			[
				"$env:ANTHROPIC_BASE_URL='https://openrouter.ai/api'",
				"$env:ANTHROPIC_AUTH_TOKEN=$env:OPENROUTER_API_KEY",
				"$env:ANTHROPIC_API_KEY=''",
			],
		),
	huggingface: (prompt) =>
		buildPowerShellPromptCommand(prompt, "& codex -- $prompt"),
	ollama: (prompt) =>
		buildPowerShellPromptCommand(prompt, "& codex -- $prompt"),
};

const AGENT_COMMANDS: Record<
	AgentType,
	(prompt: string, delimiter: string) => string
> = {
	claude: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "claude --dangerously-skip-permissions"),
	codex: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access --',
		),
	gemini: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "gemini --yolo"),
	opencode: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "opencode --prompt"),
	copilot: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "copilot -i", "--yolo"),
	"cursor-agent": (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "cursor-agent --yolo"),
	kimi: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model moonshotai/kimi-k2.7-code --dangerously-skip-permissions',
		),
	minimax: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model minimax/minimax-m3 --dangerously-skip-permissions',
		),
	glm: (prompt, delimiter) =>
		buildHeredoc(
			prompt,
			delimiter,
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model z-ai/glm-5.2 --dangerously-skip-permissions',
		),
	huggingface: (prompt, delimiter) =>
		buildHeredoc(prompt, delimiter, "codex --"),
	ollama: (prompt, delimiter) => buildHeredoc(prompt, delimiter, "codex --"),
};

export function buildAgentPromptCommand({
	prompt,
	randomId,
	agent = "claude",
	windows = false,
}: {
	prompt: string;
	randomId: string;
	agent?: AgentType;
	windows?: boolean;
}): string {
	if (windows) {
		return WINDOWS_AGENT_COMMANDS[agent](prompt);
	}
	let delimiter = `SUPERSET_PROMPT_${randomId.replaceAll("-", "")}`;
	while (prompt.includes(delimiter)) {
		delimiter = `${delimiter}_X`;
	}
	const builder = AGENT_COMMANDS[agent];
	return builder(prompt, delimiter);
}

export function buildAgentCommand({
	task,
	randomId,
	agent = "claude",
	windows = false,
}: {
	task: TaskInput;
	randomId: string;
	agent?: AgentType;
	windows?: boolean;
}): string {
	const prompt = buildPrompt(task);
	return buildAgentPromptCommand({ prompt, randomId, agent, windows });
}

/** @deprecated Use `buildAgentCommand` instead */
export function buildClaudeCommand({
	task,
	randomId,
	windows = false,
}: {
	task: TaskInput;
	randomId: string;
	windows?: boolean;
}): string {
	return buildAgentCommand({ task, randomId, agent: "claude", windows });
}
