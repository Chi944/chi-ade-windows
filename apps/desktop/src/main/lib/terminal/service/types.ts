import type { AgentRuntime } from "@superset/local-db";

export interface SessionInfo {
	paneId: string;
	workspaceId: string;
	isAlive: boolean;
	lastActive: number;
	cwd: string;
	pid: number | null;
	cols: number;
	rows: number;
	runtime?: AgentRuntime | null;
	hidden?: boolean;
	exitReason?: "killed" | "exited" | "error";
	killedByUserAt?: number;
}

export interface ColdRestoreInfo {
	scrollback: string;
	previousCwd: string | undefined;
	claudeSessionId: string | undefined;
	agentRuntime: AgentRuntime | undefined;
	agentSessionId: string | undefined;
	cols: number;
	rows: number;
}
