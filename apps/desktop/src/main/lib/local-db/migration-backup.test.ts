import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeMigrationFingerprint,
	prepareMigrationBackup,
	runMigrationsWithBackup,
} from "./migration-backup";

const temporaryDirectories: string[] = [];

function createDirectoryLink(target: string, path: string): void {
	mkdirSync(target, { recursive: true });
	mkdirSync(join(path, ".."), { recursive: true });
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function replaceWithPathLink(path: string, target: string): void {
	rmSync(path, { recursive: true, force: true });
	if (process.platform === "win32") {
		mkdirSync(target, { recursive: true });
		symlinkSync(target, path, "junction");
		return;
	}
	writeFileSync(target, "outside");
	symlinkSync(target, path, "file");
}

function createFixture() {
	const root = mkdtempSync(
		join(realpathSync.native(tmpdir()), "ade-migration-backup-"),
	);
	temporaryDirectories.push(root);
	const migrationsFolder = join(root, "migrations");
	const recoveryDirectory = join(root, "private", "recovery", "database");
	const markerPath = join(
		root,
		"private",
		"recovery",
		"migration-fingerprint.json",
	);
	mkdirSync(join(migrationsFolder, "meta"), {
		recursive: true,
	});
	writeFileSync(join(migrationsFolder, "0000_first.sql"), "create table a;\n");
	writeFileSync(
		join(migrationsFolder, "meta", "_journal.json"),
		'{"entries":[{"tag":"0000_first"}]}\n',
	);
	let now = 1_000;
	let id = 0;
	const backupDatabase = mock(async (destination: string) => {
		writeFileSync(destination, `backup-${now}`);
	});
	const run = (databaseExists: boolean) =>
		prepareMigrationBackup({
			databaseExists,
			migrationsFolder,
			recoveryDirectory,
			markerPath,
			backupDatabase,
			now: () => now,
			createId: () => `id-${++id}`,
		});
	return {
		root,
		migrationsFolder,
		recoveryDirectory,
		markerPath,
		backupDatabase,
		run,
		advance: () => {
			now += 1_000;
		},
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("migration fingerprint", () => {
	test("is deterministic and changes only when applied migration inputs change", () => {
		const fixture = createFixture();
		const first = computeMigrationFingerprint(fixture.migrationsFolder);
		const second = computeMigrationFingerprint(fixture.migrationsFolder);
		expect(second).toBe(first);

		writeFileSync(
			join(fixture.migrationsFolder, "meta", "ignored_snapshot.json"),
			"changed",
		);
		expect(computeMigrationFingerprint(fixture.migrationsFolder)).toBe(first);

		writeFileSync(
			join(fixture.migrationsFolder, "0000_first.sql"),
			"create table changed;\n",
		);
		expect(computeMigrationFingerprint(fixture.migrationsFolder)).not.toBe(
			first,
		);
	});

	test("rejects a linked migrations directory", () => {
		const fixture = createFixture();
		const realMigrations = join(fixture.root, "real-migrations");
		rmSync(fixture.migrationsFolder, { recursive: true, force: true });
		mkdirSync(join(realMigrations, "meta"), { recursive: true });
		writeFileSync(join(realMigrations, "0000_first.sql"), "select 1;\n");
		writeFileSync(
			join(realMigrations, "meta", "_journal.json"),
			'{"entries":[{"tag":"0000_first"}]}\n',
		);
		createDirectoryLink(realMigrations, fixture.migrationsFolder);

		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/symbolic link|junction/i,
		);
	});

	test("rejects a linked ancestor before reading migration inputs", () => {
		const fixture = createFixture();
		const canonicalBoundary = join(fixture.root, "canonical-boundary");
		const linkedBoundary = join(fixture.root, "linked-boundary");
		mkdirSync(canonicalBoundary);
		renameSync(fixture.migrationsFolder, join(canonicalBoundary, "migrations"));
		createDirectoryLink(canonicalBoundary, linkedBoundary);

		expect(() =>
			computeMigrationFingerprint(join(linkedBoundary, "migrations")),
		).toThrow(/symbolic link|junction/i);
	});

	test("rejects linked migration SQL input", () => {
		const fixture = createFixture();
		replaceWithPathLink(
			join(fixture.migrationsFolder, "0000_first.sql"),
			join(fixture.root, "outside-migration-input"),
		);

		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/symbolic link|junction|regular file/i,
		);
	});

	test("rejects a linked migration metadata directory", () => {
		const fixture = createFixture();
		const outsideMeta = join(fixture.root, "outside-meta");
		rmSync(join(fixture.migrationsFolder, "meta"), {
			recursive: true,
			force: true,
		});
		mkdirSync(outsideMeta, { recursive: true });
		writeFileSync(
			join(outsideMeta, "_journal.json"),
			'{"entries":[{"tag":"0000_first"}]}\n',
		);
		createDirectoryLink(outsideMeta, join(fixture.migrationsFolder, "meta"));

		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/symbolic link|junction/i,
		);
	});

	test("rejects a linked migration journal", () => {
		const fixture = createFixture();
		replaceWithPathLink(
			join(fixture.migrationsFolder, "meta", "_journal.json"),
			join(fixture.root, "outside-journal"),
		);

		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/symbolic link|junction|regular file/i,
		);
	});

	test("rejects malformed migration journals and unsafe migration tags", () => {
		const fixture = createFixture();
		const journalPath = join(fixture.migrationsFolder, "meta", "_journal.json");
		writeFileSync(journalPath, "not-json\n");
		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/migration journal/i,
		);

		writeFileSync(journalPath, '{"entries":[{"tag":"../outside"}]}\n');
		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/migration tag/i,
		);
	});

	test("rejects a nonregular migration referenced by the journal", () => {
		const fixture = createFixture();
		const migrationPath = join(fixture.migrationsFolder, "0000_first.sql");
		rmSync(migrationPath, { force: true });
		mkdirSync(migrationPath);

		expect(() => computeMigrationFingerprint(fixture.migrationsFolder)).toThrow(
			/regular file/i,
		);
	});
});

