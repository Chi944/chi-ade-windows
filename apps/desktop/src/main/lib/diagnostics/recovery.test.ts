import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryManager } from "./recovery";

const temporaryDirectories: string[] = [];

async function temporaryRecoveryRoot(): Promise<string> {
	const directory = await mkdtemp(
		join(await realpath(tmpdir()), "ade-recovery-"),
	);
	temporaryDirectories.push(directory);
	return directory;
}

async function createDirectoryLink(
	target: string,
	path: string,
): Promise<void> {
	await mkdir(target, { recursive: true });
	await mkdir(join(path, ".."), { recursive: true });
	await symlink(
		target,
		path,
		process.platform === "win32" ? "junction" : "dir",
	);
}

async function createBackupOutputLink(
	target: string,
	path: string,
): Promise<void> {
	if (process.platform === "win32") {
		await mkdir(target, { recursive: true });
		await symlink(target, path, "junction");
		return;
	}
	await writeFile(target, "outside database", "utf8");
	await symlink(target, path, "file");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function createHarness(
	recoveryRoot: string,
	options: { databaseExists?: boolean } = {},
) {
	let state: unknown = { marker: "initial" };
	let revision = 0;
	let now = 1_000;
	let sequence = 0;
	const order: string[] = [];
	const replaceAppState = mock(
		async (replacement: unknown, expectedRevision: number) => {
			if (revision !== expectedRevision) return "stale" as const;
			order.push("replace");
			state = structuredClone(replacement);
			revision += 1;
			return "committed" as const;
		},
	);
	const validateSerializedAppState = mock((raw: string) => {
		order.push("validate");
		return JSON.parse(raw) as unknown;
	});
	const backupDatabase = mock(async (destination: string) => {
		order.push("backup");
		await writeFile(destination, `database-${now}`, "utf8");
	});
	const manager = createRecoveryManager({
		recoveryRoot,
		getAppStateSnapshot: () => structuredClone(state),
		getAppStateRevision: () => revision,
		validateSerializedAppState,
		replaceAppStateAtRevision: replaceAppState,
		createDefaultAppState: () => ({ marker: "default" }),
		backupDatabase,
		databaseExists: async () => options.databaseExists ?? true,
		now: () => now,
		createId: () => `id-${++sequence}`,
	});
	return {
		manager,
		order,
		backupDatabase,
		replaceAppState,
		validateSerializedAppState,
		getState: () => structuredClone(state),
		setState: (next: unknown) => {
			state = structuredClone(next);
			revision += 1;
		},
		advance: () => {
			now += 1_000;
		},
	};
}

describe("local recovery snapshots", () => {
	test("writes private atomic state and online database snapshots", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);

		const result = await harness.manager.createSnapshot("manual");

		expect(result.appStatePath).toStartWith(join(recoveryRoot, "app-state"));
		expect(result.databasePath).toStartWith(join(recoveryRoot, "database"));
		expect(JSON.parse(await readFile(result.appStatePath, "utf8"))).toEqual({
			marker: "initial",
		});
		expect(await readFile(result.databasePath as string, "utf8")).toBe(
			"database-1000",
		);
		expect(
			(await readdir(join(recoveryRoot, "app-state"))).some((name) =>
				name.endsWith(".part"),
			),
		).toBe(false);
		expect(
			(await readdir(join(recoveryRoot, "database"))).some((name) =>
				name.endsWith(".part"),
			),
		).toBe(false);
	});

	test("retries app-state capture when its revision changes during sampling", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		let state: unknown = { marker: "before-concurrent-mutation" };
		let revision = 0;
		let snapshotReads = 0;
		const manager = createRecoveryManager({
			recoveryRoot,
			getAppStateRevision: () => revision,
			getAppStateSnapshot: () => {
				const snapshot = structuredClone(state);
				if (snapshotReads === 0) {
					state = { marker: "after-concurrent-mutation" };
					revision += 1;
				}
				snapshotReads += 1;
				return snapshot;
			},
			validateSerializedAppState: JSON.parse,
			replaceAppStateAtRevision: async () => "committed",
			createDefaultAppState: () => ({}),
			backupDatabase: async (destination) => {
				await writeFile(destination, "database", "utf8");
			},
			databaseExists: async () => true,
			now: () => 1_000,
			createId: () => "revision-retry",
		});

		const snapshot = await manager.createSnapshot("manual");

		expect(snapshotReads).toBe(2);
		expect(JSON.parse(await readFile(snapshot.appStatePath, "utf8"))).toEqual({
			marker: "after-concurrent-mutation",
		});
	});

	test("keeps three app-state snapshots and two database snapshots", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);

		for (let index = 0; index < 5; index += 1) {
			harness.setState({ marker: index });
			await harness.manager.createSnapshot("manual");
			harness.advance();
		}

		const stateFiles = await readdir(join(recoveryRoot, "app-state"));
		const databaseFiles = await readdir(join(recoveryRoot, "database"));
		expect(stateFiles).toHaveLength(3);
		expect(databaseFiles).toHaveLength(2);
		expect(
			await Promise.all(
				stateFiles
					.sort()
					.map(async (name) =>
						JSON.parse(
							await readFile(join(recoveryRoot, "app-state", name), "utf8"),
						),
					),
			),
		).toEqual([{ marker: 2 }, { marker: 3 }, { marker: 4 }]);
	});

	test("skips database backup when no database exists", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot, { databaseExists: false });

		const result = await harness.manager.createSnapshot("manual");

		expect(result.databasePath).toBeUndefined();
		expect(harness.backupDatabase).not.toHaveBeenCalled();
		expect(await readdir(join(recoveryRoot, "app-state"))).toHaveLength(1);
	});

	test("cleans partial data and preserves completed snapshots on backup failure", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);
		await harness.manager.createSnapshot("manual");
		const beforeState = await readdir(join(recoveryRoot, "app-state"));
		const beforeDatabase = await readdir(join(recoveryRoot, "database"));
		harness.backupDatabase.mockImplementationOnce(async (destination) => {
			await writeFile(destination, "partial", "utf8");
			throw new Error("backup failed");
		});

		await expect(harness.manager.createSnapshot("manual")).rejects.toThrow(
			"backup failed",
		);
		expect(await readdir(join(recoveryRoot, "app-state"))).toEqual(beforeState);
		expect(await readdir(join(recoveryRoot, "database"))).toEqual(
			beforeDatabase,
		);
	});

	test("rejects a linked database backup result before fsync or promotion", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const outside = join(recoveryRoot, "outside-backup-target");
		if (process.platform === "win32") {
			await mkdir(outside, { recursive: true });
		} else {
			await writeFile(outside, "outside database", "utf8");
			await chmod(outside, 0o644);
		}
		const harness = createHarness(recoveryRoot);
		harness.backupDatabase.mockImplementationOnce(async (destination) => {
			await createBackupOutputLink(outside, destination);
		});
		const outsideModeBefore =
			process.platform === "win32" ? -1 : (await stat(outside)).mode;

		await expect(harness.manager.createSnapshot("manual")).rejects.toThrow(
			/symbolic link|junction|regular file/i,
		);
		expect(
			(await readdir(join(recoveryRoot, "database"))).some((name) =>
				name.endsWith(".part"),
			),
		).toBe(false);
		if (process.platform === "win32") {
			expect(await readdir(outside)).toEqual([]);
		} else {
			expect(await readFile(outside, "utf8")).toBe("outside database");
			expect((await stat(outside)).mode).toBe(outsideModeBefore);
		}
	});

	test("ignores and removes interrupted part files before snapshotting", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		await mkdir(join(recoveryRoot, "app-state"), { recursive: true });
		await mkdir(join(recoveryRoot, "database"), { recursive: true });
		await writeFile(join(recoveryRoot, "app-state", "crashed.part"), "x");
		await writeFile(join(recoveryRoot, "database", "crashed.part"), "x");
		const harness = createHarness(recoveryRoot);

		await harness.manager.createSnapshot("manual");

		expect(await readdir(join(recoveryRoot, "app-state"))).toHaveLength(1);
		expect(await readdir(join(recoveryRoot, "database"))).toHaveLength(1);
	});

	test("rejects linked retained snapshots before starting a new backup", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const appStateDirectory = join(recoveryRoot, "app-state");
		await mkdir(appStateDirectory, { recursive: true });
		await mkdir(join(recoveryRoot, "database"), { recursive: true });
		await createDirectoryLink(
			join(recoveryRoot, "outside-retained-snapshot"),
			join(
				appStateDirectory,
				"recovery-0000000000001000-manual-id.app-state.json",
			),
		);
		const harness = createHarness(recoveryRoot);

		await expect(harness.manager.createSnapshot("manual")).rejects.toThrow(
			/symbolic link|regular file/i,
		);
		expect(harness.backupDatabase).not.toHaveBeenCalled();
	});
});

