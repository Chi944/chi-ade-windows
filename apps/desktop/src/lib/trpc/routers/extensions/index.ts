import { mkdirSync } from "node:fs";
import { shell } from "electron";
import {
	getExtensionsDirectory,
	scanExtensions,
} from "main/lib/extensions/registry";
import { publicProcedure, router } from "../..";

export const createExtensionsRouter = () =>
	router({
		list: publicProcedure.query(() => ({
			directory: getExtensionsDirectory(),
			entries: scanExtensions(),
		})),
		openDirectory: publicProcedure.mutation(async () => {
			const directory = getExtensionsDirectory();
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const error = await shell.openPath(directory);
			return { success: !error, error: error || undefined, directory };
		}),
	});