describe("prepareMigrationBackup", () => {
	test("creates exactly one backup for each new migration fingerprint", async () => {
		const fixture = createFixture();

		expect((await fixture.run(true)).status).toBe("backed-up");
		expect((await fixture.run(true)).status).toBe("already-backed-up");
		expect(fixture.backupDatabase).toHaveBeenCalledTimes(1);

		fixture.advance();
		writeFileSync(
			join(fixture.migrationsFolder, "0001_second.sql"),
			"alter table a add column b text;\n",
		);
		expect((await fixture.run(true)).status).toBe("backed-up");
		expect((await fixture.run(true)).status).toBe("already-backed-up");
		expect(fixture.backupDatabase).toHaveBeenCalledTimes(2);
	});

	test("does not back up an absent database and records it only after migration succeeds", async () => {
		const fixture = createFixture();

		const prepared = await fixture.run(false);
		expect(prepared.status).toBe("database-absent");
		expect(fixture.backupDatabase).not.toHaveBeenCalled();
		expect(() => readFileSync(fixture.markerPath)).toThrow();

		prepared.markMigrationComplete();
		expect((await fixture.run(true)).status).toBe("already-backed-up");
		expect(fixture.backupDatabase).not.toHaveBeenCalled();
	});

	test("keeps only the two newest database recovery snapshots", async () => {
		const fixture = createFixture();
		for (let index = 0; index < 4; index += 1) {
			expect((await fixture.run(true)).status).toBe("backed-up");
			fixture.advance();
			writeFileSync(
				join(fixture.migrationsFolder, `000${index + 1}_next.sql`),
				`select ${index};\n`,
			);
		}
		const files = readdirSync(fixture.recoveryDirectory).filter(
			(name: string) => name.endsWith(".local.db"),
		);
		expect(files).toHaveLength(2);
	});

	test("does not advance the fingerprint or delete a valid backup when backup fails", async () => {
		const fixture = createFixture();
		expect((await fixture.run(true)).status).toBe("backed-up");
		const markerBefore = readFileSync(fixture.markerPath, "utf8");
		const filesBefore = readdirSync(fixture.recoveryDirectory);
		fixture.advance();
		writeFileSync(join(fixture.migrationsFolder, "0001_new.sql"), "select 1;");
		fixture.backupDatabase.mockImplementationOnce(async (destination) => {
			writeFileSync(destination, "partial");
			throw new Error("snapshot failed");
		});

		await expect(fixture.run(true)).rejects.toThrow("snapshot failed");
		expect(readFileSync(fixture.markerPath, "utf8")).toBe(markerBefore);
		expect(readdirSync(fixture.recoveryDirectory)).toEqual(filesBefore);
	});

	test("does not begin migration until the asynchronous online backup finishes", async () => {
		const order: string[] = [];
		let releaseBackup: (() => void) | undefined;
		const backupPending = new Promise<void>((resolve) => {
			releaseBackup = resolve;
		});
		const operation = runMigrationsWithBackup({
			prepareBackup: async () => {
				order.push("backup-started");
				await backupPending;
				order.push("backup-finished");
				return {
					status: "backed-up" as const,
					fingerprint: "a".repeat(64),
					markMigrationComplete: () => order.push("marked"),
				};
			},
			migrate: () => order.push("migrate"),
		});
		await Promise.resolve();
		expect(order).toEqual(["backup-started"]);

		releaseBackup?.();
		await operation;
		expect(order).toEqual([
			"backup-started",
			"backup-finished",
			"migrate",
			"marked",
		]);
	});

	test("rejects a linked recovery directory before invoking the database backup", async () => {
		const fixture = createFixture();
		const outside = join(fixture.root, "outside-recovery");
		createDirectoryLink(outside, fixture.recoveryDirectory);

		await expect(fixture.run(true)).rejects.toThrow(/symbolic link|safe/i);
		expect(fixture.backupDatabase).not.toHaveBeenCalled();
		expect(readdirSync(outside)).toEqual([]);
	});

	test("rejects a linked marker target before invoking the database backup", async () => {
		const fixture = createFixture();
		const outside = join(fixture.root, "outside-marker");
		createDirectoryLink(outside, fixture.markerPath);

		await expect(fixture.run(true)).rejects.toThrow(
			/symbolic link|regular file/i,
		);
		expect(fixture.backupDatabase).not.toHaveBeenCalled();
		expect(readdirSync(outside)).toEqual([]);
	});

	test("rejects a pre-existing linked snapshot destination before backup", async () => {
		const fixture = createFixture();
		mkdirSync(fixture.recoveryDirectory, { recursive: true });
		const fingerprint = computeMigrationFingerprint(fixture.migrationsFolder);
		const destination = join(
			fixture.recoveryDirectory,
			`recovery-${String(1_000).padStart(16, "0")}-migration-${fingerprint.slice(0, 12)}-id-1.local.db`,
		);
		const outside = join(fixture.root, "outside-destination");
		createDirectoryLink(outside, destination);

		await expect(fixture.run(true)).rejects.toThrow(/symbolic link|exists/i);
		expect(fixture.backupDatabase).not.toHaveBeenCalled();
		expect(readdirSync(outside)).toEqual([]);
	});

	test("rejects linked retained snapshots before backup or marker changes", async () => {
		const fixture = createFixture();
		mkdirSync(fixture.recoveryDirectory, { recursive: true });
		const outside = join(fixture.root, "outside-retained-snapshot");
		createDirectoryLink(
			outside,
			join(
				fixture.recoveryDirectory,
				"recovery-0000000000000001-malicious.local.db",
			),
		);

		await expect(fixture.run(true)).rejects.toThrow(
			/symbolic link|regular file/i,
		);
		expect(fixture.backupDatabase).not.toHaveBeenCalled();
		expect(() => readFileSync(fixture.markerPath)).toThrow();
		expect(readdirSync(outside)).toEqual([]);
	});

	test("rejects a backup result that is not a regular non-link file", async () => {
		const fixture = createFixture();
		const outside = join(fixture.root, "outside-backup-result");
		mkdirSync(outside, { recursive: true });
		fixture.backupDatabase.mockImplementationOnce(async (destination) => {
			createDirectoryLink(outside, destination);
		});
		const outsideModeBefore =
			process.platform === "win32" ? -1 : statSync(outside).mode;

		await expect(fixture.run(true)).rejects.toThrow(
			/symbolic link|regular file/i,
		);
		expect(() => readFileSync(fixture.markerPath)).toThrow();
		expect(readdirSync(outside)).toEqual([]);
		if (process.platform !== "win32") {
			expect(statSync(outside).mode).toBe(outsideModeBefore);
		}
	});
});
