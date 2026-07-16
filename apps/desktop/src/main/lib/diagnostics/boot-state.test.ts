import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOOT_FAILURE_WINDOW_MS,
	createBootStateController,
	getStartupCapabilities,
} from "./boot-state";

const temporaryDirectories: string[] = [];

async function temporaryBootPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ade-boot-state-"));
	temporaryDirectories.push(directory);
	return join(directory, "boot-state.json");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("boot-state lifecycle", () => {
	test("marks a first launch as starting without claiming a failure", async () => {
		const filePath = await temporaryBootPath();
		const controller = createBootStateController({
			filePath,
			now: () => 1_000,
		});

		const status = await controller.markStarting();

		expect(status).toEqual({
			phase: "starting",
			safeMode: false,
			incompleteStarts: 0,
			recoveredCorruptState: false,
		});
		expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
			schemaVersion: 1,
			phase: "starting",
			startedAt: 1_000,
			incompleteStartedAt: [],
		});
	});

	test("enters safe mode on the third launch after two incomplete starts", async () => {
		const filePath = await temporaryBootPath();
		let now = 10_000;
		const launch = async () => {
			const controller = createBootStateController({
				filePath,
				now: () => now,
			});
			const status = await controller.markStarting();
			now += 1_000;
			return { controller, status };
		};

		expect((await launch()).status.incompleteStarts).toBe(0);
		expect((await launch()).status).toMatchObject({
			incompleteStarts: 1,
			safeMode: false,
		});
		const thirdAttempt = await launch();
		expect(thirdAttempt.status).toMatchObject({
			incompleteStarts: 2,
			safeMode: true,
		});

		const ready = await thirdAttempt.controller.markRendererReady();
		expect(ready).toMatchObject({
			phase: "ready",
			incompleteStarts: 0,
			// Clearing persisted failures must not start optional services mid-run.
			safeMode: true,
		});

		const nextLaunch = await launch();
		expect(nextLaunch.status).toMatchObject({
			incompleteStarts: 0,
			safeMode: false,
		});
	});

	test("drops stale or future-dated failures outside the rolling window", async () => {
		const filePath = await temporaryBootPath();
		const now = 2_000_000;
		await writeFile(
			filePath,
			JSON.stringify({
				schemaVersion: 1,
				phase: "starting",
				startedAt: now - BOOT_FAILURE_WINDOW_MS - 1,
				incompleteStartedAt: [now - BOOT_FAILURE_WINDOW_MS - 2, now + 1],
			}),
		);

		const status = await createBootStateController({
			filePath,
			now: () => now,
		}).markStarting();

		expect(status).toMatchObject({ incompleteStarts: 0, safeMode: false });
	});

	test("a ready launch clears the failure history", async () => {
		const filePath = await temporaryBootPath();
		let now = 1_000;
		let controller = createBootStateController({ filePath, now: () => now });
		await controller.markStarting();
		now += 1_000;
		controller = createBootStateController({ filePath, now: () => now });
		expect((await controller.markStarting()).incompleteStarts).toBe(1);
		await controller.markRendererReady();
		now += 1_000;

		const afterReady = await createBootStateController({
			filePath,
			now: () => now,
		}).markStarting();
		expect(afterReady).toMatchObject({ incompleteStarts: 0, safeMode: false });
	});

	test("recovers a corrupted marker without inventing crash evidence", async () => {
		const filePath = await temporaryBootPath();
		await writeFile(filePath, "{not-json", "utf8");

		const status = await createBootStateController({
			filePath,
			now: () => 5_000,
		}).markStarting();

		expect(status).toEqual({
			phase: "starting",
			safeMode: false,
			incompleteStarts: 0,
			recoveredCorruptState: true,
		});
		expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
			phase: "starting",
			startedAt: 5_000,
		});
	});

	test("normal retry clears persisted failures but keeps this runtime safe", async () => {
		const filePath = await temporaryBootPath();
		await writeFile(
			filePath,
			JSON.stringify({
				schemaVersion: 1,
				phase: "starting",
				startedAt: 4_000,
				incompleteStartedAt: [1_000, 2_000],
			}),
		);
		const controller = createBootStateController({
			filePath,
			now: () => 5_000,
		});
		expect((await controller.markStarting()).safeMode).toBe(true);

		const retry = await controller.prepareNormalModeRetry();
		expect(retry).toMatchObject({
			phase: "ready",
			incompleteStarts: 0,
			safeMode: true,
		});
	});
});

describe("safe startup capabilities", () => {
	test("suppresses every optional service in safe recovery mode", () => {
		expect(getStartupCapabilities(true)).toEqual({
			appStateWatcher: false,
			autoUpdater: false,
			tray: false,
			terminalRestore: false,
			terminalPrewarm: false,
			sshTunnels: false,
			agentHooks: false,
			agentWatchers: false,
			notifications: false,
		});
		expect(Object.values(getStartupCapabilities(false))).toEqual(
			Array(9).fill(true),
		);
	});
});
