import { describe, expect, it } from "bun:test";
import type { HealthReport } from "main/lib/diagnostics/health";
import { createDiagnosticsRouter, type DiagnosticsRouterServices } from ".";

const report: HealthReport = {
	generatedAt: "2026-07-16T00:00:00.000Z",
	summary: { pass: 1, warning: 0, fail: 0 },
	checks: [
		{
			id: "sync-root",
			group: "storage",
			label: "ADE data folder",
			status: "pass",
			message: "The folder is writable.",
		},
	],
};

function services(
	overrides: Partial<DiagnosticsRouterServices> = {},
): DiagnosticsRouterServices {
	return {
		runHealth: async () => report,
		exportDiagnostics: async () => ({
			canceled: false,
			path: "C:\\exports\\ade-diagnostics.json",
		}),
		markRendererReady: async () => ({
			safeMode: false,
			incompleteStarts: 0,
			phase: "ready" as const,
		}),
		openDiagnosticsFolder: async () => "",
		confirmRecoveryOperation: async () => true,
		restoreLatestAppStateSnapshot: async () => ({ restored: true }),
		resetAppStateWithBackup: async () => ({ reset: true }),
		retryNormalMode: async () => ({
			safeMode: false,
			incompleteStarts: 0,
			phase: "starting" as const,
		}),
		...overrides,
	};
}

describe("diagnostics router", () => {
	it("runs health checks and marks the renderer ready", async () => {
		let readyCalls = 0;
		const caller = createDiagnosticsRouter(
			services({
				markRendererReady: async () => {
					readyCalls += 1;
					return { safeMode: false, incompleteStarts: 0, phase: "ready" };
				},
			}),
		).createCaller({});

		expect(await caller.run()).toEqual(report);
		expect(await caller.markRendererReady()).toEqual({
			safeMode: false,
			incompleteStarts: 0,
			phase: "ready",
		});
		expect(readyCalls).toBe(1);
	});

	it("preserves export cancellation and hides write failure details", async () => {
		const canceledCaller = createDiagnosticsRouter(
			services({
				exportDiagnostics: async () => ({ canceled: true, path: null }),
			}),
		).createCaller({});
		expect(await canceledCaller.export()).toEqual({
			canceled: true,
			path: null,
		});

		const failedCaller = createDiagnosticsRouter(
			services({
				exportDiagnostics: async () => {
					throw new Error(
						"C:\\Users\\secret\\report.json could not write token=private",
					);
				},
			}),
		).createCaller({});
		await expect(failedCaller.export()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Diagnostics export could not be written.",
		});
	});

	it("treats a non-empty shell.openPath result as a failure without leaking it", async () => {
		const caller = createDiagnosticsRouter(
			services({
				openDiagnosticsFolder: async () =>
					"Access denied: C:\\Users\\secret\\diagnostics",
			}),
		).createCaller({});

		await expect(caller.openFolder()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "The diagnostics folder could not be opened.",
		});
	});

	it("requires native confirmation before restoring an app-state snapshot", async () => {
		let restores = 0;
		const operations: string[] = [];
		const canceled = createDiagnosticsRouter(
			services({
				confirmRecoveryOperation: async (operation) => {
					operations.push(operation);
					return false;
				},
				restoreLatestAppStateSnapshot: async () => {
					restores += 1;
					return { restored: true };
				},
			}),
		).createCaller({});

		expect(await canceled.restoreLatestAppStateSnapshot()).toEqual({
			canceled: true,
		});
		expect(restores).toBe(0);
		expect(operations).toEqual(["restore-app-state"]);

		const confirmed = createDiagnosticsRouter(
			services({
				restoreLatestAppStateSnapshot: async () => {
					restores += 1;
					return { restored: true };
				},
			}),
		).createCaller({});
		expect(await confirmed.restoreLatestAppStateSnapshot()).toEqual({
			canceled: false,
			result: { restored: true },
		});
		expect(restores).toBe(1);
	});

	it("requires a separate native confirmation before reset with backup", async () => {
		let resets = 0;
		const caller = createDiagnosticsRouter(
			services({
				confirmRecoveryOperation: async (operation) =>
					operation === "reset-app-state",
				resetAppStateWithBackup: async () => {
					resets += 1;
					return { reset: true };
				},
			}),
		).createCaller({});

		expect(await caller.resetAppStateWithBackup()).toEqual({
			canceled: false,
			result: { reset: true },
		});
		expect(resets).toBe(1);
	});

	it("retries normal mode explicitly without a destructive confirmation", async () => {
		let retryCalls = 0;
		let confirmationCalls = 0;
		const caller = createDiagnosticsRouter(
			services({
				confirmRecoveryOperation: async () => {
					confirmationCalls += 1;
					return true;
				},
				retryNormalMode: async () => {
					retryCalls += 1;
					return {
						safeMode: false,
						incompleteStarts: 0,
						phase: "starting",
					};
				},
			}),
		).createCaller({});

		expect(await caller.retryNormalMode()).toEqual({
			safeMode: false,
			incompleteStarts: 0,
			phase: "starting",
		});
		expect(retryCalls).toBe(1);
		expect(confirmationCalls).toBe(0);
	});
});
