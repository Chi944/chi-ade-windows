import {
	AGENT_PRESET_DESCRIPTIONS,
	AGENT_TYPES,
	getAgentPresetCommands,
} from "@superset/shared/agent-command";

export type AutoApplyField = "applyOnWorkspaceCreated" | "applyOnNewTab";

export interface PresetTemplate {
	name: string;
	preset: {
		name: string;
		description: string;
		cwd: string;
		commands: string[];
	};
}

export function getPresetTemplates(windows: boolean): PresetTemplate[] {
	const commands = getAgentPresetCommands({ windows });
	return AGENT_TYPES.map((agent) => ({
		name: agent,
		preset: {
			name: agent,
			description: AGENT_PRESET_DESCRIPTIONS[agent],
			cwd: "",
			commands: commands[agent],
		},
	}));
}
