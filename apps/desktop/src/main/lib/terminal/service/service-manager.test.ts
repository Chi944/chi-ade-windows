import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { SessionInfo } from "./types";

class MockTerminalHostClient extends EventEmitter {
	killCalls: Array<{ sessionId: string; deleteHistory?: boolean }> = [];
	shutdownCalls: Array<{ killSessions?: boolean }> = [];
	createCalls: Array<{ sessionId: string }> = [];
	writeCalls: Array<{ sessionId: string; data: string }> = [];
	createGate: Promise<void> | null = null;
	connected = true;
	listedSessions: Array<{
		sessionId: string;
		workspaceId: string;
		paneId: string;
		isAlive: boolean;
		attachedClients: number;
		pid: number | null;
	}> = [];
	onShutdown: (() => void) | null = null;

	async createOrAttach(params: { sessionId: string }) {
		this.createCalls.push(params);
		if (this.createGate) await this.createGate;
		return {
			isNew: true,
			wasRecovered: false,
			pid: 456,
			snapshot: {
				snapshotAnsi: "",
				rehydrateSequences: "",
				cwd: null,
				modes: {},
				cols: 80,
				rows: 24,
				scrollbackLines: 0,
			},
		};
	}

	async kill(params: { sessionId: string; deleteHistory?: boolean }) {
		this.killCalls.push(params);
	}

	async listSessions() {
		return { sessions: this.listedSessions };
	}

	async tryConnectAndAuthenticate() {
		return this.connected;
	}

	async shutdownIfRunning(params: { killSessions?: boolean }) {
		this.shutdownCalls.push(params);
		this.onShutdown?.();
		return { wasRunning: this.connected };
	}

	writeNoAck(params: { sessionId: string; data: string }) {
		this.writeCalls.push(params);
	}
	resize() {
		return Promise.resolve();
	}
	signal() {
		return Promise.resolve();
	}
	detach() {
		return Promise.resolve();
	}
	clearScrollback() {
		return Promise.resolve();
	}
}

let mockClient = new MockTerminalHostClient();
const releasedProviderPanes: string[] = [];
const releasedProviderWorkspaces: string[] = [];

mock.module("../../terminal-host/client", () => ({
	getTerminalHostClient: () => mockClient,
	disposeTerminalHostClient: () => {},
}));

mock.module("main/lib/analytics", () => ({
	track: () => {},
}));

mock.module("main/lib/app-state", () => ({
	appState: { data: null },
}));

mock.module("main/lib/local-db", () => ({
	localDb: {
		select: () => ({
			from: () => ({
				all: () => [],
				get: () => undefined,
			}),
		}),
	},
}));

mock.module("main/lib/subscription-profiles", () => ({
	releaseSubscriptionProfilePane: (paneId: string) => {
		releasedProviderPanes.push(paneId);
		return true;
	},
	releaseSubscriptionProfileWorkspace: (workspaceId: string) => {
		releasedProviderWorkspaces.push(workspaceId);
		return 1;
	},
}));

mock.module("@superset/local-db", () => ({
	workspaces: { id: "id" },
}));

const { ServiceTerminalManager } = await import("./service-manager");

