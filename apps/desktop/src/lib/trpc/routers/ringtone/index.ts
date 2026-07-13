import { TRPCError } from "@trpc/server";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import { dialog } from "electron";
import {
	getCustomRingtoneInfo,
	getCustomRingtonePath,
	importCustomRingtoneFromPath,
} from "main/lib/custom-ringtones";
import { getSoundPath } from "main/lib/sound-paths";
import {
	type SoundPlaybackHandle,
	startSoundPlayback,
} from "main/lib/sound-player";
import {
	CUSTOM_RINGTONE_ID,
	getRingtoneFilename,
	isBuiltInRingtoneId,
} from "shared/ringtones";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Track current playing session to handle race conditions.
 * Each play operation gets a unique session ID. When stop is called,
 * the session is invalidated so any pending fallback processes won't start.
 */
let currentSession: {
	id: number;
	playback: SoundPlaybackHandle;
} | null = null;
let nextSessionId = 0;

/**
 * Stops the currently playing sound and invalidates the session
 */
function stopCurrentSound(): void {
	if (currentSession) {
		currentSession.playback.stop();
		currentSession = null;
	}
}

/**
 * Plays a sound file using platform-specific commands.
 * Uses session tracking to prevent race conditions with fallback audio players.
 */
async function playSoundFile(soundPath: string): Promise<void> {
	// Stop any currently playing sound first
	stopCurrentSound();

	// Create a new session for this play operation
	const sessionId = nextSessionId++;
	const playback = startSoundPlayback(soundPath, {
		onComplete: () => {
			if (currentSession?.id === sessionId) currentSession = null;
		},
		onError: () => {
			if (currentSession?.id === sessionId) currentSession = null;
		},
	});
	currentSession = { id: sessionId, playback };

	// Windows resolves only after WPF has decoded the file, so a broken or
	// unsupported selection is reported to the renderer instead of appearing to
	// play successfully. Other platforms resolve when their native player spawns.
	await playback.started;
}

function getRingtoneSoundPath(ringtoneId: string): string | null {
	if (!ringtoneId || ringtoneId === "") {
		return null;
	}

	if (ringtoneId === CUSTOM_RINGTONE_ID) {
		return getCustomRingtonePath();
	}

	if (!isBuiltInRingtoneId(ringtoneId)) {
		return null;
	}

	const filename = getRingtoneFilename(ringtoneId);
	if (!filename) {
		return null;
	}

	return getSoundPath(filename);
}

/**
 * Ringtone router for audio preview and playback operations
 */
export const createRingtoneRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		/**
		 * Preview a ringtone by ringtone ID.
		 */
		preview: publicProcedure
			.input(z.object({ ringtoneId: z.string() }))
			.mutation(async ({ input }) => {
				const soundPath = getRingtoneSoundPath(input.ringtoneId);
				if (!soundPath) {
					return { success: true as const };
				}

				try {
					await playSoundFile(soundPath);
				} catch (error) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to play notification sound",
						cause: error,
					});
				}
				return { success: true as const };
			}),

		/**
		 * Stop the currently playing ringtone preview
		 */
		stop: publicProcedure.mutation(() => {
			stopCurrentSound();
			return { success: true as const };
		}),

		/**
		 * Returns metadata for the imported custom ringtone, if one exists.
		 */
		getCustom: publicProcedure.query(() => {
			return getCustomRingtoneInfo();
		}),

		/**
		 * Imports a custom ringtone file from disk and stores it in the Superset home assets directory.
		 */
		importCustom: publicProcedure.mutation(async () => {
			const window = getWindow();
			const openDialogOptions: OpenDialogOptions = {
				properties: ["openFile"],
				title: "Select Notification Sound",
				filters: [
					{
						name: "Audio",
						extensions: ["mp3", "wav"],
					},
				],
			};
			const result = window
				? await dialog.showOpenDialog(window, openDialogOptions)
				: await dialog.showOpenDialog(openDialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { canceled: true as const, ringtone: null };
			}

			try {
				const ringtone = await importCustomRingtoneFromPath(
					result.filePaths[0],
				);
				return { canceled: false as const, ringtone };
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Failed to import custom ringtone",
				});
			}
		}),
	});
};

/**
 * Plays the notification sound based on the selected ringtone.
 * This is used by the notification system.
 */
export async function playNotificationRingtone(
	ringtoneId: string,
): Promise<void> {
	const soundPath = getRingtoneSoundPath(ringtoneId);
	if (!soundPath) {
		return;
	}

	await playSoundFile(soundPath);
}
