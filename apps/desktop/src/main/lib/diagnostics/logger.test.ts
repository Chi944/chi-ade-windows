import { afterEach, describe, expect, mock, test } from "bun:test";
import {
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
import ts from "typescript";
import {
	createDiagnosticsLogger,
	DIAGNOSTICS_LOG_MAX_BYTES,
	DIAGNOSTICS_LOG_MAX_FILES,
	readRecentDiagnosticEntries,
	resolveDiagnosticsCrashDirectory,
	resolveDiagnosticsDirectory,
	resolveDiagnosticsLogDirectory,
} from "./logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(
		join(await realpath(tmpdir()), "ade-diagnostics-test-"),
	);
	temporaryDirectories.push(directory);
	return directory;
}

describe("diagnostics paths", () => {
	test("keeps logs and crash dumps beneath the OS-local private namespace", () => {
		const privateRoot = join("local-data", "ADE", "private", "namespace");
		const diagnosticsRoot = resolveDiagnosticsDirectory(privateRoot);

		expect(diagnosticsRoot).toBe(join(privateRoot, "diagnostics"));
		expect(resolveDiagnosticsLogDirectory(privateRoot)).toBe(
			join(diagnosticsRoot, "logs"),
		);
		expect(resolveDiagnosticsCrashDirectory(privateRoot)).toBe(
			join(diagnosticsRoot, "crashes"),
		);
	});
});

