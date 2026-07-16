import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createUpdateSnapshot } from "./update-snapshot";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ade-snapshot-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("createUpdateSnapshot", () => {
	test("uses the SQLite backup primitive and atomically snapshots in-memory app state", async () => {
		const recoveryDirectory = await temporaryDirectory();
		const destinations: string[] = [];
		const state = { tabsState: { tabs: [{ id: "tab-1" }] } };

		const snapshot = await createUpdateSnapshot({
			recoveryDirectory,
			backupDatabase: mock(async (destination) => {
				destinations.push(destination);
				await writeFile(destination, "sqlite-online-backup");
			}),
			getAppStateSnapshot: () => state,
			now: () => 1_721_091_723_000,
			createId: () => "snapshot-one",
		});

		expect(destinations).toHaveLength(1);
		expect(destinations[0]).toEndWith(".part");
		expect(destinations[0]).not.toBe(snapshot.databasePath);
		expect(await readFile(snapshot.databasePath, "utf8")).toBe(
			"sqlite-online-backup",
		);
		expect(JSON.parse(await readFile(snapshot.appStatePath, "utf8"))).toEqual(
			state,
		);
		expect(
			(await readdir(recoveryDirectory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("keeps exactly the two newest database and app-state snapshot pairs", async () => {
		const recoveryDirectory = await temporaryDirectory();
		let sequence = 0;
		const create = async () => {
			sequence += 1;
			return createUpdateSnapshot({
				recoveryDirectory,
				backupDatabase: async (destination) => {
					await writeFile(destination, `database-${sequence}`);
				},
				getAppStateSnapshot: () => ({ sequence }),
				now: () => sequence,
				createId: () => `snapshot-${sequence}`,
			});
		};

		const first = await create();
		const second = await create();
		const third = await create();
		const names = (await readdir(recoveryDirectory)).sort();

		expect(names).toHaveLength(4);
		expect(names).toContain(basename(second.databasePath));
		expect(names).toContain(basename(second.appStatePath));
		expect(names).toContain(basename(third.databasePath));
		expect(names).toContain(basename(third.appStatePath));
		expect(names).not.toContain(basename(first.databasePath));
		expect(names).not.toContain(basename(first.appStatePath));
	});

	test("cleans temporary files and preserves prior snapshots when backup fails", async () => {
		const recoveryDirectory = await temporaryDirectory();
		const first = await createUpdateSnapshot({
			recoveryDirectory,
			backupDatabase: async (destination) => {
				await writeFile(destination, "database-one");
			},
			getAppStateSnapshot: () => ({ sequence: 1 }),
			now: () => 1,
			createId: () => "snapshot-one",
		});

		await expect(
			createUpdateSnapshot({
				recoveryDirectory,
				backupDatabase: async (destination) => {
					await writeFile(destination, "partial-database");
					throw new Error("online backup failed");
				},
				getAppStateSnapshot: () => ({ sequence: 2 }),
				now: () => 2,
				createId: () => "snapshot-two",
			}),
		).rejects.toThrow("online backup failed");

		const names = (await readdir(recoveryDirectory)).sort();
		expect(names).toEqual(
			[basename(first.databasePath), basename(first.appStatePath)].sort(),
		);
	});

	test("does not rotate an old snapshot until both new files are promoted", async () => {
		const recoveryDirectory = await temporaryDirectory();
		for (let sequence = 1; sequence <= 2; sequence += 1) {
			await createUpdateSnapshot({
				recoveryDirectory,
				backupDatabase: async (destination) => {
					await writeFile(destination, `database-${sequence}`);
				},
				getAppStateSnapshot: () => ({ sequence }),
				now: () => sequence,
				createId: () => `snapshot-${sequence}`,
			});
		}
		const before = (await readdir(recoveryDirectory)).sort();

		await expect(
			createUpdateSnapshot({
				recoveryDirectory,
				backupDatabase: async () => {
					throw new Error("database unavailable");
				},
				getAppStateSnapshot: () => ({ sequence: 3 }),
				now: () => 3,
				createId: () => "snapshot-3",
			}),
		).rejects.toThrow("database unavailable");

		expect((await readdir(recoveryDirectory)).sort()).toEqual(before);
	});

	test("removes crash-leftover parts and incomplete pairs before enforcing the bound", async () => {
		const recoveryDirectory = await temporaryDirectory();
		const completePrefix = "update-0000000000000001-complete";
		await writeFile(
			join(recoveryDirectory, `${completePrefix}.local.db`),
			"db",
		);
		await writeFile(
			join(recoveryDirectory, `${completePrefix}.app-state.json`),
			"{}",
		);
		await writeFile(
			join(recoveryDirectory, "update-0000000000000002-orphan-db.local.db"),
			"db",
		);
		await writeFile(
			join(
				recoveryDirectory,
				"update-0000000000000003-orphan-state.app-state.json",
			),
			"{}",
		);
		await writeFile(
			join(recoveryDirectory, "update-crashed.local.db.part"),
			"partial",
		);

		const current = await createUpdateSnapshot({
			recoveryDirectory,
			backupDatabase: async (destination) => {
				await writeFile(destination, "current-db");
			},
			getAppStateSnapshot: () => ({ current: true }),
			now: () => 4,
			createId: () => "current",
		});

		expect((await readdir(recoveryDirectory)).sort()).toEqual(
			[
				`${completePrefix}.local.db`,
				`${completePrefix}.app-state.json`,
				basename(current.databasePath),
				basename(current.appStatePath),
			].sort(),
		);
	});
});
