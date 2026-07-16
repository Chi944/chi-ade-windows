import { EventEmitter } from "node:events";

export type SettingsSection =
	| "project"
	| "workspace"
	| "appearance"
	| "keyboard"
	| "terminal"
	| "integrations"
	| "health";

export interface OpenSettingsEvent {
	section?: SettingsSection;
}

export interface OpenWorkspaceEvent {
	workspaceId: string;
}

export const menuEmitter = new EventEmitter();
