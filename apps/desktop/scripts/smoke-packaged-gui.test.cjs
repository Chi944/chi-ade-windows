"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	PACKAGED_SMOKE_TIMEOUT_MS,
	buildLaunchEnvironment,
	canonicalizeTempRoot,
	collectDiagnosticLogTail,
	killDetachedTerminalHost,
	launchPackagedExecutable,
	parsePackagedSmokeResult,
	parseArguments,
	redactSmokeText,
	resolvePackagedExecutable,
	runPackagedSmoke,
} = require("./smoke-packaged-gui.cjs");

function passedResult(
	launch,
	platform = process.platform,
	arch = process.arch,
) {
	return {
		schemaVersion: 1,
		kind: "ade-packaged-gui-smoke",
		launch,
		status: "passed",
		completedAt: "2026-07-16T01:02:03.000Z",
		runtime: { platform, arch },
		checks: {
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
		},
	};
}

test("parses only an exact platform executable, variant, and optional artifact directory", () => {
	assert.deepEqual(
		parseArguments([
			"--platform",
			"win32",
			"--app",
			"C:\\release\\win-unpacked\\ADE.exe",
			"--artifacts",
			"C:\\artifacts",
		]),
		{
			platform: "win32",
			appPath: path.resolve("C:\\release\\win-unpacked\\ADE.exe"),
			artifactsPath: path.resolve("C:\\artifacts"),
			variant: "standard",
		},
	);
	assert.equal(
		parseArguments([
			"--platform",
			"win32",
			"--app",
			"C:\\release\\win-unpacked\\ADE Canary.exe",
			"--variant",
			"canary",
		]).variant,
		"canary",
	);
	assert.throws(() => parseArguments(["--platform", "linux", "--app", "ade"]));
	assert.throws(() => parseArguments(["--platform", "win32"]));
	assert.throws(() =>
		parseArguments(["--platform", "win32", "--app", "ADE.exe", "--eval", "1"]),
	);
	assert.throws(() =>
		parseArguments([
			"--platform",
			"win32",
			"--app",
			"ADE.exe",
			"--variant",
			"custom",
		]),
	);
});

