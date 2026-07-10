/**
 * Models offered in the ModelBar launch row. `runtime` maps to the agent
 * runtime / launch command (see AGENT_PRESET_COMMANDS); `iconName` is the
 * getPresetIcon key when a provider-specific React icon is not used. Display
 * labels are a product decision and live here rather
 * than deriving from AGENT_LABELS so the row reads the way the user asked
 * (e.g. the OpenAI mark for the Codex runtime).
 *
 * The OpenRouter-proxied runtimes (kimi, minimax, glm) require a bring-your-own
 * OpenRouter key before they can launch.
 */
import type { AgentRuntime } from "@superset/local-db";

export interface ModelDescriptor {
	/** Agent runtime slug — drives the launch command. */
	runtime: AgentRuntime;
	/** getPresetIcon key. */
	iconName: string;
	/** Tooltip / display name. */
	label: string;
	/** Provider Hub connection/profile required before this model can spawn. */
	provider?: "openrouter" | "huggingface" | "ollama";
	/** Marked as the default model (subtle emphasis). */
	isDefault?: boolean;
}

export const MODEL_BAR_MODELS: ModelDescriptor[] = [
	{
		runtime: "claude",
		iconName: "claude",
		label: "Claude",
		isDefault: true,
	},
	{
		runtime: "codex",
		iconName: "codex",
		label: "OpenAI",
	},
	{
		runtime: "kimi",
		iconName: "kimi",
		label: "Kimi K2.7",
		provider: "openrouter",
	},
	{
		runtime: "minimax",
		iconName: "minimax",
		label: "MiniMax M3",
		provider: "openrouter",
	},
	{
		runtime: "glm",
		iconName: "glm",
		label: "GLM 5.2",
		provider: "openrouter",
	},
	{
		runtime: "huggingface",
		iconName: "huggingface",
		label: "Hugging Face",
		provider: "huggingface",
	},
	{
		runtime: "ollama",
		iconName: "ollama",
		label: "Ollama",
		provider: "ollama",
	},
];
