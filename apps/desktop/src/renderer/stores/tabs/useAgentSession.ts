import type { AgentRuntime, TerminalPreset } from "@superset/local-db";
import {
	AGENT_LABELS,
	getAgentPresetCommands,
} from "@superset/shared/agent-command";
import { useCallback } from "react";
import type { PresetOpenTarget } from "./preset-launch";
import { useTabsWithPresets } from "./useTabsWithPresets";

/** Minimal shape needed to spawn an agent's runtime CLI session. */
export interface AgentSessionWorkspace {
	id: string;
	runtime?: AgentRuntime | null;
	worktreePath?: string | null;
}

export interface AgentSessionOptions {
	commands?: string[];
	name?: string;
	target?: PresetOpenTarget;
	subscriptionProfileId?: string | null;
}

/**
 * Spawns an agent's runtime CLI in a new terminal session tab.
 *
 * A "session" is just a normal terminal tab. Given an agent (workspace) with a
 * runtime, we build a synthetic TerminalPreset that launches the runtime's CLI
 * (via AGENT_PRESET_COMMANDS) in the agent's worktree and open it as a new tab.
 * When the agent has no runtime we fall back to a plain shell tab.
 */
export function useAgentSession() {
	const { openPreset, addTab } = useTabsWithPresets();

	const spawnAgentSession = useCallback(
		(workspace: AgentSessionWorkspace, options?: AgentSessionOptions) => {
			const { id, runtime, worktreePath } = workspace;
			const cwd = worktreePath || undefined;
			const target = options?.target ?? "new-tab";

			if (
				!runtime ||
				((runtime === "huggingface" || runtime === "ollama") &&
					!options?.commands)
			) {
				// No runtime configured — open a plain shell in the worktree.
				if (target === "new-tab") {
					return addTab(id, {
						initialCwd: cwd,
						subscriptionProfileId: options?.subscriptionProfileId,
					});
				}

				const plainShellPreset: TerminalPreset = {
					id: "agent-shell",
					name: options?.name ?? "Terminal",
					cwd: worktreePath ?? "",
					commands: [],
					executionMode: "split-pane",
				};
				return openPreset(id, plainShellPreset, {
					target,
					subscriptionProfileId: options?.subscriptionProfileId,
				});
			}

			const preset: TerminalPreset = {
				id: `agent-${runtime}`,
				name: options?.name ?? AGENT_LABELS[runtime] ?? runtime,
				cwd: worktreePath ?? "",
				commands:
					options?.commands ??
					getAgentPresetCommands({
						windows: process.platform === "win32",
					})[runtime],
				executionMode: target === "active-tab" ? "split-pane" : "new-tab",
			};

			return openPreset(id, preset, {
				target,
				runtime,
				subscriptionProfileId: options?.subscriptionProfileId,
			});
		},
		[openPreset, addTab],
	);

	return { spawnAgentSession };
}