describe("recovery operations", () => {
	test("restore and reset preserve a concurrent app-state mutation while the safety backup is pending", async () => {
		for (const operation of ["restore", "reset"] as const) {
			const recoveryRoot = await temporaryRecoveryRoot();
			let state: unknown = { marker: "restore-source" };
			let revision = 0;
			let sequence = 0;
			let shouldBlockBackup = false;
			let signalBackupStarted: (() => void) | undefined;
			let releaseBackup: (() => void) | undefined;
			const backupStarted = new Promise<void>((resolve) => {
				signalBackupStarted = resolve;
			});
			const backupPending = new Promise<void>((resolve) => {
				releaseBackup = resolve;
			});
			const replaceAppStateAtRevision = mock(
				async (replacement: unknown, expectedRevision: number) => {
					if (revision !== expectedRevision) return "stale" as const;
					state = structuredClone(replacement);
					revision += 1;
					return "committed" as const;
				},
			);
			const manager = createRecoveryManager({
				recoveryRoot,
				getAppStateSnapshot: () => structuredClone(state),
				getAppStateRevision: () => revision,
				validateSerializedAppState: JSON.parse,
				replaceAppStateAtRevision,
				createDefaultAppState: () => ({ marker: "default" }),
				backupDatabase: async (destination) => {
					await writeFile(destination, `database-${operation}`, "utf8");
					if (shouldBlockBackup) {
						signalBackupStarted?.();
						await backupPending;
					}
				},
				databaseExists: async () => true,
				now: () => 1_000,
				createId: () => `id-${++sequence}`,
			});

			if (operation === "restore") {
				await manager.createSnapshot("manual");
				state = { marker: "current" };
				revision += 1;
			}

			const stateBeforeRecovery = structuredClone(state);
			shouldBlockBackup = true;
			const recovery =
				operation === "restore"
					? manager.restoreLatestAppStateSnapshot()
					: manager.resetAppStateWithBackup();
			await backupStarted;
			state = { marker: `concurrent-${operation}` };
			revision += 1;
			releaseBackup?.();

			await expect(recovery).rejects.toThrow(
				/app state changed while the recovery backup was being created/i,
			);
			expect(state).toEqual({ marker: `concurrent-${operation}` });
			expect(replaceAppStateAtRevision).toHaveBeenCalledTimes(1);

			const stateNames = await readdir(join(recoveryRoot, "app-state"));
			const safetyName = stateNames.find((name) =>
				name.includes(`before-${operation}`),
			);
			expect(safetyName).toBeDefined();
			expect(
				JSON.parse(
					await readFile(
						join(recoveryRoot, "app-state", safetyName as string),
						"utf8",
					),
				),
			).toEqual(stateBeforeRecovery);
			expect(stateNames.some((name) => name.endsWith(".part"))).toBe(false);
			expect(
				(await readdir(join(recoveryRoot, "database"))).some((name) =>
					name.endsWith(".part"),
				),
			).toBe(false);
		}
	});

	test("restores the latest validated snapshot through the serialized coordinator after backing up current state", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);
		harness.setState({ marker: "restore-me" });
		await harness.manager.createSnapshot("manual");
		harness.advance();
		harness.setState({ marker: "current" });
		harness.order.length = 0;

		const result = await harness.manager.restoreLatestAppStateSnapshot();

		expect(result.restored).toBe(true);
		expect(harness.getState()).toEqual({ marker: "restore-me" });
		expect(harness.order.indexOf("backup")).toBeLessThan(
			harness.order.indexOf("replace"),
		);
		expect(harness.validateSerializedAppState).toHaveBeenCalledTimes(1);
		expect(harness.replaceAppState).toHaveBeenCalledTimes(1);
	});

	test("refuses an invalid latest snapshot before changing live state", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);
		const snapshot = await harness.manager.createSnapshot("manual");
		await writeFile(snapshot.appStatePath, "{invalid", "utf8");
		harness.validateSerializedAppState.mockImplementationOnce(() => {
			throw new Error("invalid app state");
		});
		harness.order.length = 0;

		await expect(
			harness.manager.restoreLatestAppStateSnapshot(),
		).rejects.toThrow("invalid app state");
		expect(harness.replaceAppState).not.toHaveBeenCalled();
		expect(harness.order).not.toContain("backup");
	});

	test("rejects a linked app-state directory before reading a snapshot", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const outside = join(recoveryRoot, "outside-app-state");
		await createDirectoryLink(outside, join(recoveryRoot, "app-state"));
		await writeFile(
			join(outside, "recovery-0000000000001000-manual-id.app-state.json"),
			'{"marker":"outside"}',
			"utf8",
		);
		const harness = createHarness(recoveryRoot);

		await expect(
			harness.manager.restoreLatestAppStateSnapshot(),
		).rejects.toThrow(/symbolic link|safe/i);
		expect(harness.validateSerializedAppState).not.toHaveBeenCalled();
		expect(harness.replaceAppState).not.toHaveBeenCalled();
	});

	test("rejects a linked snapshot entry before reading it", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const appStateDirectory = join(recoveryRoot, "app-state");
		await mkdir(appStateDirectory, { recursive: true });
		await mkdir(join(recoveryRoot, "database"), { recursive: true });
		await createDirectoryLink(
			join(recoveryRoot, "outside-snapshot"),
			join(
				appStateDirectory,
				"recovery-0000000000001000-manual-id.app-state.json",
			),
		);
		const harness = createHarness(recoveryRoot);

		await expect(
			harness.manager.restoreLatestAppStateSnapshot(),
		).rejects.toThrow(/symbolic link|regular file/i);
		expect(harness.validateSerializedAppState).not.toHaveBeenCalled();
	});

	test("resets through the coordinator only after a complete backup", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);

		const result = await harness.manager.resetAppStateWithBackup();

		expect(result.reset).toBe(true);
		expect(harness.getState()).toEqual({ marker: "default" });
		expect(harness.order.indexOf("backup")).toBeLessThan(
			harness.order.indexOf("replace"),
		);
	});

	test("reports bounded recovery inventory without exposing state contents", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		const harness = createHarness(recoveryRoot);
		await harness.manager.createSnapshot("manual");

		expect(await harness.manager.getStatus()).toEqual({
			hasAppStateSnapshot: true,
			appStateSnapshotCount: 1,
			databaseSnapshotCount: 1,
		});
	});

	test("rejects linked recovery directories while reading status", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		await mkdir(join(recoveryRoot, "app-state"), { recursive: true });
		const outside = join(recoveryRoot, "outside-database");
		await createDirectoryLink(outside, join(recoveryRoot, "database"));
		await writeFile(
			join(outside, "recovery-0000000000001000-manual-id.local.db"),
			"outside",
			"utf8",
		);
		const harness = createHarness(recoveryRoot);

		await expect(harness.manager.getStatus()).rejects.toThrow(
			/symbolic link|safe/i,
		);
	});
});

