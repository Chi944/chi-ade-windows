import { observable } from "@trpc/server/observable";
import {
	type AutoUpdateStatusEvent,
	autoUpdateEmitter,
	checkForUpdates,
	dismissUpdate,
	downloadUpdate,
	getUpdateStatus,
	installUpdate,
	simulateDownloading,
	simulateError,
	simulateUpdateAvailable,
	simulateUpdateReady,
} from "main/lib/auto-updater";
import { publicProcedure, router } from "../..";

export const createAutoUpdateRouter = () => {
	return router({
		subscribe: publicProcedure.subscription(() => {
			return observable<AutoUpdateStatusEvent>((emit) => {
				emit.next(getUpdateStatus());

				const onStatusChanged = (event: AutoUpdateStatusEvent) => {
					emit.next(event);
				};

				autoUpdateEmitter.on("status-changed", onStatusChanged);

				return () => {
					autoUpdateEmitter.off("status-changed", onStatusChanged);
				};
			});
		}),

		getStatus: publicProcedure.query(() => {
			return getUpdateStatus();
		}),

		check: publicProcedure.mutation(() => {
			checkForUpdates();
		}),

		download: publicProcedure.mutation(async () => {
			await downloadUpdate();
		}),

		install: publicProcedure.mutation(async () => {
			await installUpdate();
		}),

		dismiss: publicProcedure.mutation(() => {
			dismissUpdate();
		}),

		simulateReady: publicProcedure.mutation(() => {
			simulateUpdateReady();
		}),

		simulateAvailable: publicProcedure.mutation(() => {
			simulateUpdateAvailable();
		}),

		simulateDownloading: publicProcedure.mutation(() => {
			simulateDownloading();
		}),

		simulateError: publicProcedure.mutation(() => {
			simulateError();
		}),
	});
};
