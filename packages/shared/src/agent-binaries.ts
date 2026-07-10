import type { AgentType } from "./agent-command";

/**
 * The external CLIs ADE shells out to. Several agent runtimes share one binary:
 * the OpenRouter-proxied runtimes (kimi / minimax / glm) all drive the `claude`
 * CLI (see AGENT_PRESET_COMMANDS), so availability of those runtimes gates on
 * `claude` being installed.
 */
export type AgentBinary =
	| "claude"
	| "codex"
	| "opencode"
	| "gemini"
	| "copilot"
	| "cursor-agent"
	| "git";

/**
 * Maps an agent runtime to the external binary its launch command invokes. Used
 * to answer "is this model runnable on this machine?" without duplicating the
 * command-parsing logic in AGENT_PRESET_COMMANDS.
 */
export const RUNTIME_BINARY: Record<AgentType, AgentBinary> = {
	claude: "claude",
	codex: "codex",
	gemini: "gemini",
	opencode: "opencode",
	copilot: "copilot",
	"cursor-agent": "cursor-agent",
	kimi: "claude",
	minimax: "claude",
	glm: "claude",
	huggingface: "codex",
	ollama: "codex",
};

export interface BinaryInstallInfo {
	/** Human name shown in UI ("Claude Code", "Git"). */
	label: string;
	/** Primary one-line install command to copy/paste. */
	command: string;
	/** Docs / download URL. */
	url: string;
	/** Optional secondary hint (alternate installer, prerequisite note). */
	note?: string;
}

/**
 * Single source of truth for how to install each external binary. Consumed by
 * the renderer (not-detected dialogs), the create-agent git preflight, and the
 * terminal wrapper's missing-binary message so all three stay in sync.
 */
export const BINARY_INSTALL: Record<AgentBinary, BinaryInstallInfo> = {
	claude: {
		label: "Claude Code",
		command: "npm i -g @anthropic-ai/claude-code",
		url: "https://claude.com/claude-code",
	},
	codex: {
		label: "Codex CLI",
		command: "npm i -g @openai/codex",
		url: "https://developers.openai.com/codex/cli",
	},
	opencode: {
		label: "OpenCode",
		command: "npm i -g opencode-ai",
		url: "https://opencode.ai/docs",
		note: "Or: curl -fsSL https://opencode.ai/install | bash",
	},
	gemini: {
		label: "Gemini CLI",
		command: "npm i -g @google/gemini-cli",
		url: "https://github.com/google-gemini/gemini-cli",
	},
	copilot: {
		label: "GitHub Copilot CLI",
		command: "npm install -g @github/copilot",
		url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
		note: "Requires Node.js 22 or later; WinGet and Homebrew are also supported.",
	},
	"cursor-agent": {
		label: "Cursor Agent CLI",
		command: "curl https://cursor.com/install -fsS | bash",
		url: "https://docs.cursor.com/en/cli/installation",
		note: "The official Windows route currently uses WSL.",
	},
	git: {
		label: "Git",
		command: "xcode-select --install",
		url: "https://git-scm.com/downloads",
		note: "On macOS, Git ships with Apple's Command Line Tools.",
	},
};

export function getBinaryInstallInfo(
	binary: AgentBinary,
	platform: string = typeof process === "undefined"
		? "darwin"
		: process.platform,
): BinaryInstallInfo {
	const info = BINARY_INSTALL[binary];
	if (binary === "cursor-agent" && platform === "win32") {
		return {
			...info,
			command: "Start-Process 'https://docs.cursor.com/en/cli/installation'",
			note: "Follow Cursor's current Windows instructions. ADE detects a native cursor-agent.cmd when one is installed; the documented fallback uses WSL.",
		};
	}
	if (binary !== "git") return info;
	if (platform === "win32") {
		return {
			...info,
			command: "winget install --id Git.Git -e --source winget",
			note: "Restart ADE after Git for Windows finishes installing.",
		};
	}
	if (platform === "linux") {
		return {
			...info,
			command: "sudo apt-get update && sudo apt-get install -y git",
			note: "Use your distribution's package manager when apt is unavailable.",
		};
	}
	return info;
}

/** The binaries surfaced by the runtime-availability query. */
export const CHECKED_BINARIES = [
	"claude",
	"codex",
	"opencode",
	"gemini",
	"copilot",
	"cursor-agent",
	"git",
] as const satisfies readonly AgentBinary[];

export type CheckedBinary = (typeof CHECKED_BINARIES)[number];

export type RuntimeAvailability = Record<CheckedBinary, boolean>;
