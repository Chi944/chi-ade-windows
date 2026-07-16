import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CRASH_DUMP_PRUNE_INTERVAL_MS,
	inspectCrashDumpStorage,
	MAX_CRASH_DUMP_BYTES,
	MAX_CRASH_DUMP_COUNT,
	pruneCrashDumpStorage,
	scheduleCrashDumpPruning,
} from "./crash-storage";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("crash dump storage", () => {
	test("keeps the newest dumps within both count and byte limits", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		for (let index = 0; index < 5; index += 1) {
			const path = join(directory, `${index}.dmp`);
			writeFileSync(path, Buffer.alloc(4 * 1024 * 1024, index));
			utimesSync(path, index + 1, index + 1);
		}

		const inventory = pruneCrashDumpStorage(directory);

		expect(inventory.crashDumpCount).toBeLessThanOrEqual(MAX_CRASH_DUMP_COUNT);
		expect(inventory.crashDumpBytes).toBeLessThanOrEqual(MAX_CRASH_DUMP_BYTES);
		expect(inventory).toEqual(inspectCrashDumpStorage(directory));
	});

	test("enforces the byte limit even when the report count is below its cap", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		const older = join(directory, "older.dmp");
		const newer = join(directory, "newer.dmp");
		for (const [index, path] of [older, newer].entries()) {
			writeFileSync(path, "");
			truncateSync(path, 8 * 1024 * 1024);
			utimesSync(path, index + 1, index + 1);
		}

		expect(pruneCrashDumpStorage(directory)).toEqual({
			crashDumpCount: 1,
			crashDumpBytes: 8 * 1024 * 1024,
			invalidCrashDumpEntryCount: 0,
		});
		expect(existsSync(older)).toBe(false);
		expect(existsSync(newer)).toBe(true);
	});

	test("prunes only the oldest reports and preserves standard Crashpad metadata", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		const pending = join(directory, "pending");
		const completed = join(directory, "completed");
		const attachments = join(directory, "attachments");
		mkdirSync(pending, { recursive: true });
		mkdirSync(completed, { recursive: true });
		mkdirSync(attachments, { recursive: true });

		const metadata = new Map([
			[join(directory, "settings.dat"), "persistent settings"],
			[join(directory, "metadata"), "Windows database metadata"],
			[join(pending, "report.meta"), "report metadata"],
			[join(pending, "report.lock"), "report lock"],
			[join(attachments, "request.txt"), "attachment"],
			[join(completed, "unknown-record"), "unknown Crashpad metadata"],
		]);
		for (const [path, contents] of metadata) writeFileSync(path, contents);

		const dumps = [
			join(pending, "oldest.dmp"),
			join(pending, "newer.dmp"),
			join(completed, "newest.dmp"),
			join(completed, "latest.dmp"),
		];
		for (const [index, path] of dumps.entries()) {
			writeFileSync(path, "dump");
			utimesSync(path, index + 1, index + 1);
		}

		expect(inspectCrashDumpStorage(directory)).toEqual({
			crashDumpCount: 4,
			crashDumpBytes: 16,
			invalidCrashDumpEntryCount: 0,
		});

		expect(pruneCrashDumpStorage(directory)).toEqual({
			crashDumpCount: 3,
			crashDumpBytes: 12,
			invalidCrashDumpEntryCount: 0,
		});
		expect(existsSync(dumps[0])).toBe(false);
		for (const path of dumps.slice(1)) expect(existsSync(path)).toBe(true);
		for (const [path, contents] of metadata) {
			expect(readFileSync(path, "utf8")).toBe(contents);
		}
	});

	test("ignores a dump that vanishes between directory reading and metadata inspection", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		const vanished = join(directory, "vanished.dmp");
		writeFileSync(vanished, "dump");
		const missing = Object.assign(new Error("report moved"), {
			code: "ENOENT",
		});

		expect(
			inspectCrashDumpStorage(directory, {
				lstat(path) {
					if (path === vanished) throw missing;
					return lstatSync(path);
				},
				readDirectory(path) {
					return readdirSync(path, {
						withFileTypes: true,
						encoding: "utf8",
					});
				},
				unlink: unlinkSync,
			}),
		).toEqual({
			crashDumpCount: 0,
			crashDumpBytes: 0,
			invalidCrashDumpEntryCount: 0,
		});
	});

	test("tolerates a report being removed while pruning", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		const reports = Array.from({ length: 4 }, (_, index) => {
			const path = join(directory, `${index}.dmp`);
			writeFileSync(path, "dump");
			utimesSync(path, index + 1, index + 1);
			return path;
		});
		const oldest = reports[0];
		const missing = Object.assign(new Error("report moved"), {
			code: "ENOENT",
		});

		expect(
			pruneCrashDumpStorage(directory, {
				lstat: lstatSync,
				readDirectory(path) {
					return readdirSync(path, {
						withFileTypes: true,
						encoding: "utf8",
					});
				},
				unlink(path) {
					unlinkSync(path);
					if (path === oldest) throw missing;
				},
			}),
		).toEqual({
			crashDumpCount: 3,
			crashDumpBytes: 12,
			invalidCrashDumpEntryCount: 0,
		});
		expect(existsSync(oldest)).toBe(false);
	});

	test("matches report extensions with platform-appropriate casing", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		writeFileSync(join(directory, "uppercase.DMP"), "dump");

		const caseInsensitivePlatform =
			process.platform === "win32" || process.platform === "darwin";
		expect(inspectCrashDumpStorage(directory).crashDumpCount).toBe(
			caseInsensitivePlatform ? 1 : 0,
		);
	});

	test("inspects every report in known Crashpad directories beyond legacy traversal caps", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		for (const reportDirectory of ["reports", "new", "pending", "completed"]) {
			const path = join(directory, reportDirectory);
			mkdirSync(path);
			for (let index = 0; index < 130; index += 1) {
				writeFileSync(join(path, `${index}.dmp`), "d");
			}
		}

		expect(inspectCrashDumpStorage(directory)).toEqual({
			crashDumpCount: 520,
			crashDumpBytes: 520,
			invalidCrashDumpEntryCount: 0,
		});
	});

	test("does not traverse unknown or attachment directories", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		temporaryDirectories.push(directory);
		const hidden = join(directory, "attachments", "deep", "hidden.dmp");
		mkdirSync(join(directory, "pending"));
		mkdirSync(join(directory, "attachments", "deep"), { recursive: true });
		writeFileSync(join(directory, "root.dmp"), "root");
		writeFileSync(join(directory, "pending", "known.dmp"), "known");
		writeFileSync(hidden, "hidden");

		expect(inspectCrashDumpStorage(directory)).toEqual({
			crashDumpCount: 2,
			crashDumpBytes: 9,
			invalidCrashDumpEntryCount: 0,
		});
		pruneCrashDumpStorage(directory);
		expect(readFileSync(hidden, "utf8")).toBe("hidden");
	});

	test("schedules an unrefed fifteen-minute prune and contains callback failures", () => {
		let scheduled: (() => void) | undefined;
		const unref = mock(() => {});
		const scheduleInterval = mock(
			(callback: () => void, milliseconds: number) => {
				scheduled = callback;
				expect(milliseconds).toBe(15 * 60 * 1000);
				return { unref };
			},
		);
		const failure = new Error("prune failed");
		const prune = mock(() => {
			throw failure;
		});
		const onError = mock(() => {});

		scheduleCrashDumpPruning({ prune, onError, scheduleInterval });
		expect(CRASH_DUMP_PRUNE_INTERVAL_MS).toBe(15 * 60 * 1000);
		expect(scheduleInterval).toHaveBeenCalledTimes(1);
		expect(unref).toHaveBeenCalledTimes(1);
		scheduled?.();
		expect(prune).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
	});

	test("does not traverse a linked Crashpad directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "ade-crash-storage-"));
		const outside = mkdtempSync(join(tmpdir(), "ade-crash-outside-"));
		temporaryDirectories.push(directory, outside);
		writeFileSync(join(outside, "outside.dmp"), "outside");
		symlinkSync(
			outside,
			join(directory, "pending"),
			process.platform === "win32" ? "junction" : "dir",
		);

		expect(inspectCrashDumpStorage(directory)).toEqual({
			crashDumpCount: 0,
			crashDumpBytes: 0,
			invalidCrashDumpEntryCount: 1,
		});
		pruneCrashDumpStorage(directory);
		expect(inspectCrashDumpStorage(outside).crashDumpCount).toBe(1);
	});
});
