import type { AgentRuntime } from "@superset/local-db";

interface TerminalCreateOrAttachInput {
	paneId: string;
	tabId: string;
	workspaceId: string;
	runtime?: AgentRuntime;
	subscriptionProfileId?: string | null;
}

interface TerminalWriteInput {
	paneId: string;
	data: string;
	throwOnError?: boolean;
}

interface LaunchCommandInPaneOptions {
	paneId: string;
	tabId: string;
	workspaceId: string;
	command: string;
	runtime?: AgentRuntime;
	subscriptionProfileId?: string | null;
	createOrAttach: (input: TerminalCreateOrAttachInput) => Promise<unknown>;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

export function normalizeTerminalCommand(command: string): string {
	return `${command.replace(/[\r\n]+$/, "")}\r`;
}

interface WriteCommandInPaneOptions {
	paneId: string;
	command: string;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

interface WriteCommandsInPaneOptions {
	paneId: string;
	commands: string[] | null | undefined;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

export function buildTerminalCommand(
	commands: string[] | null | undefined,
): string | null {
	if (!Array.isArray(commands) || commands.length === 0) return null;
	return commands.join(" && ");
}

export async function writeCommandInPane({
	paneId,
	command,
	write,
}: WriteCommandInPaneOptions): Promise<void> {
	await write({
		paneId,
		data: normalizeTerminalCommand(command),
		throwOnError: true,
	});
}

export async function writeCommandsInPane({
	paneId,
	commands,
	write,
}: WriteCommandsInPaneOptions): Promise<void> {
	const command = buildTerminalCommand(commands);
	if (!command) return;
	await writeCommandInPane({ paneId, command, write });
}

export async function launchCommandInPane({
	paneId,
	tabId,
	workspaceId,
	command,
	runtime,
	subscriptionProfileId,
	createOrAttach,
	write,
}: LaunchCommandInPaneOptions): Promise<void> {
	await createOrAttach({
		paneId,
		tabId,
		workspaceId,
		...(runtime ? { runtime } : {}),
		...(subscriptionProfileId !== undefined ? { subscriptionProfileId } : {}),
	});

	await writeCommandInPane({ paneId, command, write });
}
