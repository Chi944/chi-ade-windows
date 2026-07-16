import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalizePackagedSmokeTempDirectory,
	createPackagedSmokeController,
	getPackagedSmokeWindowQuery,
	PACKAGED_SMOKE_INTERNAL_TIMEOUT_MS,
	PACKAGED_SMOKE_OUTPUT_NAME,
	PACKAGED_SMOKE_TOKEN_PATTERN,
	type PackagedSmokeChecks,
	parsePackagedSmokeCommand,
	readPackagedSmokeStartup,
	scrubPackagedSmokeEnvironment,
} from "./packaged-smoke";

const TOKEN = "ab".repeat(32);
const SENDER = { senderId: 42, isMainFrame: true } as const;

interface StartupFixture {
	root: string;
	home: string;
	environment: Record<string, string>;
	cleanup: () => void;
}

function createStartupFixture(launch: 1 | 2 = 1): StartupFixture {
	const root = mkdtempSync(join(tmpdir(), "ade-packaged-gui-"));
	const home = join(root, "ade-home");
	mkdirSync(home, { mode: 0o700 });
	return {
		root,
		home,
		environment: {
			NODE_ENV: "production",
			ADE_PACKAGED_SMOKE: "1",
			ADE_PACKAGED_SMOKE_TOKEN: TOKEN,
			ADE_PACKAGED_SMOKE_LAUNCH: String(launch),
			ADE_PACKAGED_SMOKE_ROOT: root,
			ADE_PACKAGED_SMOKE_OUTPUT: join(home, PACKAGED_SMOKE_OUTPUT_NAME),
			ADE_HOME_DIR: home,
			ADE_DISABLE_PROTOCOL_REGISTRATION: "1",
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function passingChecks(): PackagedSmokeChecks {
	return {
		rendererReady: true,
		bootErrorFree: true,
		stateHydrated: true,
		sixPanesCreated: true,
		seventhPaneRejected: true,
		claudeAccountMarker: true,
		codexAccountMarker: true,
		healthQueryCompleted: true,
		updateAssetSelected: true,
		statePersisted: true,
	};
}

function requireStartup(fixture: StartupFixture) {
	const startup = readPackagedSmokeStartup(fixture.environment, {
		isPackaged: true,
	});
	if (!startup) throw new Error("Expected a valid packaged smoke fixture");
	return startup;
}

describe("packaged smoke startup contract", () => {
	test("accepts only a packaged production launch with a canonical isolated home and 32-byte token", () => {
		const fixture = createStartupFixture();
		try {
			const startup = requireStartup(fixture);
			expect(startup).toEqual({
				home: fixture.home,
				root: fixture.root,
				launch: 1,
				outputPath: join(fixture.home, PACKAGED_SMOKE_OUTPUT_NAME),
				token: TOKEN,
			});
			expect(PACKAGED_SMOKE_TOKEN_PATTERN.test(TOKEN)).toBeTrue();
			expect(getPackagedSmokeWindowQuery(startup)).toEqual({
				adePackagedSmoke: "1",
				adePackagedSmokeLaunch: "1",
				adePackagedSmokeToken: TOKEN,
			});
		} finally {
			fixture.cleanup();
		}
	});

	test("canonicalizes the operating-system temp directory before validating roots", () => {
		expect(
			canonicalizePackagedSmokeTempDirectory(
				"/var/folders/runner/T",
				() => "/private/var/folders/runner/T",
			),
		).toBe("/private/var/folders/runner/T");
	});

	test("rejects a smoke-shaped root that is not a direct child of the OS temp directory", () => {
		const parent = mkdtempSync(join(tmpdir(), "ade-packaged-smoke-parent-"));
		const root = mkdtempSync(join(parent, "ade-packaged-gui-"));
		const home = join(root, "ade-home");
		const validFixture = createStartupFixture();
		mkdirSync(home, { mode: 0o700 });
		try {
			const environment = {
				...validFixture.environment,
				ADE_PACKAGED_SMOKE_ROOT: root,
				ADE_HOME_DIR: home,
				ADE_PACKAGED_SMOKE_OUTPUT: join(home, PACKAGED_SMOKE_OUTPUT_NAME),
			};
			expect(
				readPackagedSmokeStartup(environment, { isPackaged: true }),
			).toBeNull();
		} finally {
			validFixture.cleanup();
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("rejects development/default-app, CDP opt-in, malformed token, and mismatched startup fields", () => {
		const fixture = createStartupFixture();
		try {
			const base = fixture.environment;
			const invalid: Array<{
				environment: Record<string, string | undefined>;
				isPackaged?: boolean;
			}> = [
				{ environment: base, isPackaged: false },
				{ environment: { ...base, NODE_ENV: "development" } },
				{
					environment: { ...base, ADE_ENABLE_DESKTOP_AUTOMATION: "1" },
				},
				{ environment: { ...base, ADE_PACKAGED_SMOKE: "0" } },
				{ environment: { ...base, ADE_PACKAGED_SMOKE_TOKEN: "guessable" } },
				{ environment: { ...base, ADE_PACKAGED_SMOKE_TOKEN: "A".repeat(64) } },
				{ environment: { ...base, ADE_PACKAGED_SMOKE_LAUNCH: "3" } },
				{ environment: { ...base, ADE_HOME_DIR: fixture.root } },
				{
					environment: {
						...base,
						ADE_PACKAGED_SMOKE_OUTPUT: join(fixture.home, "other.json"),
					},
				},
				{
					environment: { ...base, ADE_DISABLE_PROTOCOL_REGISTRATION: "0" },
				},
			];

			for (const candidate of invalid) {
				expect(
					readPackagedSmokeStartup(candidate.environment, {
						isPackaged: candidate.isPackaged ?? true,
					}),
				).toBeNull();
			}
		} finally {
			fixture.cleanup();
		}
	});

	test("rejects a pre-existing output artifact", () => {
		const fixture = createStartupFixture();
		try {
			writeFileSync(
				join(fixture.home, PACKAGED_SMOKE_OUTPUT_NAME),
				"stale result",
			);
			expect(
				readPackagedSmokeStartup(fixture.environment, { isPackaged: true }),
			).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	test("rejects a broken symlink at the fixed output path", () => {
		const fixture = createStartupFixture();
		try {
			const target = join(fixture.home, "missing-target");
			if (process.platform === "win32") mkdirSync(target);
			symlinkSync(
				target,
				join(fixture.home, PACKAGED_SMOKE_OUTPUT_NAME),
				process.platform === "win32" ? "junction" : "file",
			);
			if (process.platform === "win32") {
				rmSync(target, { recursive: true, force: true });
			}
			expect(
				readPackagedSmokeStartup(fixture.environment, { isPackaged: true }),
			).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	test("scrubs only smoke credentials while preserving normal packaged opt-ins", () => {
		const environment: NodeJS.ProcessEnv = {
			ADE_PACKAGED_SMOKE: "1",
			ADE_PACKAGED_SMOKE_TOKEN: TOKEN,
			ADE_PACKAGED_SMOKE_LAUNCH: "1",
			ADE_PACKAGED_SMOKE_ROOT: "root",
			ADE_PACKAGED_SMOKE_OUTPUT: "output",
			ADE_DISABLE_PROTOCOL_REGISTRATION: "1",
			ADE_ENABLE_DESKTOP_AUTOMATION: "1",
			ELECTRON_RUN_AS_NODE: "1",
			NODE_OPTIONS: "--inspect",
			ADE_HOME_DIR: "home",
		};
		scrubPackagedSmokeEnvironment(environment);
		expect(environment).toEqual({
			ADE_DISABLE_PROTOCOL_REGISTRATION: "1",
			ADE_ENABLE_DESKTOP_AUTOMATION: "1",
			ELECTRON_RUN_AS_NODE: "1",
			NODE_OPTIONS: "--inspect",
			ADE_HOME_DIR: "home",
		});
	});
});

describe("packaged smoke one-shot command protocol", () => {
	test("allows only strict begin and complete commands", () => {
		expect(
			parsePackagedSmokeCommand({ command: "begin", launch: 1, token: TOKEN }),
		).toEqual({ command: "begin", launch: 1, token: TOKEN });
		expect(() =>
			parsePackagedSmokeCommand({
				command: "eval",
				launch: 1,
				token: TOKEN,
				source: "process.exit()",
			}),
		).toThrow();
		expect(() =>
			parsePackagedSmokeCommand({
				command: "begin",
				launch: 1,
				token: "A".repeat(64),
			}),
		).toThrow("Expected a 32-byte lowercase hex token");
		expect(() =>
			parsePackagedSmokeCommand({
				command: "begin",
				launch: 1,
				token: TOKEN,
				path: "C:\\secret",
			}),
		).toThrow();
	});

	test("binds begin to the expected main-frame webContents and accepts it once", async () => {
		const fixture = createStartupFixture();
		try {
			const controller = createPackagedSmokeController({
				startup: requireStartup(fixture),
				platform: "win32",
				arch: "x64",
				authorizedSenderId: SENDER.senderId,
				writeResult: async () => {},
				scheduleExit: () => {},
			});
			await expect(
				controller.handle(
					{ command: "begin", launch: 1, token: TOKEN },
					SENDER,
				),
			).resolves.toEqual({ platform: "win32", arch: "x64" });
			for (const caller of [
				{ senderId: 99, isMainFrame: true },
				{ senderId: 42, isMainFrame: false },
			]) {
				const foreign = createPackagedSmokeController({
					startup: requireStartup(fixture),
					authorizedSenderId: SENDER.senderId,
					writeResult: async () => {},
					scheduleExit: () => {},
				});
				await expect(
					foreign.handle({ command: "begin", launch: 1, token: TOKEN }, caller),
				).rejects.toThrow("Unauthorized packaged smoke command");
			}
			await expect(
				controller.handle(
					{ command: "begin", launch: 1, token: TOKEN },
					SENDER,
				),
			).rejects.toThrow("already begun");
		} finally {
			fixture.cleanup();
		}
	});

	test("rejects completion before begin or with a different token/launch", async () => {
		const fixture = createStartupFixture();
		try {
			for (const command of [
				{
					command: "complete" as const,
					launch: 1 as const,
					token: TOKEN,
					checks: passingChecks(),
				},
				{
					command: "begin" as const,
					launch: 1 as const,
					token: "cd".repeat(32),
				},
			]) {
				const controller = createPackagedSmokeController({
					startup: requireStartup(fixture),
					authorizedSenderId: SENDER.senderId,
					writeResult: async () => {},
					scheduleExit: () => {},
				});
				await expect(controller.handle(command, SENDER)).rejects.toThrow();
			}
		} finally {
			fixture.cleanup();
		}
	});

	test("writes a fixed-schema result and schedules a clean zero exit exactly once", async () => {
		const fixture = createStartupFixture();
		try {
			const exits: number[] = [];
			const startup = requireStartup(fixture);
			const controller = createPackagedSmokeController({
				startup,
				platform: process.platform,
				arch: process.arch,
				authorizedSenderId: SENDER.senderId,
				scheduleExit: (code) => exits.push(code),
				now: () => new Date("2026-07-16T01:02:03.000Z"),
			});
			await controller.handle(
				{ command: "begin", launch: 1, token: TOKEN },
				SENDER,
			);
			await expect(
				controller.handle(
					{
						command: "complete",
						launch: 1,
						token: TOKEN,
						checks: passingChecks(),
					},
					SENDER,
				),
			).resolves.toEqual({ accepted: true });

			const result = JSON.parse(
				readFileSync(join(fixture.home, PACKAGED_SMOKE_OUTPUT_NAME), "utf8"),
			);
			expect(result).toEqual({
				schemaVersion: 1,
				kind: "ade-packaged-gui-smoke",
				launch: 1,
				status: "passed",
				completedAt: "2026-07-16T01:02:03.000Z",
				runtime: { platform: process.platform, arch: process.arch },
				checks: passingChecks(),
			});
			expect(exits).toEqual([0]);
			expect(startup.token).toBe("");
			await expect(
				controller.handle(
					{
						command: "complete",
						launch: 1,
						token: TOKEN,
						checks: passingChecks(),
					},
					SENDER,
				),
			).rejects.toThrow("already settled");
		} finally {
			fixture.cleanup();
		}
	});

	test("fails closed on the internal running timeout", async () => {
		const fixture = createStartupFixture();
		try {
			const exits: number[] = [];
			let timeout: (() => void) | undefined;
			const controller = createPackagedSmokeController({
				startup: requireStartup(fixture),
				authorizedSenderId: SENDER.senderId,
				scheduleExit: (code) => exits.push(code),
				setTimer: (callback, duration) => {
					expect(duration).toBe(PACKAGED_SMOKE_INTERNAL_TIMEOUT_MS);
					timeout = callback;
					return 1 as unknown as ReturnType<typeof setTimeout>;
				},
				clearTimer: () => {},
			});
			await controller.handle(
				{ command: "begin", launch: 1, token: TOKEN },
				SENDER,
			);
			timeout?.();
			await Bun.sleep(10);

			expect(
				existsSync(join(fixture.home, PACKAGED_SMOKE_OUTPUT_NAME)),
			).toBeTrue();
			expect(
				JSON.parse(
					readFileSync(join(fixture.home, PACKAGED_SMOKE_OUTPUT_NAME), "utf8"),
				).status,
			).toBe("failed");
			expect(exits).toEqual([1]);
		} finally {
			fixture.cleanup();
		}
	});
});
