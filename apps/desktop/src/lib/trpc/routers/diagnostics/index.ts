import { TRPCError } from "@trpc/server";
import type { HealthReport } from "main/lib/diagnostics/health";
import { publicProcedure, router } from "../..";

export type RecoveryConfirmationOperation =
	| "restore-app-state"
	| "reset-app-state";

export interface DiagnosticsRouterServices {
	runHealth: () => Promise<HealthReport>;
	exportDiagnostics: () => Promise<{
		canceled: boolean;
		path: string | null;
	}>;
	markRendererReady: () => Promise<unknown>;
	openDiagnosticsFolder: () => Promise<string>;
	confirmRecoveryOperation: (
		operation: RecoveryConfirmationOperation,
	) => Promise<boolean>;
	restoreLatestAppStateSnapshot: () => Promise<unknown>;
	resetAppStateWithBackup: () => Promise<unknown>;
	retryNormalMode: () => Promise<unknown>;
}

function createLazyDefaultServices(): DiagnosticsRouterServices {
	const runtime = () => import("./runtime");
	return {
		runHealth: async () => (await runtime()).runDefaultHealthChecks(),
		exportDiagnostics: async () => (await runtime()).exportDefaultDiagnostics(),
		markRendererReady: async () => (await runtime()).markDefaultRendererReady(),
		openDiagnosticsFolder: async () =>
			(await runtime()).openDefaultDiagnosticsFolder(),
		confirmRecoveryOperation: async (operation) =>
			(await runtime()).confirmDefaultRecoveryOperation(operation),
		restoreLatestAppStateSnapshot: async () =>
			(await runtime()).restoreDefaultLatestAppStateSnapshot(),
		resetAppStateWithBackup: async () =>
			(await runtime()).resetDefaultAppStateWithBackup(),
		retryNormalMode: async () => (await runtime()).retryDefaultNormalMode(),
	};
}

function internalError(message: string): TRPCError {
	return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}

export const createDiagnosticsRouter = (
	services: DiagnosticsRouterServices = createLazyDefaultServices(),
) =>
	router({
		run: publicProcedure.query(async () => {
			try {
				return await services.runHealth();
			} catch {
				throw internalError("Health checks could not be completed.");
			}
		}),

		export: publicProcedure.mutation(async () => {
			try {
				return await services.exportDiagnostics();
			} catch {
				throw internalError("Diagnostics export could not be written.");
			}
		}),

		markRendererReady: publicProcedure.mutation(async () => {
			try {
				return await services.markRendererReady();
			} catch {
				throw internalError("Renderer readiness could not be recorded.");
			}
		}),

		openFolder: publicProcedure.mutation(async () => {
			try {
				const error = await services.openDiagnosticsFolder();
				if (error) {
					throw internalError("The diagnostics folder could not be opened.");
				}
				return { success: true } as const;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw internalError("The diagnostics folder could not be opened.");
			}
		}),

		restoreLatestAppStateSnapshot: publicProcedure.mutation(async () => {
			try {
				if (!(await services.confirmRecoveryOperation("restore-app-state"))) {
					return { canceled: true } as const;
				}
				const result = await services.restoreLatestAppStateSnapshot();
				return { canceled: false, result } as const;
			} catch {
				throw internalError("The app-state snapshot could not be restored.");
			}
		}),

		resetAppStateWithBackup: publicProcedure.mutation(async () => {
			try {
				if (!(await services.confirmRecoveryOperation("reset-app-state"))) {
					return { canceled: true } as const;
				}
				const result = await services.resetAppStateWithBackup();
				return { canceled: false, result } as const;
			} catch {
				throw internalError("Application state could not be reset safely.");
			}
		}),

		retryNormalMode: publicProcedure.mutation(async () => {
			try {
				return await services.retryNormalMode();
			} catch {
				throw internalError("Normal startup could not be prepared.");
			}
		}),
	});