describe("early diagnostics bootstrap", () => {
	test("launches owner startup through a CommonJS-compatible terminal failure path", async () => {
		const source = await readFile(
			join(import.meta.dir, "..", "..", "bootstrap.ts"),
			"utf8",
		);
		const sourceFile = ts.createSourceFile(
			"bootstrap.ts",
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const topLevelAwaitLines: number[] = [];
		const visit = (node: ts.Node, insideFunction = false): void => {
			if (ts.isAwaitExpression(node) && !insideFunction) {
				topLevelAwaitLines.push(
					sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
				);
			}
			const childInsideFunction = insideFunction || ts.isFunctionLike(node);
			ts.forEachChild(node, (child) => visit(child, childInsideFunction));
		};
		visit(sourceFile);

		expect(topLevelAwaitLines).toEqual([]);
		expect(source).toContain(
			"async function startOwnerApplication(): Promise<void>",
		);
		expect(source).toContain("void startOwnerApplication().catch((error) => {");
		const ownerLaunch = source.indexOf("void startOwnerApplication().catch(");
		const terminalFailurePath = source.slice(ownerLaunch);
		expect(ownerLaunch).toBeGreaterThan(source.indexOf("} else {"));
		expect(terminalFailurePath).toContain(
			'logProcessFailure("bootstrap-fatal", error)',
		);
		expect(terminalFailurePath).toContain("app.exit(1)");
	});

	test("configures local paths and crash capture before logging and main import", async () => {
		const source = await readFile(
			join(import.meta.dir, "..", "..", "bootstrap.ts"),
			"utf8",
		);
		const setUserData = source.indexOf('app.setPath("userData"');
		const setCrashDumps = source.indexOf('app.setPath("crashDumps"');
		const pruneCrashDumps = source.indexOf("pruneCrashDumpStorage(");
		const startCrashReporter = source.indexOf("crashReporter.start(");
		const initializeLogger = source.indexOf("initializeDiagnosticsLogger(");
		const acquireSingleInstance = source.indexOf("acquireSingleInstanceLock(");
		const initializeBootState = source.indexOf("initializeBootState(");
		const importMain = source.indexOf('import("./index")');

		expect(setUserData).toBeGreaterThan(-1);
		expect(setCrashDumps).toBeGreaterThan(setUserData);
		expect(pruneCrashDumps).toBeGreaterThan(setCrashDumps);
		expect(pruneCrashDumps).toBeLessThan(startCrashReporter);
		expect(startCrashReporter).toBeGreaterThan(setCrashDumps);
		expect(initializeLogger).toBeGreaterThan(startCrashReporter);
		expect(acquireSingleInstance).toBeGreaterThan(initializeLogger);
		expect(initializeBootState).toBeGreaterThan(acquireSingleInstance);
		expect(importMain).toBeGreaterThan(initializeBootState);
		expect(source).toContain("uploadToServer: false");
		expect(source).toContain('process.on("uncaughtExceptionMonitor"');
		expect(source).toContain('process.on("unhandledRejection"');
	});

	test("prunes completed installers on every owner startup before loading main", async () => {
		const source = await readFile(
			join(import.meta.dir, "..", "..", "bootstrap.ts"),
			"utf8",
		);
		const owner = source.slice(
			source.indexOf("async function startOwnerApplication"),
			source.indexOf("if (!ownsSingleInstance)"),
		);
		const prune = owner.indexOf("await pruneCompletedInstallerVersions(");
		const importMain = owner.indexOf('await import("./index")');

		expect(prune).toBeGreaterThan(-1);
		expect(prune).toBeLessThan(importMain);
		expect(owner).toContain('join(adeHomeDir, "updates")');
		expect(owner).toContain("app.getVersion()");
		expect(owner).toContain('"update-storage.prune.failed"');
	});

	test("schedules recurring unrefed crash pruning after diagnostics initialize", async () => {
		const source = await readFile(
			join(import.meta.dir, "..", "..", "bootstrap.ts"),
			"utf8",
		);
		const initializeLogger = source.indexOf("initializeDiagnosticsLogger(");
		const schedule = source.indexOf("scheduleCrashDumpPruning({");

		expect(schedule).toBeGreaterThan(initializeLogger);
		expect(source).toContain(
			"prune: () => pruneCrashDumpStorage(diagnosticsCrashDirectory)",
		);
		expect(source).toContain('"crash-storage.prune.failed"');
	});

	test("secondary instances exit before recording a boot attempt", async () => {
		const [bootstrapSource, mainSource] = await Promise.all([
			readFile(join(import.meta.dir, "..", "..", "bootstrap.ts"), "utf8"),
			readFile(join(import.meta.dir, "..", "..", "index.ts"), "utf8"),
		]);

		expect(bootstrapSource.indexOf("acquireSingleInstanceLock(")).toBeLessThan(
			bootstrapSource.indexOf("initializeBootState("),
		);
		expect(bootstrapSource).toContain("if (!ownsSingleInstance)");
		expect(bootstrapSource).toContain("bootAttemptRecorded: false");
		expect(mainSource).toContain("hasSingleInstanceLock()");
		expect(mainSource).not.toContain("app.requestSingleInstanceLock()");
	});

	test("routes update failures locally and mirrors raw errors only in development", async () => {
		const source = await readFile(
			join(import.meta.dir, "..", "auto-updater.ts"),
			"utf8",
		);

		expect(source).toContain("logUpdateFailure(error");
		expect(source).toContain(
			'if (env.NODE_ENV === "development") console.error(message, error)',
		);
		expect(source.match(/console\.error/g)).toHaveLength(1);
	});

	test("uses bootstrap as the main bundle entry and carries no Sentry client", async () => {
		const desktopRoot = join(import.meta.dir, "..", "..", "..", "..");
		const [viteConfig, mainEnv, rendererEnv, rendererHtml, packageJson] =
			await Promise.all([
				readFile(join(desktopRoot, "electron.vite.config.ts"), "utf8"),
				readFile(join(desktopRoot, "src", "main", "env.main.ts"), "utf8"),
				readFile(
					join(desktopRoot, "src", "renderer", "env.renderer.ts"),
					"utf8",
				),
				readFile(join(desktopRoot, "src", "renderer", "index.html"), "utf8"),
				readFile(join(desktopRoot, "package.json"), "utf8"),
			]);

		expect(viteConfig).toContain('index: resolve("src/main/bootstrap.ts")');
		for (const source of [
			viteConfig,
			mainEnv,
			rendererEnv,
			rendererHtml,
			packageJson,
		]) {
			expect(source.toLowerCase()).not.toContain("sentry");
		}
	});
});

describe("createDiagnosticsLogger", () => {
	test("writes structured, redacted JSON-lines entries", async () => {
		const directory = await temporaryDirectory();
		const logger = createDiagnosticsLogger({
			directory,
			now: () => new Date("2026-07-16T12:34:56.000Z"),
			homePaths: [String.raw`C:\Users\Alice`],
		});

		logger.error("provider.connection.failed", {
			provider: "codex",
			token: "sk-proj-0123456789abcdefghijklmnopqrstuvwxyz",
			path: String.raw`C:\Users\Alice\.codex\auth.json`,
			error: new Error("Bearer nested-secret-value"),
		});

		const raw = await readFile(join(directory, "ade.jsonl"), "utf8");
		const lines = raw.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]);
		expect(entry).toEqual({
			timestamp: "2026-07-16T12:34:56.000Z",
			level: "error",
			event: "provider.connection.failed",
			details: {
				provider: "codex",
				token: "[REDACTED]",
				path: String.raw`[HOME]\.codex\auth.json`,
				error: expect.objectContaining({
					name: "Error",
					message: "Bearer [REDACTED]",
				}),
			},
		});
		expect(raw).not.toContain("nested-secret-value");
		expect(raw).not.toContain("Alice");
	});

	test("serializes circular details without throwing", async () => {
		const directory = await temporaryDirectory();
		const logger = createDiagnosticsLogger({ directory });
		const details: Record<string, unknown> = { state: "starting" };
		details.self = details;

		expect(() => logger.info("boot.starting", details)).not.toThrow();
		const raw = await readFile(join(directory, "ade.jsonl"), "utf8");
		expect(raw).toContain('"self":"[CIRCULAR]"');
	});

	test("mirrors only redacted structured entries to the development console", async () => {
		const directory = await temporaryDirectory();
		const consoleSink = {
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		};
		const logger = createDiagnosticsLogger({
			directory,
			mirrorToConsole: true,
			console: consoleSink,
		});

		logger.warn("health.check.warning", { apiKey: "console-secret" });

		expect(consoleSink.warn).toHaveBeenCalledTimes(1);
		const mirrored = JSON.stringify(consoleSink.warn.mock.calls);
		expect(mirrored).toContain("health.check.warning");
		expect(mirrored).toContain("[REDACTED]");
		expect(mirrored).not.toContain("console-secret");
	});

	test("rotates at one MiB and retains exactly three bounded log files", async () => {
		const directory = await temporaryDirectory();
		const logger = createDiagnosticsLogger({ directory });
		const payload = "x".repeat(400_000);

		for (let index = 0; index < 8; index += 1) {
			logger.info(`rotation.entry.${index}`, { payload });
		}

		const files = (await readdir(directory)).sort();
		expect(DIAGNOSTICS_LOG_MAX_BYTES).toBe(1024 * 1024);
		expect(DIAGNOSTICS_LOG_MAX_FILES).toBe(3);
		expect(files).toEqual(["ade.1.jsonl", "ade.2.jsonl", "ade.jsonl"]);
		for (const file of files) {
			expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(
				DIAGNOSTICS_LOG_MAX_BYTES,
			);
		}
		const retained = (
			await Promise.all(
				files.map((file) => readFile(join(directory, file), "utf8")),
			)
		).join("\n");
		expect(retained).toContain("rotation.entry.7");
		expect(retained).not.toContain("rotation.entry.0");
	});

	test("prunes legacy rotated logs beyond the three-file budget on startup", async () => {
		const directory = await temporaryDirectory();
		await Promise.all([
			writeFile(join(directory, "ade.1.jsonl"), "one\n"),
			writeFile(join(directory, "ade.2.jsonl"), "two\n"),
			writeFile(join(directory, "ade.3.jsonl"), "stale\n"),
			writeFile(join(directory, "ade.99.jsonl"), "stale\n"),
			writeFile(join(directory, "ade.01.jsonl"), "noncanonical\n"),
			writeFile(join(directory, "unrelated.txt"), "keep\n"),
		]);

		const logger = createDiagnosticsLogger({ directory });
		logger.info("startup.ready");

		expect((await readdir(directory)).sort()).toEqual([
			"ade.1.jsonl",
			"ade.2.jsonl",
			"ade.jsonl",
			"unrelated.txt",
		]);
	});

	test("refuses to traverse a symbolic link while creating diagnostics", async () => {
		const root = await temporaryDirectory();
		const privateRoot = join(root, "private");
		const outside = join(root, "outside");
		await mkdir(privateRoot);
		await mkdir(outside);
		await symlink(
			outside,
			join(privateRoot, "diagnostics"),
			process.platform === "win32" ? "junction" : "dir",
		);

		expect(() =>
			createDiagnosticsLogger({
				directory: join(privateRoot, "diagnostics", "logs"),
			}),
		).toThrow("symbolic link");
		expect(await readdir(outside)).toEqual([]);
	});

	test("bounds oversized individual entries instead of growing past the cap", async () => {
		const directory = await temporaryDirectory();
		const logger = createDiagnosticsLogger({ directory });

		logger.info("oversized.entry", { payload: "y".repeat(2 * 1024 * 1024) });

		const logPath = join(directory, "ade.jsonl");
		expect((await stat(logPath)).size).toBeLessThanOrEqual(
			DIAGNOSTICS_LOG_MAX_BYTES,
		);
		const raw = await readFile(logPath, "utf8");
		expect(raw).toContain('"truncated":true');
		expect(raw).toContain('"originalBytes"');
	});
});

describe("readRecentDiagnosticEntries", () => {
	test("returns a bounded chronological tail and ignores malformed lines", async () => {
		const directory = await temporaryDirectory();
		const logger = createDiagnosticsLogger({
			directory,
			maxBytes: 300,
			maxFiles: 3,
			now: (() => {
				let tick = 0;
				return () => new Date(Date.UTC(2026, 6, 16, 0, 0, tick++));
			})(),
		});
		for (let index = 0; index < 6; index += 1) {
			logger.info(`tail.${index}`, { padding: "z".repeat(80) });
		}
		await writeFile(join(directory, "ade.2.jsonl"), "not-json\n", {
			flag: "a",
		});

		const entries = await readRecentDiagnosticEntries({ directory, limit: 3 });

		expect(entries.map((entry) => entry.event)).toEqual([
			"tail.3",
			"tail.4",
			"tail.5",
		]);
	});
});
