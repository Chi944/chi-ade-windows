import {
	buildAgentCommand,
	TERMINAL_AGENT_TYPES,
} from "@superset/shared/agent-command";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useWorkspaceInitStore } from "renderer/stores/workspace-init";
import { z } from "zod";
import type { CommandResult, ToolContext, ToolDefinition } from "./types";

const schema = z.object({
	task: z.object({
		id: z.string(),
		slug: z.string(),
		title: z.string(),
		description: z.string().nullable(),
		priority: z.string(),
		statusName: z.string().nullable(),
		labels: z.array(z.string()).nullable(),
	}),
	randomId: z.string().uuid(),
	agent: z.enum(TERMINAL_AGENT_TYPES),
	name: z.string(),
	workspaceId: z.string(),
	paneId: z.string().optional(),
});

async function execute(
	params: z.infer<typeof schema>,
	ctx: ToolContext,
): Promise<CommandResult> {
	const workspaces = ctx.getWorkspaces();
	if (!workspaces || workspaces.length === 0) {
		return { success: false, error: "No workspaces available" };
	}

	const workspace = workspaces.find((ws) => ws.id === params.workspaceId);
	if (!workspace) {
		return {
			success: false,
			error: `Workspace not found: ${params.workspaceId}`,
		};
	}

	try {
		const command = buildAgentCommand({
			task: params.task,
			randomId: params.randomId,
			agent: params.agent,
			windows: process.platform === "win32",
		});
		if (params.paneId) {
			const tabsStore = useTabsStore.getState();
			const pane = tabsStore.panes[params.paneId];
			if (!pane) {
				return {
					success: false,
					error: `Pane not found: ${params.paneId}`,
				};
			}

			const tab = tabsStore.tabs.find((t) => t.id === pane.tabId);
			if (!tab || tab.workspaceId !== workspace.id) {
				return {
					success: false,
					error: `Tab not found for pane: ${params.paneId}`,
				};
			}

			const newPaneId = tabsStore.addPane(tab.id, {
				agentRuntime: params.agent,
			});

			if (!newPaneId) {
				return { success: false, error: "Failed to add pane" };
			}

			try {
				await launchCommandInPane({
					paneId: newPaneId,
					tabId: tab.id,
					workspaceId: workspace.id,
					command,
					runtime: params.agent,
					createOrAttach: (input) =>
						ctx.terminalCreateOrAttach.mutateAsync(input),
					write: (input) => ctx.terminalWrite.mutateAsync(input),
				});
			} catch (error) {
				tabsStore.removePane(newPaneId);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to start agent session",
				};
			}

			return {
				success: true,
				data: { workspaceId: workspace.id, paneId: newPaneId },
			};
		}

		// Without paneId: init workspace path
		const store = useWorkspaceInitStore.getState();
		const pending = store.pendingTerminalSetups[workspace.id];
		store.addPendingTerminalSetup({
			workspaceId: workspace.id,
			projectId: pending?.projectId ?? workspace.projectId,
			initialCommands: pending?.initialCommands ?? null,
			defaultPresets: pending?.defaultPresets,
			agentCommand: command,
			agentRuntime: params.agent,
		});

		return {
			success: true,
			data: {
				workspaceId: workspace.id,
				branch: workspace.branch,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to start agent session",
		};
	}
}

export const startAgentSession: ToolDefinition<typeof schema> = {
	name: "start_agent_session",
	schema,
	execute,
};
