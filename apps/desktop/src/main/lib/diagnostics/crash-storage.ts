import {
	type Dirent,
	lstatSync,
	readdirSync,
	type Stats,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

export const MAX_CRASH_DUMP_COUNT = 3;
export const MAX_CRASH_DUMP_BYTES = 15 * 1024 * 1024;
export const CRASH_DUMP_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const CRASHPAD_REPORT_DIRECTORIES = new Set([
	"reports",
	"new",
	"pending",
	"completed",
]);

export interface CrashDumpStorage {
	crashDumpCount: number;
	crashDumpBytes: number;
	invalidCrashDumpEntryCount: number;
}

interface CrashDumpEntry {
	path: string;
	size: number;
	modifiedAt: number;
}

export interface CrashStorageOperations {
	lstat(path: string): Stats;
	readDirectory(path: string): Dirent<string>[];
	unlink(path: string): void;
}

export interface CrashDumpPruneInterval {
	unref(): void;
}

export interface ScheduleCrashDumpPruningOptions {
	prune: () => void;
	onError: (error: unknown) => void;
	scheduleInterval?: (
		callback: () => void,
		milliseconds: number,
	) => CrashDumpPruneInterval;
}

const nodeCrashStorageOperations: CrashStorageOperations = {
	lstat: lstatSync,
	readDirectory(path) {
		return readdirSync(path, { withFileTypes: true, encoding: "utf8" });
	},
	unlink: unlinkSync,
};

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isCrashDumpFileName(name: string): boolean {
	if (process.platform === "win32" || process.platform === "darwin") {
		return name.toLowerCase().endsWith(".dmp");
	}
	return name.endsWith(".dmp");
}

function isCrashpadReportDirectory(name: string): boolean {
	const comparable =
		process.platform === "win32" || process.platform === "darwin"
			? name.toLowerCase()
			: name;
	return CRASHPAD_REPORT_DIRECTORIES.has(comparable);
}

function readCrashDumpEntries(
	directory: string,
	operations: CrashStorageOperations,
): {
	files: CrashDumpEntry[];
	invalidCrashDumpEntryCount: number;
} {
	const files: CrashDumpEntry[] = [];
	let invalidCrashDumpEntryCount = 0;
	try {
		const root = operations.lstat(directory);
		if (root.isSymbolicLink() || !root.isDirectory()) {
			return { files, invalidCrashDumpEntryCount: 1 };
		}
	} catch (error) {
		if (isMissing(error)) return { files, invalidCrashDumpEntryCount: 0 };
		throw error;
	}
	const visit = (
		currentDirectory: string,
		discoverReportDirectories: boolean,
	): void => {
		let entries: Dirent<string>[];
		try {
			entries = operations.readDirectory(currentDirectory);
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(currentDirectory, entry.name);
			let metadata: Stats;
			try {
				metadata = operations.lstat(path);
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
				invalidCrashDumpEntryCount += 1;
				continue;
			}
			if (entry.isDirectory() && metadata.isDirectory()) {
				if (
					discoverReportDirectories &&
					isCrashpadReportDirectory(entry.name)
				) {
					visit(path, false);
				}
				continue;
			}
			if (!entry.isFile() || !metadata.isFile()) {
				invalidCrashDumpEntryCount += 1;
				continue;
			}
			if (!isCrashDumpFileName(entry.name)) continue;
			files.push({ path, size: metadata.size, modifiedAt: metadata.mtimeMs });
		}
	};
	visit(directory, true);
	return { files, invalidCrashDumpEntryCount };
}

export function scheduleCrashDumpPruning(
	options: ScheduleCrashDumpPruningOptions,
): CrashDumpPruneInterval {
	const scheduleInterval =
		options.scheduleInterval ??
		((callback: () => void, milliseconds: number) =>
			setInterval(callback, milliseconds));
	const interval = scheduleInterval(() => {
		try {
			options.prune();
		} catch (error) {
			options.onError(error);
		}
	}, CRASH_DUMP_PRUNE_INTERVAL_MS);
	interval.unref();
	return interval;
}

export function inspectCrashDumpStorage(
	directory: string,
	operations: CrashStorageOperations = nodeCrashStorageOperations,
): CrashDumpStorage {
	const { files, invalidCrashDumpEntryCount } = readCrashDumpEntries(
		directory,
		operations,
	);
	return {
		crashDumpCount: files.length,
		crashDumpBytes: files.reduce((total, file) => total + file.size, 0),
		invalidCrashDumpEntryCount,
	};
}

export function pruneCrashDumpStorage(
	directory: string,
	operations: CrashStorageOperations = nodeCrashStorageOperations,
): CrashDumpStorage {
	const { files } = readCrashDumpEntries(directory, operations);
	let retainedCount = 0;
	let retainedBytes = 0;
	for (const file of files.sort(
		(left, right) => right.modifiedAt - left.modifiedAt,
	)) {
		if (
			retainedCount < MAX_CRASH_DUMP_COUNT &&
			retainedBytes + file.size <= MAX_CRASH_DUMP_BYTES
		) {
			retainedCount += 1;
			retainedBytes += file.size;
			continue;
		}
		try {
			const current = operations.lstat(file.path);
			if (!current.isSymbolicLink() && current.isFile()) {
				operations.unlink(file.path);
			}
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	return inspectCrashDumpStorage(directory, operations);
}