describe("recovery operation serialization", () => {
	test("serializes snapshot writers so cleanup cannot remove an in-flight part", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		let releaseFirst: (() => void) | undefined;
		let signalFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			signalFirstStarted = resolve;
		});
		const firstPending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let backupCalls = 0;
		const backupDatabase = mock(async (destination: string) => {
			backupCalls += 1;
			await writeFile(destination, `database-${backupCalls}`, "utf8");
			if (backupCalls === 1) {
				signalFirstStarted?.();
				await firstPending;
			}
		});
		let id = 0;
		const manager = createRecoveryManager({
			recoveryRoot,
			getAppStateSnapshot: () => ({ id }),
			getAppStateRevision: () => 0,
			validateSerializedAppState: JSON.parse,
			replaceAppStateAtRevision: async () => "committed",
			createDefaultAppState: () => ({}),
			backupDatabase,
			databaseExists: async () => true,
			now: () => 1_000,
			createId: () => `id-${++id}`,
		});

		const first = manager.createSnapshot("manual");
		await firstStarted;
		const second = manager.createSnapshot("manual");
		await Promise.resolve();
		const callsBeforeRelease = backupCalls;
		const operationsStartedBeforeRelease = id;
		releaseFirst?.();
		const outcomes = await Promise.allSettled([first, second]);

		expect(callsBeforeRelease).toBe(1);
		expect(operationsStartedBeforeRelease).toBe(1);
		expect(outcomes.map(({ status }) => status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		expect(
			(await readdir(join(recoveryRoot, "app-state"))).some((name) =>
				name.endsWith(".part"),
			),
		).toBe(false);
		expect(
			(await readdir(join(recoveryRoot, "database"))).some((name) =>
				name.endsWith(".part"),
			),
		).toBe(false);
	});

	test("does not replace app state while an earlier snapshot is still active", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		let releaseFirst: (() => void) | undefined;
		let signalFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			signalFirstStarted = resolve;
		});
		const firstPending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let backupCalls = 0;
		let id = 0;
		const order: string[] = [];
		const replaceAppState = mock(async () => {
			order.push("replace");
			return "committed" as const;
		});
		const manager = createRecoveryManager({
			recoveryRoot,
			getAppStateSnapshot: () => ({ current: true }),
			getAppStateRevision: () => 0,
			validateSerializedAppState: JSON.parse,
			replaceAppStateAtRevision: replaceAppState,
			createDefaultAppState: () => ({ default: true }),
			backupDatabase: async (destination) => {
				backupCalls += 1;
				order.push(`backup-${backupCalls}-start`);
				await writeFile(destination, "database", "utf8");
				if (backupCalls === 1) {
					signalFirstStarted?.();
					await firstPending;
				}
				order.push(`backup-${backupCalls}-end`);
			},
			databaseExists: async () => true,
			now: () => 1_000,
			createId: () => `id-${++id}`,
		});

		const snapshot = manager.createSnapshot("manual");
		await firstStarted;
		const reset = manager.resetAppStateWithBackup();
		await Promise.resolve();
		const orderBeforeRelease = [...order];
		const operationsStartedBeforeRelease = id;
		releaseFirst?.();
		await Promise.allSettled([snapshot, reset]);

		expect(orderBeforeRelease).toEqual(["backup-1-start"]);
		expect(operationsStartedBeforeRelease).toBe(1);
		expect(order).toEqual([
			"backup-1-start",
			"backup-1-end",
			"backup-2-start",
			"backup-2-end",
			"replace",
		]);
		expect(replaceAppState).toHaveBeenCalledTimes(1);
	});

	test("continues the FIFO after a failed operation", async () => {
		const recoveryRoot = await temporaryRecoveryRoot();
		let backupCalls = 0;
		const replaceAppState = mock(async () => "committed" as const);
		const manager = createRecoveryManager({
			recoveryRoot,
			getAppStateSnapshot: () => ({ current: true }),
			getAppStateRevision: () => 0,
			validateSerializedAppState: JSON.parse,
			replaceAppStateAtRevision: replaceAppState,
			createDefaultAppState: () => ({ default: true }),
			backupDatabase: async (destination) => {
				backupCalls += 1;
				if (backupCalls === 1) throw new Error("first backup failed");
				await writeFile(destination, "database", "utf8");
			},
			databaseExists: async () => true,
			now: () => 1_000,
			createId: (() => {
				let id = 0;
				return () => `id-${++id}`;
			})(),
		});

		const failed = manager.createSnapshot("manual");
		const continued = manager.resetAppStateWithBackup();

		await expect(failed).rejects.toThrow("first backup failed");
		await expect(continued).resolves.toEqual({ reset: true });
		expect(backupCalls).toBe(2);
		expect(replaceAppState).toHaveBeenCalledTimes(1);
	});
});