describe("ServiceTerminalManager kill tracking", () => {
	beforeEach(() => {
		mockClient = new MockTerminalHostClient();
		releasedProviderPanes.length = 0;
		releasedProviderWorkspaces.length = 0;
	});

	it("proves captured provider process trees and the host are dead before migration", async () => {
		const manager = new ServiceTerminalManager();
		mockClient.listedSessions = [
			{
				sessionId: "provider-pane",
				workspaceId: "workspace",
				paneId: "provider-pane",
				isAlive: true,
				attachedClients: 0,
				pid: 200,
			},
		];
		const alive = new Set([200, 201, 999]);
		const events: string[] = [];
		mockClient.onShutdown = () => {
			events.push("shutdown-host");
			alive.delete(999);
		};

		await manager.shutdownForSubscriptionProfileMigration({
			enumerateProcessTree: async (pid) => {
				events.push(`enumerate-${pid}`);
				return [pid, 201];
			},
			terminateProcessTree: async (pid) => {
				events.push(`terminate-${pid}`);
				alive.delete(pid);
				alive.delete(201);
				return { success: true };
			},
			isProcessAlive: (pid) => alive.has(pid),
			readHostPid: () => 999,
			sleep: async () => {},
		});

		expect(events).toEqual([
			"enumerate-999",
			"enumerate-200",
			"terminate-200",
			"shutdown-host",
		]);
		expect(mockClient.shutdownCalls).toEqual([{ killSessions: true }]);
	});

	it("refuses migration when a captured provider child survives tree termination", async () => {
		const manager = new ServiceTerminalManager();
		mockClient.listedSessions = [
			{
				sessionId: "provider-pane",
				workspaceId: "workspace",
				paneId: "provider-pane",
				isAlive: true,
				attachedClients: 0,
				pid: 200,
			},
		];
		const alive = new Set([200, 201, 999]);

		expect(
			manager.shutdownForSubscriptionProfileMigration({
				enumerateProcessTree: async (pid) => [pid, 201],
				terminateProcessTree: async (pid) => {
					if (pid === 201) return { success: false };
					alive.delete(pid);
					return { success: true };
				},
				isProcessAlive: (pid) => alive.has(pid),
				readHostPid: () => 999,
				sleep: async () => {},
				timeoutMs: 0,
			}),
		).rejects.toThrow("provider terminal process");
		expect(mockClient.shutdownCalls).toHaveLength(0);
	});

	it("refuses migration when shutdown is acknowledged but the host survives", async () => {
		const manager = new ServiceTerminalManager();
		const alive = new Set([999]);

		expect(
			manager.shutdownForSubscriptionProfileMigration({
				enumerateProcessTree: async (pid) => [pid],
				terminateProcessTree: async () => ({ success: true }),
				isProcessAlive: (pid) => alive.has(pid),
				readHostPid: () => 999,
				sleep: async () => {},
				timeoutMs: 0,
			}),
		).rejects.toThrow("terminal host process");
	});

	it("captures a pre-spawn session subprocess through the host process tree", async () => {
		const manager = new ServiceTerminalManager();
		mockClient.listedSessions = [
			{
				sessionId: "pre-spawn-provider-pane",
				workspaceId: "workspace",
				paneId: "pre-spawn-provider-pane",
				isAlive: true,
				attachedClients: 0,
				pid: null,
			},
		];
		const alive = new Set([250, 999]);
		mockClient.onShutdown = () => alive.delete(999);

		expect(
			manager.shutdownForSubscriptionProfileMigration({
				enumerateProcessTree: async (pid) => (pid === 999 ? [999, 250] : [pid]),
				terminateProcessTree: async (pid) => ({
					success: pid !== 250,
				}),
				isProcessAlive: (pid) => alive.has(pid),
				readHostPid: () => 999,
				sleep: async () => {},
				timeoutMs: 0,
			}),
		).rejects.toThrow("provider terminal process");
		expect(mockClient.shutdownCalls).toHaveLength(0);
	});

	it("defers migration when an unreachable host leaves a stale PID artifact", async () => {
		const manager = new ServiceTerminalManager();
		mockClient.connected = false;

		expect(
			manager.shutdownForSubscriptionProfileMigration({
				hostPidArtifactExists: () => true,
				readHostPid: () => 999,
				isProcessAlive: () => false,
			}),
		).rejects.toThrow("PID artifact");
		expect(mockClient.shutdownCalls).toHaveLength(0);
	});

	it("waits for service exit and labels killed sessions", async () => {
		const manager = new ServiceTerminalManager();
		const paneId = "pane-kill-1";
		const sessions = (
			manager as unknown as { sessions: Map<string, SessionInfo> }
		).sessions;
		sessions.set(paneId, {
			paneId,
			workspaceId: "ws-1",
			isAlive: true,
			lastActive: Date.now(),
			cwd: "",
			pid: 123,
			cols: 80,
			rows: 24,
		});

		let exitReason: string | undefined;
		manager.on(`exit:${paneId}`, (_exitCode, _signal, reason) => {
			exitReason = reason;
		});

		const killPromise = manager.kill({ paneId });
		await Promise.resolve();
		expect(exitReason).toBeUndefined();

		mockClient.emit("exit", paneId, 0, 15);
		await killPromise;
		expect(exitReason).toBe("killed");
		expect(mockClient.killCalls.length).toBe(1);
	});

	it("labels exit as killed even if session is missing", async () => {
		const manager = new ServiceTerminalManager();
		const paneId = "pane-kill-2";

		let exitReason: string | undefined;
		manager.on(`exit:${paneId}`, (_exitCode, _signal, reason) => {
			exitReason = reason;
		});

		await manager.kill({ paneId });
		mockClient.emit("exit", paneId, 0, 15);
		expect(exitReason).toBe("killed");
	});

	it("deletes retained history with the caller workspace when no session exists", async () => {
		const manager = new ServiceTerminalManager();
		const cleanupCalls: Array<[string, string]> = [];
		const operationOrder: string[] = [];
		mockClient.kill = async (params) => {
			operationOrder.push("kill");
			mockClient.killCalls.push(params);
		};
		const historyManager = (
			manager as unknown as {
				historyManager: {
					cleanupHistory: (
						paneId: string,
						workspaceId: string,
					) => Promise<void>;
				};
			}
		).historyManager;
		historyManager.cleanupHistory = async (paneId, workspaceId) => {
			operationOrder.push("cleanup");
			cleanupCalls.push([paneId, workspaceId]);
		};

		await manager.kill({
			paneId: "pane-retained-history",
			workspaceId: "workspace-retained-history",
			deleteHistory: true,
		});

		expect(cleanupCalls).toEqual([
			["pane-retained-history", "workspace-retained-history"],
		]);
		expect(operationOrder).toEqual(["kill", "cleanup"]);
	});

	it("does not resolve a retained-history kill until the writer is closed", async () => {
		const manager = new ServiceTerminalManager();
		let releaseClose: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const historyManager = (
			manager as unknown as {
				historyManager: {
					closeHistoryWriter: () => Promise<void>;
				};
			}
		).historyManager;
		historyManager.closeHistoryWriter = async () => closeGate;

		let killFinished = false;
		const kill = manager.kill({ paneId: "pane-close-barrier" }).then(() => {
			killFinished = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(killFinished).toBe(false);

		releaseClose?.();
		await kill;
		expect(killFinished).toBe(true);
	});

	it("blocks a late provider hook until permanent history deletion finishes", async () => {
		const manager = new ServiceTerminalManager();
		let releaseHook: (() => void) | undefined;
		const hookGate = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const historyManager = (
			manager as unknown as {
				historyManager: {
					updateAgentSessionFromHook: () => Promise<boolean>;
				};
			}
		).historyManager;
		historyManager.updateAgentSessionFromHook = async () => {
			await hookGate;
			return false;
		};

		const hook = manager.persistAgentSessionFromHook({
			paneId: "pane-late-hook",
			workspaceId: "workspace-late-hook",
			runtime: "codex",
			sessionId: "123e4567-e89b-12d3-a456-426614174000",
		});
		await Promise.resolve();

		let killFinished = false;
		const kill = manager
			.kill({
				paneId: "pane-late-hook",
				workspaceId: "workspace-late-hook",
				deleteHistory: true,
			})
			.then(() => {
				killFinished = true;
			});
		await Promise.resolve();
		await Promise.resolve();
		expect(killFinished).toBe(false);

		releaseHook?.();
		await Promise.all([hook, kill]);
		expect(killFinished).toBe(true);
	});

	it("does not reinitialize explicit scrollback clear after terminal exit", async () => {
		const manager = new ServiceTerminalManager();
		const paneId = "pane-explicit-clear-exit";
		const session = {
			paneId,
			workspaceId: "workspace-explicit-clear-exit",
			isAlive: true,
			lastActive: Date.now(),
			cwd: "C:\\repo",
			pid: 123,
			cols: 120,
			rows: 40,
			runtime: "codex" as const,
		};
		(manager as unknown as { sessions: Map<string, SessionInfo> }).sessions.set(
			paneId,
			session,
		);
		let releaseClose: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		let initCalls = 0;
		const historyManager = (
			manager as unknown as {
				historyManager: {
					getHistoryWriter: () => object;
					closeHistoryWriter: () => Promise<void>;
					initHistoryWriter: () => Promise<void>;
				};
			}
		).historyManager;
		historyManager.getHistoryWriter = () => ({});
		historyManager.closeHistoryWriter = async () => closeGate;
		historyManager.initHistoryWriter = async () => {
			initCalls++;
		};

		const clearing = manager.clearScrollback({ paneId });
		await Promise.resolve();
		session.isAlive = false;
		releaseClose?.();
		await clearing;

		expect(initCalls).toBe(0);
	});

	it("discards a host session created after its pane was permanently killed", async () => {
		const manager = new ServiceTerminalManager();
		let releaseCreate: (() => void) | undefined;
		mockClient.createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const paneId = "pane-killed-during-create";
		const workspaceId = "workspace-killed-during-create";
		const creation = manager
			.createOrAttach({
				paneId,
				tabId: "tab-killed-during-create",
				workspaceId,
				cwd: "C:\\repo",
				cols: 80,
				rows: 24,
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		while (mockClient.createCalls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		await manager.kill({ paneId, workspaceId, deleteHistory: true });
		expect(mockClient.killCalls).toHaveLength(1);
		releaseCreate?.();

		const result = await creation;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).name).toBe("TerminalKilledError");
		expect(mockClient.killCalls).toHaveLength(2);
		expect(manager.getSession(paneId)).toBeNull();
	});

	it("stops a pending workspace create without deleting data until commit", async () => {
		const manager = new ServiceTerminalManager();
		let releaseCreate: (() => void) | undefined;
		mockClient.createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const paneId = "pane-pending-workspace-delete";
		const workspaceId = "workspace-pending-delete";
		const creation = manager
			.createOrAttach({
				paneId,
				tabId: "tab-pending-workspace-delete",
				workspaceId,
				cwd: "C:\\repo",
				cols: 80,
				rows: 24,
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		while (mockClient.createCalls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const stopped = await manager.killByWorkspaceId(workspaceId, {
			deleteHistory: false,
		});
		expect(stopped).toEqual({ killed: 1, failed: 0 });
		expect(releasedProviderPanes).toEqual([]);
		expect(releasedProviderWorkspaces).toEqual([]);

		releaseCreate?.();
		const result = await creation;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).name).toBe("TerminalKilledError");

		const purged = await manager.killByWorkspaceId(workspaceId, {
			deleteHistory: true,
		});
		expect(purged).toEqual({ killed: 1, failed: 0 });
		expect(releasedProviderPanes).toContain(paneId);
		expect(releasedProviderWorkspaces).toEqual([workspaceId]);
	});

	it("defaults exit reason to exited when no kill tombstone exists", () => {
		const manager = new ServiceTerminalManager();
		const paneId = "pane-exit-1";

		let exitReason: string | undefined;
		manager.on(`exit:${paneId}`, (_exitCode, _signal, reason) => {
			exitReason = reason;
		});

		mockClient.emit("exit", paneId, 0, 15);
		expect(exitReason).toBe("exited");
	});

	it("uses carriage return when refreshing a Windows-compatible prompt", () => {
		const manager = new ServiceTerminalManager();
		const sessions = (
			manager as unknown as { sessions: Map<string, SessionInfo> }
		).sessions;
		sessions.set("pane-live", {
			paneId: "pane-live",
			workspaceId: "ws-1",
			isAlive: true,
			lastActive: Date.now(),
			cwd: "",
			pid: 123,
			cols: 80,
			rows: 24,
		});

		manager.refreshPromptsForWorkspace("ws-1");

		expect(mockClient.writeCalls).toEqual([
			{ sessionId: "pane-live", data: "\r" },
		]);
	});
});
