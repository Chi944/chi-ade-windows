import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionMetadata } from "./terminal-history";

mock.module("shared/constants", () => ({ SUPERSET_DIR_NAME: ".ade-test" }));

const {
	cleanupTerminalHistoryForWorkspace,
	getTerminalHistoryRootDir,
	mergeSessionMetadata,
} = await import("./terminal-history");

const FIRST_ID = "123e4567-e89b-12d3-a456-426614174000";
const SECOND_ID = "223e4567-e89b-12d3-a456-426614174000";

const BASE_METADATA: SessionMetadata = {
	cwd: "C:\\repo",
	cols: 120,
	rows: 40,
	startedAt: "2026-07-10T00:00:00.000Z",
	agentRuntime: "codex",
};

describe("mergeSessionMetadata", () => {
	it("purges every retained pane history after a workspace commit", async () => {
		const workspaceId = `workspace-purge-${process.pid}-${Date.now()}`;
		const workspaceDir = join(getTerminalHistoryRootDir(), workspaceId);
		const paneDir = join(workspaceDir, "closed-pane");
		mkdirSync(paneDir, { recursive: true });
		writeFileSync(join(paneDir, "scrollback.bin"), "retained history");

		try {
			expect(await cleanupTerminalHistoryForWorkspace(workspaceId)).toBe(true);
			expect(existsSync(workspaceDir)).toBe(false);
			expect(await cleanupTerminalHistoryForWorkspace(workspaceId)).toBe(false);
		} finally {
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("never lets PTY fallback replace an existing valid session id", () => {
		const merged = mergeSessionMetadata(
			{
				...BASE_METADATA,
				agentSessionId: FIRST_ID,
				agentSessionIdSource: "hook",
			},
			{
				...BASE_METADATA,
				agentSessionId: SECOND_ID,
				agentSessionIdSource: "output",
			},
		);

		expect(merged.agentSessionId).toBe(FIRST_ID);
		expect(merged.agentSessionIdSource).toBe("hook");
	});

	it("keeps the first valid fallback id until a hook supplies one", () => {
		const merged = mergeSessionMetadata(
			{
				...BASE_METADATA,
				agentSessionId: FIRST_ID,
				agentSessionIdSource: "output",
			},
			{
				...BASE_METADATA,
				agentSessionId: SECOND_ID,
				agentSessionIdSource: "output",
			},
		);

		expect(merged.agentSessionId).toBe(FIRST_ID);
		expect(merged.agentSessionIdSource).toBe("output");
	});

	it("lets a hook replace fallback output while preserving endedAt", () => {
		const endedAt = "2026-07-10T01:00:00.000Z";
		const merged = mergeSessionMetadata(
			{
				...BASE_METADATA,
				endedAt,
				exitCode: 0,
				agentSessionId: FIRST_ID,
				agentSessionIdSource: "output",
			},
			{
				agentRuntime: "codex",
				agentSessionId: SECOND_ID,
				agentSessionIdSource: "hook",
			},
		);

		expect(merged.agentSessionId).toBe(SECOND_ID);
		expect(merged.agentSessionIdSource).toBe("hook");
		expect(merged.endedAt).toBe(endedAt);
		expect(merged.exitCode).toBe(0);
	});

	it("preserves an authoritative hook id when close metadata adds endedAt", () => {
		const endedAt = "2026-07-10T01:00:00.000Z";
		const merged = mergeSessionMetadata(
			{
				...BASE_METADATA,
				agentSessionId: FIRST_ID,
				agentSessionIdSource: "hook",
			},
			{
				...BASE_METADATA,
				endedAt,
				exitCode: 0,
				agentSessionId: SECOND_ID,
				agentSessionIdSource: "output",
			},
		);

		expect(merged.agentSessionId).toBe(FIRST_ID);
		expect(merged.agentSessionIdSource).toBe("hook");
		expect(merged.endedAt).toBe(endedAt);
		expect(merged.exitCode).toBe(0);
	});

	it("clears endedAt for a new live writer without losing its hook id", () => {
		const merged = mergeSessionMetadata(
			{
				...BASE_METADATA,
				endedAt: "2026-07-10T01:00:00.000Z",
				exitCode: 0,
				agentSessionId: FIRST_ID,
				agentSessionIdSource: "hook",
			},
			BASE_METADATA,
			{ clearEndedAt: true },
		);

		expect(merged.endedAt).toBeUndefined();
		expect(merged.exitCode).toBeUndefined();
		expect(merged.agentSessionId).toBe(FIRST_ID);
	});

	it("drops a stale id when the pane runtime changes", () => {
		const merged = mergeSessionMetadata(
			{
				...BASE_METADATA,
				agentRuntime: "claude",
				agentSessionId: FIRST_ID,
				agentSessionIdSource: "hook",
				claudeSessionId: FIRST_ID,
			},
			BASE_METADATA,
		);

		expect(merged.agentRuntime).toBe("codex");
		expect(merged.agentSessionId).toBeUndefined();
		expect(merged.claudeSessionId).toBeUndefined();
	});
});
