import type { Terminal } from "@xterm/xterm";
import { quote } from "shell-quote";

export const MAX_DROPPED_FILES = 32;
export const MAX_DROPPED_PATH_LENGTH = 4096;
export const MAX_DROPPED_PATHS_TOTAL_LENGTH = 32_768;

export function validateDroppedPaths(paths: string[]): string[] {
	if (paths.length === 0) return [];
	if (paths.length > MAX_DROPPED_FILES) {
		throw new Error(`Drop up to ${MAX_DROPPED_FILES} files at a time`);
	}

	let totalLength = 0;
	const validPaths = paths.map((path) => {
		if (!path || !path.trim())
			throw new Error("Dropped file has no usable path");
		if (
			Array.from(path).some((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
			})
		) {
			throw new Error("Dropped file path contains control characters");
		}
		if (path.length > MAX_DROPPED_PATH_LENGTH) {
			throw new Error("A dropped file path is too long");
		}
		totalLength += path.length;
		return path;
	});

	if (totalLength > MAX_DROPPED_PATHS_TOTAL_LENGTH) {
		throw new Error("The combined dropped paths are too large");
	}
	return validPaths;
}

export type DroppedPathShell = "powershell" | "posix";

export function shellEscapePaths(
	paths: string[],
	shell: DroppedPathShell = process.platform === "win32"
		? "powershell"
		: "posix",
): string {
	const validPaths = validateDroppedPaths(paths);
	if (shell === "powershell") {
		return validPaths
			.map((path) => `'${path.replaceAll("'", "''")}'`)
			.join(" ");
	}
	return quote(validPaths);
}

export function scrollToBottom(terminal: Terminal): void {
	terminal.scrollToBottom();
}
