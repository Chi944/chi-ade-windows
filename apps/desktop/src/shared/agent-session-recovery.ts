import type { AgentRuntime } from "@superset/local-db";

const UUID_PATTERN =
	"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, "i");
const OPAQUE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const HUGGING_FACE_CODEX_RESUME_PREFIX = [
	"codex",
	`-c 'model_provider="huggingface"'`,
	`-c 'model_providers.huggingface.name="Hugging Face"'`,
	`-c 'model_providers.huggingface.base_url="https://router.huggingface.co/v1"'`,
	`-c 'model_providers.huggingface.env_key="HF_TOKEN"'`,
	`-c 'model_providers.huggingface.wire_api="responses"'`,
].join(" ");
const SAFE_CUSTOM_PROVIDER_FLAGS =
	"--ask-for-approval on-request --sandbox workspace-write";

function firstCapture(value: string, patterns: RegExp[]): string | undefined {
	for (const pattern of patterns) {
		const match = value.match(pattern);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

/** Extract the stable conversation id emitted by supported agent CLIs. */
export function extractAgentSessionId(
	runtime: AgentRuntime | null | undefined,
	output: string,
): string | undefined {
	if (!runtime || !output) return undefined;

	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape prefix
	const plain = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

	if (runtime === "claude") {
		return firstCapture(plain, [
			new RegExp(`claude\\s+--resume\\s+(${UUID_PATTERN})`, "i"),
			new RegExp(
				`[/\\\\]claude-\\d+[/\\\\][^/\\\\]+[/\\\\](${UUID_PATTERN})[/\\\\]`,
				"i",
			),
			new RegExp(
				`\\.claude[/\\\\]projects[/\\\\][^/\\\\]+[/\\\\](${UUID_PATTERN})\\.jsonl`,
				"i",
			),
			new RegExp(`--resume\\s+(${UUID_PATTERN})`, "i"),
		]);
	}

	if (
		runtime === "codex" ||
		runtime === "huggingface" ||
		runtime === "ollama"
	) {
		return firstCapture(plain, [
			new RegExp(`codex\\s+resume(?:\\s+--last)?\\s+(${UUID_PATTERN})`, "i"),
			new RegExp(`(?:thread|session)[-_ ]id[=: ]+(${UUID_PATTERN})`, "i"),
			new RegExp(
				`\\.codex[/\\\\]sessions[/\\\\].*?rollout-[^\\s/\\\\]*?(${UUID_PATTERN})\\.jsonl`,
				"i",
			),
		]);
	}

	return undefined;
}

/** IDs are interpolated into a terminal command, so accept only provider-safe forms. */
export function isValidAgentSessionId(
	runtime: AgentRuntime | null | undefined,
	sessionId: string | null | undefined,
): sessionId is string {
	if (!runtime || !sessionId) return false;
	if (
		runtime === "claude" ||
		runtime === "codex" ||
		runtime === "huggingface" ||
		runtime === "ollama"
	) {
		return UUID_RE.test(sessionId);
	}
	return runtime === "opencode" && OPAQUE_SESSION_ID_RE.test(sessionId);
}

/** Build the CLI command that continues a pane's previous conversation. */
export function buildAgentResumeCommand({
	runtime,
	sessionId,
}: {
	runtime: AgentRuntime | null | undefined;
	sessionId?: string | null;
}): string | null {
	if (!isValidAgentSessionId(runtime, sessionId)) return null;

	if (runtime === "claude") {
		return `claude --resume ${sessionId} --dangerously-skip-permissions`;
	}

	if (runtime === "codex") {
		return `codex resume ${sessionId}`;
	}
	if (runtime === "huggingface") {
		return `${HUGGING_FACE_CODEX_RESUME_PREFIX} ${SAFE_CUSTOM_PROVIDER_FLAGS} resume ${sessionId}`;
	}
	if (runtime === "ollama") {
		return `codex --oss --local-provider ollama ${SAFE_CUSTOM_PROVIDER_FLAGS} resume ${sessionId}`;
	}

	if (runtime === "opencode") {
		return `opencode --session ${sessionId}`;
	}

	return null;
}
