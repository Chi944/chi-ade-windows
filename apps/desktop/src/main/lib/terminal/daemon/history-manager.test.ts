import { describe, expect, it, mock } from "bun:test";
import type { HistoryWriter } from "../../terminal-history";
import type { SessionInfo } from "./types";

mock.module("shared/constants", () => ({ SUPERSET_DIR_NAME: ".ade-test" }));

const { HistoryManager, scanAgentSessionOutput } = await import(
	"./history-manager"
);

const FIRST_ID = "123e4567-e89b-12d3-a456-426614174000";
const SECOND_ID = "223e4567-e89b-12d3-a456-426614174000";

describe("scanAgentSessionOutput", () => {
	it("does not scan an entire historical scrollback snapshot", () => {
		const scan = scanAgentSessionOutput(
			"codex",
			"",
			`thread-id: ${FIRST_ID}${"x".repeat(600)}`,
		);

		expect(scan.sessionId).toBeUndefined();
		expect(scan.tail.length).toBe(512);
	});

	it("retains enough live tail to detect an id split across chunks", () => {
		const first = scanAgentSessionOutput(
			"codex",
			"",
			`thread-id: ${FIRST_ID.slice(0, 18)}`,
		);
		const second = scanAgentSessionOutput(
			"codex",
			first.tail,
			FIRST_ID.slice(18),
		);

		expect(first.sessionId).toBeUndefined();
		expect(second.sessionId).toBe(FIRST_ID);
	});
});

describe("HistoryManager hook routing", () => {
	it("queues a hook during writer initialization, then routes later hooks live", async () => {
		let releaseInit: (() => void) | undefined;
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});
		const updateFromHook = mock(async () => {});
		const fakeWriter = {
			init: mock(async () => initGate),
			updateAgentSessionFromHook: updateFromHook,
			updateAgentSession: mock(() => {}),
			write: mock(() => {}),
		} as unknown as HistoryWriter;
		const manager = new HistoryManager(() => fakeWriter);

		const initializing = manager.initHistoryWriter({
			paneId: "pane-1",
			workspaceId: "workspace-1",
			cwd: "C:\\repo",
			cols: 120,
			rows: 40,
			runtime: "codex",
		});
		await Promise.resolve();

		expect(
			await manager.updateAgentSessionFromHook({
				paneId: "pane-1",
				workspaceId: "workspace-1",
				runtime: "codex",
				sessionId: FIRST_ID,
			}),
		).toBe(true);
		expect(updateFromHook).not.toHaveBeenCalled();

		releaseInit?.();
		await initializing;
		expect(updateFromHook).toHaveBeenCalledWith("codex", FIRST_ID);

		expect(
			await manager.updateAgentSessionFromHook({
				paneId: "pane-1",
				workspaceId: "workspace-1",
				runtime: "codex",
				sessionId: SECOND_ID,
			}),
		).toBe(true);
		expect(updateFromHook).toHaveBeenLastCalledWith("codex", SECOND_ID);
	});

	it("invalidates and awaits an in-flight writer before deleting history", async () => {
		let releaseInit: (() => void) | undefined;
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});
		const close = mock(async () => {});
		const fakeWriter = {
			init: mock(async () => initGate),
			close,
			updateAgentSessionFromHook: mock(async () => {}),
			updateAgentSession: mock(() => {}),
			write: mock(() => {}),
		} as unknown as HistoryWriter;
		const manager = new HistoryManager(() => fakeWriter);
		const initializing = manager.initHistoryWriter({
			paneId: "pane-delete-during-init",
			workspaceId: "workspace-delete-during-init",
			cwd: "C:\\repo",
			cols: 120,
			rows: 40,
			runtime: "codex",
		});
		await Promise.resolve();

		let cleanupFinished = false;
		const cleanup = manager
			.cleanupHistory("pane-delete-during-init", "workspace-delete-during-init")
			.then(() => {
				cleanupFinished = true;
			});
		await Promise.resolve();
		expect(cleanupFinished).toBe(false);

		releaseInit?.();
		await Promise.all([initializing, cleanup]);
		expect(close).toHaveBeenCalledTimes(1);
		expect(manager.getHistoryWriter("pane-delete-during-init")).toBeUndefined();
	});

	it("does not initialize a reused pane until its prior writer has closed", async () => {
		let releaseClose: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const firstWriter = {
			init: mock(async () => {}),
			close: mock(async () => closeGate),
			updateAgentSessionFromHook: mock(async () => {}),
			updateAgentSession: mock(() => {}),
			write: mock(() => {}),
		} as unknown as HistoryWriter;
		const secondWriter = {
			init: mock(async () => {}),
			close: mock(async () => {}),
			updateAgentSessionFromHook: mock(async () => {}),
			updateAgentSession: mock(() => {}),
			write: mock(() => {}),
		} as unknown as HistoryWriter;
		let factoryCalls = 0;
		const manager = new HistoryManager(() => {
			factoryCalls++;
			return factoryCalls === 1 ? firstWriter : secondWriter;
		});
		const params = {
			paneId: "pane-reused-after-close",
			workspaceId: "workspace-reused-after-close",
			cwd: "C:\\repo",
			cols: 120,
			rows: 40,
			runtime: "codex" as const,
		};

		await manager.initHistoryWriter(params);
		const closing = manager.closeHistoryWriter(params.paneId);
		const reopening = manager.initHistoryWriter(params);
		await Promise.resolve();
		expect(factoryCalls).toBe(1);

		releaseClose?.();
		await Promise.all([closing, reopening]);
		expect(factoryCalls).toBe(2);
		await manager.closeHistoryWriter(params.paneId);
	});

	it("does not recreate history when the pane is replaced during a clear", async () => {
		let releaseClose: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const writer = {
			init: mock(async () => {}),
			close: mock(async () => closeGate),
			updateAgentSessionFromHook: mock(async () => {}),
			updateAgentSession: mock(() => {}),
			write: mock(() => {}),
		} as unknown as HistoryWriter;
		let factoryCalls = 0;
		const manager = new HistoryManager(() => {
			factoryCalls++;
			return writer;
		});
		const session: SessionInfo = {
			paneId: "pane-clear-exit",
			workspaceId: "workspace-clear-exit",
			isAlive: true,
			lastActive: Date.now(),
			cwd: "C:\\repo",
			pid: 123,
			cols: 120,
			rows: 40,
			runtime: "codex" as const,
		};
		await manager.initHistoryWriter({
			paneId: session.paneId,
			workspaceId: session.workspaceId,
			cwd: session.cwd,
			cols: session.cols,
			rows: session.rows,
			runtime: session.runtime,
		});

		let currentSession = session;
		manager.writeToHistory(session.paneId, "\x1b[3J", () => currentSession);
		currentSession = { ...session, runtime: "claude" };
		releaseClose?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(factoryCalls).toBe(1);
		expect(manager.getHistoryWriter(session.paneId)).toBeUndefined();
	});
});