test("requires the actual unpacked Windows or macOS executable", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-smoke-executable-"));
	try {
		const windowsExecutable = path.join(root, "win-unpacked", "ADE.exe");
		fs.mkdirSync(path.dirname(windowsExecutable), { recursive: true });
		fs.writeFileSync(windowsExecutable, "");
		assert.equal(
			resolvePackagedExecutable(windowsExecutable, "win32", {
				hostPlatform: "win32",
			}),
			fs.realpathSync(windowsExecutable),
		);

		const macExecutable = path.join(
			root,
			"mac-arm64",
			"ADE.app",
			"Contents",
			"MacOS",
			"ADE",
		);
		fs.mkdirSync(path.dirname(macExecutable), { recursive: true });
		fs.writeFileSync(macExecutable, "");
		fs.chmodSync(macExecutable, 0o755);
		assert.equal(
			resolvePackagedExecutable(macExecutable, "darwin", {
				hostPlatform: "darwin",
			}),
			fs.realpathSync(macExecutable),
		);

		assert.throws(() =>
			resolvePackagedExecutable(path.dirname(macExecutable), "darwin", {
				hostPlatform: "darwin",
			}),
		);
		assert.throws(() =>
			resolvePackagedExecutable(windowsExecutable, "darwin", {
				hostPlatform: "darwin",
			}),
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("accepts Canary naming only behind the explicit canary variant", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-smoke-canary-"));
	try {
		const windowsExecutable = path.join(root, "win-unpacked", "ADE Canary.exe");
		fs.mkdirSync(path.dirname(windowsExecutable), { recursive: true });
		fs.writeFileSync(windowsExecutable, "");
		assert.throws(() =>
			resolvePackagedExecutable(windowsExecutable, "win32", {
				hostPlatform: "win32",
			}),
		);
		assert.equal(
			resolvePackagedExecutable(windowsExecutable, "win32", {
				hostPlatform: "win32",
				variant: "canary",
			}),
			fs.realpathSync(windowsExecutable),
		);

		const macExecutable = path.join(
			root,
			"mac",
			"ADE Canary.app",
			"Contents",
			"MacOS",
			"ADE Canary",
		);
		fs.mkdirSync(path.dirname(macExecutable), { recursive: true });
		fs.writeFileSync(macExecutable, "");
		fs.chmodSync(macExecutable, 0o755);
		assert.throws(() =>
			resolvePackagedExecutable(macExecutable, "darwin", {
				hostPlatform: "darwin",
			}),
		);
		assert.equal(
			resolvePackagedExecutable(macExecutable, "darwin", {
				hostPlatform: "darwin",
				variant: "canary",
			}),
			fs.realpathSync(macExecutable),
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("canonicalizes macOS temporary roots before deriving smoke paths", () => {
	const seen = [];
	assert.equal(
		canonicalizeTempRoot("/var/folders/run", "darwin", (value) => {
			seen.push(value);
			return "/private/var/folders/run";
		}),
		"/private/var/folders/run",
	);
	assert.deepEqual(seen, ["/var/folders/run"]);
});

test("launch environment removes Electron's Node mode and isolates private roots", () => {
	const environment = buildLaunchEnvironment({
		baseEnvironment: {
			ELECTRON_RUN_AS_NODE: "1",
			ADE_SMOKE_MODULE_ROOT: "secret-module-root",
			ADE_ENABLE_DESKTOP_AUTOMATION: "1",
			NODE_OPTIONS: "--inspect",
			PATH: "unsafe-user-path",
			SystemRoot: "C:\\Windows",
			HOME: "C:\\Users\\runner",
			USERPROFILE: "C:\\Users\\runner",
			APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
			CODEX_HOME: "C:\\Users\\runner\\.codex",
			CLAUDE_CONFIG_DIR: "C:\\Users\\runner\\.claude",
			OPENAI_API_KEY: "must-not-leak",
			ANTHROPIC_API_KEY: "must-not-leak",
			GH_TOKEN: "must-not-leak",
		},
		tempRoot: path.resolve("smoke-root"),
		home: path.resolve("smoke-root", "ade-home"),
		outputPath: path.resolve(
			"smoke-root",
			"ade-home",
			"packaged-smoke-result.json",
		),
		token: "d".repeat(64),
		launch: 2,
		platform: "win32",
	});

	assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
	assert.equal(environment.ADE_SMOKE_MODULE_ROOT, undefined);
	assert.equal(environment.ADE_ENABLE_DESKTOP_AUTOMATION, undefined);
	assert.equal(environment.NODE_OPTIONS, undefined);
	assert.equal(environment.ADE_PACKAGED_SMOKE, "1");
	assert.equal(environment.NODE_ENV, "production");
	assert.equal(environment.ADE_PACKAGED_SMOKE_LAUNCH, "2");
	assert.equal(environment.ADE_DISABLE_PROTOCOL_REGISTRATION, "1");
	assert.equal(environment.ADE_PACKAGED_SMOKE_ROOT, path.resolve("smoke-root"));
	assert.equal(
		environment.LOCALAPPDATA,
		path.resolve("smoke-root", "local-app-data"),
	);
	assert.equal(
		environment.APPDATA,
		path.resolve("smoke-root", "roaming-app-data"),
	);
	assert.equal(environment.HOME, path.resolve("smoke-root", "os-home"));
	assert.equal(environment.USERPROFILE, path.resolve("smoke-root", "os-home"));
	assert.equal(
		environment.CODEX_HOME,
		path.resolve("smoke-root", "os-home", ".codex"),
	);
	assert.equal(
		environment.CLAUDE_CONFIG_DIR,
		path.resolve("smoke-root", "os-home", ".claude"),
	);
	assert.equal(environment.OPENAI_API_KEY, undefined);
	assert.equal(environment.ANTHROPIC_API_KEY, undefined);
	assert.equal(environment.GH_TOKEN, undefined);
	assert.doesNotMatch(environment.PATH, /unsafe-user-path/);
	assert.match(environment.PATH, /Windows[\\/]System32/i);
});

test("isolates macOS HOME so diagnostics and private provider state stay disposable", () => {
	const root = path.resolve("smoke-root");
	const environment = buildLaunchEnvironment({
		baseEnvironment: { HOME: "/Users/runner" },
		tempRoot: root,
		home: path.join(root, "ade-home"),
		outputPath: path.join(root, "ade-home", "packaged-smoke-result.json"),
		token: "d".repeat(64),
		launch: 1,
		platform: "darwin",
	});
	assert.equal(environment.HOME, path.join(root, "os-home"));
	assert.equal(environment.USERPROFILE, path.join(root, "os-home"));
	assert.equal(environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});

test("validates the exact fixed result schema and native runtime", () => {
	assert.equal(
		parsePackagedSmokeResult(passedResult(1, "win32", "x64"), {
			launch: 1,
			platform: "win32",
			arch: "x64",
		}).status,
		"passed",
	);
	assert.throws(() =>
		parsePackagedSmokeResult(
			{ ...passedResult(1, "win32", "x64"), extra: true },
			{ launch: 1, platform: "win32", arch: "x64" },
		),
	);
	assert.throws(() =>
		parsePackagedSmokeResult(passedResult(1, "darwin", "arm64"), {
			launch: 1,
			platform: "win32",
			arch: "x64",
		}),
	);
});

test("redacts entire window searches, tokens, and temporary roots from failure logs", () => {
	const token = "e".repeat(64);
	const root = "C:\\Users\\runner\\AppData\\Local\\Temp\\ade-smoke-secret";
	const input = [
		`file:///app/index.html?adePackagedSmoke=1&adePackagedSmokeToken=${token}#/`,
		`ADE_PACKAGED_SMOKE_TOKEN=${token}`,
		`${root}\\ade-home\\app-state.json`,
	].join("\n");
	const redacted = redactSmokeText(input, { token, tempRoot: root });
	assert.doesNotMatch(redacted, /adePackagedSmokeToken/);
	assert.doesNotMatch(redacted, new RegExp(token));
	assert.doesNotMatch(redacted, /ade-smoke-secret/);
	assert.match(redacted, /\[REDACTED_WINDOW_URL\]/);
});

test(
	"uses a 90 second hard timeout even when the killed process never emits exit",
	{ timeout: 1_000 },
	async () => {
		assert.equal(PACKAGED_SMOKE_TIMEOUT_MS, 90_000);
		const child = new EventEmitter();
		child.pid = 4242;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const spawnCalls = [];
		const kills = [];
		let timeoutHandler;

		const promise = launchPackagedExecutable({
			appPath: "C:\\release\\ADE.exe",
			environment: {},
			platform: "win32",
			timeoutMs: PACKAGED_SMOKE_TIMEOUT_MS,
			spawn: (...args) => {
				spawnCalls.push(args);
				return child;
			},
			setTimer: (handler, milliseconds) => {
				assert.equal(milliseconds, PACKAGED_SMOKE_TIMEOUT_MS);
				timeoutHandler = handler;
				return 1;
			},
			clearTimer: () => {},
			killTree: async (pid, platform) => kills.push({ pid, platform }),
		});
		await timeoutHandler();

		await assert.rejects(promise, /timed out after 90000ms/);
		assert.deepEqual(kills, [{ pid: 4242, platform: "win32" }]);
		assert.deepEqual(spawnCalls[0][1], []);
		assert.equal(spawnCalls[0][2].shell, false);
		assert.equal(spawnCalls[0][2].windowsHide, true);
	},
);

test("runs two launches within one 90s deadline using one home and fresh tokens", async () => {
	const outer = fs.mkdtempSync(
		path.join(os.tmpdir(), "ade-smoke-runner-success-"),
	);
	const tempRoot = path.join(outer, "run");
	fs.mkdirSync(tempRoot);
	const appPath = path.join(
		outer,
		process.platform === "win32" ? "ADE.exe" : "ADE",
	);
	fs.writeFileSync(appPath, "");
	if (process.platform !== "win32") fs.chmodSync(appPath, 0o755);
	const launches = [];
	const cleanupHosts = [];
	const targetPlatform = process.platform === "darwin" ? "darwin" : "win32";
	let clock = 1_000;
	try {
		const result = await runPackagedSmoke(
			{
				appPath,
				platform: targetPlatform,
				artifactsPath: path.join(outer, "artifacts"),
			},
			{
				createTempRoot: () => tempRoot,
				canonicalizeTempRoot: (value) => value,
				resolveExecutable: (value) => value,
				now: () => {
					clock += 1_000;
					return clock;
				},
				cleanupTerminalHost: async (home, platform) =>
					cleanupHosts.push({ home, platform }),
				launch: async ({
					environment,
					launch,
					home,
					outputPath,
					timeoutMs,
				}) => {
					assert.equal(fs.existsSync(outputPath), false);
					launches.push({ environment, launch, home, outputPath, timeoutMs });
					fs.writeFileSync(
						outputPath,
						`${JSON.stringify(passedResult(launch, targetPlatform))}\n`,
					);
					return { exitCode: 0, logTail: "" };
				},
			},
		);

		assert.equal(result.status, "passed");
		assert.equal(launches.length, 2);
		assert.equal(launches[0].home, launches[1].home);
		assert.notEqual(
			launches[0].environment.ADE_PACKAGED_SMOKE_TOKEN,
			launches[1].environment.ADE_PACKAGED_SMOKE_TOKEN,
		);
		assert.match(
			launches[0].environment.ADE_PACKAGED_SMOKE_TOKEN,
			/^[0-9a-f]{64}$/,
		);
		assert.equal(launches[0].environment.ADE_PACKAGED_SMOKE_LAUNCH, "1");
		assert.equal(launches[1].environment.ADE_PACKAGED_SMOKE_LAUNCH, "2");
		assert.ok(launches[0].timeoutMs <= 90_000);
		assert.ok(launches[1].timeoutMs < launches[0].timeoutMs);
		assert.deepEqual(cleanupHosts, [
			{ home: launches[0].home, platform: targetPlatform },
		]);
		assert.equal(fs.existsSync(tempRoot), false);
		assert.equal(fs.existsSync(path.join(outer, "artifacts")), false);
	} finally {
		fs.rmSync(outer, { recursive: true, force: true });
	}
});

test("reports redacted artifacts when private cleanup fails after passed launches", async () => {
	const outer = fs.mkdtempSync(
		path.join(os.tmpdir(), "ade-smoke-cleanup-failure-"),
	);
	const tempRoot = path.join(outer, "private-cleanup-root");
	fs.mkdirSync(tempRoot);
	const artifactsPath = path.join(outer, "artifacts");
	const targetPlatform = process.platform === "darwin" ? "darwin" : "win32";
	try {
		await assert.rejects(
			runPackagedSmoke(
				{
					appPath: path.join(outer, "ADE.exe"),
					platform: targetPlatform,
					artifactsPath,
				},
				{
					createTempRoot: () => tempRoot,
					canonicalizeTempRoot: (value) => value,
					resolveExecutable: (value) => value,
					cleanupTerminalHost: async () => {},
					removeTempRoot: () => {
						const error = new Error(`EPERM ${tempRoot}`);
						error.code = "EPERM";
						throw error;
					},
					launch: async ({ launch, outputPath }) => {
						fs.writeFileSync(
							outputPath,
							`${JSON.stringify(passedResult(launch, targetPlatform))}\n`,
						);
						return { exitCode: 0, logTail: "" };
					},
				},
			),
			/private cleanup failed/,
		);

		const result = JSON.parse(
			fs.readFileSync(path.join(artifactsPath, "result.json"), "utf8"),
		);
		const log = fs.readFileSync(
			path.join(artifactsPath, "log-tail.txt"),
			"utf8",
		);
		assert.equal(result.status, "failed");
		assert.match(log, /private cleanup failed \(EPERM\)/);
		assert.doesNotMatch(
			log,
			new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	} finally {
		fs.rmSync(outer, { recursive: true, force: true });
	}
});

test("removes the fresh temporary root when setup fails before launch", async () => {
	const outer = fs.mkdtempSync(
		path.join(os.tmpdir(), "ade-smoke-setup-failure-"),
	);
	const tempRoot = path.join(outer, "ade-packaged-gui-setup");
	fs.mkdirSync(tempRoot);
	try {
		await assert.rejects(
			runPackagedSmoke(
				{
					appPath: path.join(outer, "ADE.exe"),
					platform: "win32",
				},
				{
					createTempRoot: () => tempRoot,
					canonicalizeTempRoot: () => {
						throw new Error("canonicalization failed");
					},
					resolveExecutable: (value) => value,
				},
			),
			/canonicalization failed/,
		);
		assert.equal(fs.existsSync(tempRoot), false);
	} finally {
		fs.rmSync(outer, { recursive: true, force: true });
	}
});

test("writes only redacted failure artifacts and still removes the temporary home", async () => {
	const outer = fs.mkdtempSync(
		path.join(os.tmpdir(), "ade-smoke-runner-failure-"),
	);
	const tempRoot = path.join(outer, "private-secret-run");
	fs.mkdirSync(tempRoot);
	const artifactsPath = path.join(outer, "artifacts");
	const token = "f".repeat(64);
	try {
		await assert.rejects(
			runPackagedSmoke(
				{
					appPath: path.join(outer, "ADE.exe"),
					platform: "win32",
					artifactsPath,
				},
				{
					createTempRoot: () => tempRoot,
					canonicalizeTempRoot: (value) => value,
					resolveExecutable: (value) => value,
					randomToken: () => token,
					cleanupTerminalHost: async () => {},
					launch: async () => {
						const diagnosticDirectory = path.join(
							tempRoot,
							"local-app-data",
							"ADE",
							"private",
							"namespace",
							"logs",
						);
						fs.mkdirSync(diagnosticDirectory, { recursive: true });
						fs.writeFileSync(
							path.join(diagnosticDirectory, "ade.jsonl"),
							`{"event":"renderer.failed","token":"${token}","path":"${tempRoot.replaceAll("\\", "\\\\")}"}\n`,
						);
						throw Object.assign(new Error("renderer timed out"), {
							logTail: `file:///index.html?adePackagedSmokeToken=${token}#/ child stderr`,
						});
					},
				},
			),
			/Packaged GUI smoke failed/,
		);

		assert.equal(fs.existsSync(tempRoot), false);
		const result = fs.readFileSync(
			path.join(artifactsPath, "result.json"),
			"utf8",
		);
		const logs = fs.readFileSync(
			path.join(artifactsPath, "log-tail.txt"),
			"utf8",
		);
		assert.doesNotMatch(result, new RegExp(token));
		assert.doesNotMatch(result, /private-secret-run/);
		assert.doesNotMatch(logs, new RegExp(token));
		assert.doesNotMatch(logs, /adePackagedSmokeToken/);
		assert.doesNotMatch(logs, /private-secret-run/);
		assert.match(logs, /renderer\.failed/);
	} finally {
		fs.rmSync(outer, { recursive: true, force: true });
	}
});

test("redacts every launch token when the second launch fails", async () => {
	const outer = fs.mkdtempSync(
		path.join(os.tmpdir(), "ade-smoke-runner-token-redaction-"),
	);
	const tempRoot = path.join(outer, "run");
	fs.mkdirSync(tempRoot);
	const artifactsPath = path.join(outer, "artifacts");
	const tokens = ["a".repeat(64), "b".repeat(64)];
	let tokenIndex = 0;
	try {
		await assert.rejects(
			runPackagedSmoke(
				{
					appPath: path.join(outer, "ADE.exe"),
					platform: "win32",
					artifactsPath,
				},
				{
					createTempRoot: () => tempRoot,
					canonicalizeTempRoot: (value) => value,
					resolveExecutable: (value) => value,
					randomToken: () => tokens[tokenIndex++],
					cleanupTerminalHost: async () => {},
					launch: async ({ launch, outputPath }) => {
						if (launch === 1) {
							fs.writeFileSync(
								outputPath,
								`${JSON.stringify(passedResult(1, "win32"))}\n`,
							);
							return { exitCode: 0, logTail: "" };
						}
						throw Object.assign(new Error("second launch failed"), {
							logTail: `first=${tokens[0]} second=${tokens[1]}`,
						});
					},
				},
			),
			/Packaged GUI smoke failed/,
		);

		const logs = fs.readFileSync(
			path.join(artifactsPath, "log-tail.txt"),
			"utf8",
		);
		assert.doesNotMatch(logs, new RegExp(tokens[0]));
		assert.doesNotMatch(logs, new RegExp(tokens[1]));
	} finally {
		fs.rmSync(outer, { recursive: true, force: true });
	}
});

test("collects only a bounded diagnostics JSONL tail beneath the isolated root", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-smoke-diagnostics-"));
	try {
		const logs = path.join(
			root,
			"os-home",
			"Library",
			"Application Support",
			"ADE",
			"private",
			"id",
			"logs",
		);
		fs.mkdirSync(logs, { recursive: true });
		fs.writeFileSync(
			path.join(logs, "ade.jsonl"),
			`${"x".repeat(20_000)}\nlast-event\n`,
		);
		const tail = collectDiagnosticLogTail(root, 1_024);
		assert.ok(Buffer.byteLength(tail) <= 1_024);
		assert.match(tail, /last-event/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kills a detached terminal host from the isolated ADE home PID artifact", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "ade-smoke-terminal-host-"),
	);
	try {
		fs.writeFileSync(path.join(root, "terminal-host.pid"), "9876\n");
		const kills = [];
		await killDetachedTerminalHost(root, "darwin", {
			killTree: async (pid, platform) => kills.push({ pid, platform }),
		});
		assert.deepEqual(kills, [{ pid: 9876, platform: "darwin" }]);
		assert.equal(fs.existsSync(path.join(root, "terminal-host.pid")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
