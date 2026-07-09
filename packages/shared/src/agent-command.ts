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
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

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
};

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
		'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
	],
	gemini: ["gemini --yolo"],
	opencode: ["opencode"],
	copilot: ["copilot --allow-all"],
	"cursor-agent": ["cursor-agent"],
	kimi: [buildOpenRouterCommand(OPENROUTER_MODELS.kimi, false)],
	minimax: [buildOpenRouterCommand(OPENROUTER_MODELS.minimax, false)],
	glm: [buildOpenRouterCommand(OPENROUTER_MODELS.glm, false)],
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

const WINDOWS_AGENT_COMMANDS: Record<AgentType, (prompt: string) => string> = {
	claude: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			"& claude --dangerously-skip-permissions $prompt",
		),
	codex: (prompt) =>
		buildPowerShellPromptCommand(
			prompt,
			`& codex --model 'gpt-5.5' -c 'model_reasoning_effort="high"' --ask-for-approval never --sandbox danger-full-access -- $prompt`,
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
			'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access --',
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
