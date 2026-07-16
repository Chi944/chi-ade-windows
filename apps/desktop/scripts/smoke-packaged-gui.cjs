"use strict";

const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");

const PACKAGED_SMOKE_TIMEOUT_MS = 90_000;
const OUTPUT_NAME = "packaged-smoke-result.json";
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const CHECK_NAMES = [
	"rendererReady",
	"bootErrorFree",
	"stateHydrated",
	"sixPanesCreated",
	"seventhPaneRejected",
	"claudeAccountMarker",
	"codexAccountMarker",
	"healthQueryCompleted",
	"updateAssetSelected",
	"statePersisted",
];

function exactKeys(value, expected) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...expected].sort())
	);
}

function parseArguments(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (
			!value ||
			!["--platform", "--app", "--artifacts", "--variant"].includes(flag)
		) {
			throw new Error("Invalid packaged smoke arguments");
		}
		if (flag === "--platform") parsed.platform = value;
		if (flag === "--app") parsed.appPath = path.resolve(value);
		if (flag === "--artifacts") parsed.artifactsPath = path.resolve(value);
		if (flag === "--variant") parsed.variant = value;
	}
	parsed.variant ??= "standard";
	if (
		(parsed.platform !== "win32" && parsed.platform !== "darwin") ||
		!parsed.appPath ||
		!["standard", "canary"].includes(parsed.variant)
	) {
		throw new Error("Packaged smoke requires --platform and --app");
	}
	return parsed;
}

function resolvePackagedExecutable(appPath, platform, options = {}) {
	const hostPlatform = options.hostPlatform ?? process.platform;
	if (hostPlatform !== platform) {
		throw new Error("Packaged executable platform does not match the host");
	}
	const stat = fs.lstatSync(appPath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Packaged application path is not a regular executable");
	}
	const executable = fs.realpathSync.native(appPath);
	const variant = options.variant ?? "standard";
	if (variant !== "standard" && variant !== "canary") {
		throw new Error("Unknown packaged application variant");
	}
	const productName = variant === "canary" ? "ADE Canary" : "ADE";
	if (platform === "win32") {
		if (
			path.basename(executable) !== `${productName}.exe` ||
			path.basename(path.dirname(executable)).toLowerCase() !== "win-unpacked"
		) {
			throw new Error(`Expected release/win-unpacked/${productName}.exe`);
		}
	} else {
		const segments = executable.split(path.sep);
		if (
			segments.at(-1) !== productName ||
			segments.at(-2) !== "MacOS" ||
			segments.at(-3) !== "Contents" ||
			segments.at(-4) !== `${productName}.app`
		) {
			throw new Error(
				`Expected ${productName}.app/Contents/MacOS/${productName}`,
			);
		}
		fs.accessSync(executable, fs.constants.X_OK);
	}
	return executable;
}

function canonicalizeTempRoot(
	tempRoot,
	_platform,
	realpath = fs.realpathSync.native,
) {
	return realpath(tempRoot);
}

function buildLaunchEnvironment(options) {
	const environment = { ...options.baseEnvironment };
	for (const key of Object.keys(environment)) {
		const normalized = key.toUpperCase();
		if (
			[
				"ELECTRON_RUN_AS_NODE",
				"ADE_SMOKE_MODULE_ROOT",
				"ADE_ENABLE_DESKTOP_AUTOMATION",
				"NODE_OPTIONS",
				"SSH_AUTH_SOCK",
				"GPG_AGENT_INFO",
				"GIT_ASKPASS",
				"SSH_ASKPASS",
			].includes(normalized) ||
			/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/u.test(
				normalized,
			)
		) {
			delete environment[key];
		}
	}
	const osHome = path.join(options.tempRoot, "os-home");
	const xdgRoot = path.join(osHome, ".local");
	const systemPath =
		options.platform === "win32"
			? [
					path.win32.join(
						options.baseEnvironment.SystemRoot ||
							options.baseEnvironment.WINDIR ||
							"C:\\Windows",
						"System32",
					),
					path.win32.join(
						options.baseEnvironment.SystemRoot ||
							options.baseEnvironment.WINDIR ||
							"C:\\Windows",
						"System32",
						"WindowsPowerShell",
						"v1.0",
					),
					path.win32.join(
						options.baseEnvironment.SystemRoot ||
							options.baseEnvironment.WINDIR ||
							"C:\\Windows",
						"System32",
						"OpenSSH",
					),
				].join(";")
			: "/usr/bin:/bin:/usr/sbin:/sbin";
	Object.assign(environment, {
		NODE_ENV: "production",
		ADE_PACKAGED_SMOKE: "1",
		ADE_PACKAGED_SMOKE_TOKEN: options.token,
		ADE_PACKAGED_SMOKE_LAUNCH: String(options.launch),
		ADE_PACKAGED_SMOKE_ROOT: options.tempRoot,
		ADE_PACKAGED_SMOKE_OUTPUT: options.outputPath,
		ADE_HOME_DIR: options.home,
		ADE_DISABLE_PROTOCOL_REGISTRATION: "1",
		HOME: osHome,
		USERPROFILE: osHome,
		PATH: systemPath,
		CODEX_HOME: path.join(osHome, ".codex"),
		CLAUDE_CONFIG_DIR: path.join(osHome, ".claude"),
		GH_CONFIG_DIR: path.join(osHome, ".config", "gh"),
		HF_HOME: path.join(xdgRoot, "share", "huggingface"),
		OLLAMA_MODELS: path.join(xdgRoot, "share", "ollama", "models"),
		XDG_CONFIG_HOME: path.join(osHome, ".config"),
		XDG_DATA_HOME: path.join(xdgRoot, "share"),
		XDG_CACHE_HOME: path.join(osHome, ".cache"),
		XDG_STATE_HOME: path.join(xdgRoot, "state"),
		GIT_CONFIG_GLOBAL: path.join(osHome, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		NPM_CONFIG_USERCONFIG: path.join(osHome, ".npmrc"),
		NPM_CONFIG_CACHE: path.join(osHome, ".npm-cache"),
	});
	if (options.platform === "win32") {
		environment.LOCALAPPDATA = path.join(options.tempRoot, "local-app-data");
		environment.APPDATA = path.join(options.tempRoot, "roaming-app-data");
	}
	return environment;
}

function redactSmokeText(text, options) {
	let redacted = String(text ?? "");
	redacted = redacted.replace(
		/(?:file|https?):\/\/[^\s"']+/giu,
		"[REDACTED_WINDOW_URL]",
	);
	if (options.token)
		redacted = redacted.split(options.token).join("[REDACTED_TOKEN]");
	redacted = redacted.replace(
		/ADE_PACKAGED_SMOKE_TOKEN=[^\s]+/gu,
		"ADE_PACKAGED_SMOKE_TOKEN=[REDACTED_TOKEN]",
	);
	if (options.tempRoot) {
		for (const root of new Set([
			options.tempRoot,
			options.tempRoot.replaceAll("\\", "/"),
			options.tempRoot.replaceAll("/", "\\"),
			options.tempRoot.replaceAll("\\", "\\\\"),
		])) {
			redacted = redacted.split(root).join("[REDACTED_TEMP_ROOT]");
		}
	}
	return Buffer.from(redacted, "utf8")
		.subarray(-MAX_LOG_TAIL_BYTES)
		.toString("utf8");
}

async function defaultKillTree(pid, platform) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	if (platform === "win32") {
		await new Promise((resolve) => {
			const killer = nodeSpawn(
				"taskkill.exe",
				["/PID", String(pid), "/T", "/F"],
				{ shell: false, windowsHide: true, stdio: "ignore" },
			);
			killer.once("error", resolve);
			killer.once("exit", resolve);
		});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The process already exited.
		}
	}
}

function launchPackagedExecutable(options) {
	return new Promise((resolve, reject) => {
		const child = options.spawn(options.appPath, [], {
			detached: options.platform !== "win32",
			env: options.environment,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: options.platform === "win32",
		});
		let tail = "";
		let timedOut = false;
		let settled = false;
		const append = (chunk) => {
			tail = `${tail}${String(chunk)}`;
			if (Buffer.byteLength(tail) > MAX_LOG_TAIL_BYTES) {
				tail = Buffer.from(tail).subarray(-MAX_LOG_TAIL_BYTES).toString("utf8");
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const timer = options.setTimer(async () => {
			timedOut = true;
			try {
				await options.killTree(child.pid, options.platform);
			} finally {
				finish(
					new Error(
						`Packaged executable timed out after ${options.timeoutMs}ms`,
					),
				);
			}
		}, options.timeoutMs);
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			options.clearTimer(timer);
			if (error) {
				error.logTail = tail;
				reject(error);
			} else {
				resolve(value);
			}
		};
		child.once("error", (error) => finish(error));
		child.once("exit", (exitCode, signal) => {
			if (timedOut) {
				finish(
					new Error(
						`Packaged executable timed out after ${options.timeoutMs}ms`,
					),
				);
				return;
			}
			finish(null, { exitCode, signal, logTail: tail });
		});
	});
}

function parsePackagedSmokeResult(value, expected) {
	if (
		!exactKeys(value, [
			"schemaVersion",
			"kind",
			"launch",
			"status",
			"completedAt",
			"runtime",
			"checks",
		]) ||
		value.schemaVersion !== 1 ||
		value.kind !== "ade-packaged-gui-smoke" ||
		value.launch !== expected.launch ||
		(value.status !== "passed" && value.status !== "failed") ||
		typeof value.completedAt !== "string" ||
		Number.isNaN(Date.parse(value.completedAt)) ||
		!exactKeys(value.runtime, ["platform", "arch"]) ||
		value.runtime.platform !== expected.platform ||
		value.runtime.arch !== expected.arch ||
		!exactKeys(value.checks, CHECK_NAMES)
	) {
		throw new Error("Invalid packaged smoke result");
	}
	for (const name of CHECK_NAMES) {
		if (typeof value.checks[name] !== "boolean") {
			throw new Error("Invalid packaged smoke check");
		}
	}
	const passed = CHECK_NAMES.every((name) => value.checks[name]);
	if ((value.status === "passed") !== passed) {
		throw new Error("Packaged smoke status does not match checks");
	}
	return value;
}

function readResult(outputPath, expected) {
	const stat = fs.lstatSync(outputPath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESULT_BYTES) {
		throw new Error("Invalid packaged smoke result artifact");
	}
	return parsePackagedSmokeResult(
		JSON.parse(fs.readFileSync(outputPath, "utf8")),
		expected,
	);
}

function collectDiagnosticLogTail(tempRoot, maxBytes = MAX_LOG_TAIL_BYTES) {
	const candidates = [];
	const visit = (directory, depth) => {
		if (depth > 10) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const child = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(child, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const stat = fs.statSync(child);
				candidates.push({
					path: child,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				});
			}
		}
	};
	if (!fs.existsSync(tempRoot)) return "";
	visit(tempRoot, 0);
	candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
	let output = "";
	for (const candidate of candidates) {
		const length = Math.min(candidate.size, maxBytes);
		const buffer = Buffer.alloc(length);
		const file = fs.openSync(candidate.path, "r");
		try {
			fs.readSync(file, buffer, 0, length, candidate.size - length);
		} finally {
			fs.closeSync(file);
		}
		output = `${output}${buffer.toString("utf8")}\n`;
		output = Buffer.from(output).subarray(-maxBytes).toString("utf8");
	}
	return output;
}

async function killDetachedTerminalHost(home, platform, dependencies = {}) {
	const pidPath = path.join(home, "terminal-host.pid");
	if (!fs.existsSync(pidPath)) return;
	try {
		const stat = fs.lstatSync(pidPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32) return;
		const raw = fs.readFileSync(pidPath, "utf8").trim();
		if (!/^[1-9][0-9]*$/.test(raw)) return;
		const pid = Number(raw);
		if (!Number.isSafeInteger(pid) || pid === process.pid) return;
		await (dependencies.killTree ?? defaultKillTree)(pid, platform);
	} finally {
		fs.rmSync(pidPath, { force: true });
	}
}

function writeFailureArtifacts(options) {
	if (!options.artifactsPath) return;
	fs.mkdirSync(options.artifactsPath, { recursive: true });
	const result = options.result ?? {
		schemaVersion: 1,
		kind: "ade-packaged-gui-smoke-suite",
		status: "failed",
		platform: options.platform,
		arch: options.arch,
		launch: options.launch,
	};
	fs.writeFileSync(
		path.join(options.artifactsPath, "result.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(options.artifactsPath, "log-tail.txt"),
		options.logTail || "No diagnostic log entries were available.\n",
		{ mode: 0o600 },
	);
}

async function runPackagedSmoke(options, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const createTempRoot =
		dependencies.createTempRoot ??
		(() => fs.mkdtempSync(path.join(os.tmpdir(), "ade-packaged-gui-")));
	const canonicalize =
		dependencies.canonicalizeTempRoot ?? canonicalizeTempRoot;
	const resolveExecutable =
		dependencies.resolveExecutable ?? resolvePackagedExecutable;
	const randomToken =
		dependencies.randomToken ?? (() => randomBytes(32).toString("hex"));
	const launch =
		dependencies.launch ??
		((launchOptions) =>
			launchPackagedExecutable({
				...launchOptions,
				spawn: nodeSpawn,
				setTimer: setTimeout,
				clearTimer: clearTimeout,
				killTree: defaultKillTree,
			}));
	const cleanupTerminalHost =
		dependencies.cleanupTerminalHost ?? killDetachedTerminalHost;
	const removeTempRoot =
		dependencies.removeTempRoot ??
		((root) =>
			fs.rmSync(root, {
				recursive: true,
				force: true,
				maxRetries: 20,
				retryDelay: 250,
			}));
	const arch = options.arch ?? process.arch;
	if (!["x64", "arm64"].includes(arch)) {
		throw new Error("Unsupported packaged smoke architecture");
	}
	const executable = resolveExecutable(options.appPath, options.platform, {
		hostPlatform: process.platform,
		variant: options.variant ?? "standard",
	});
	const rawTempRoot = createTempRoot();
	let tempRoot;
	let home;
	let outputPath;
	try {
		tempRoot = canonicalize(rawTempRoot, options.platform);
		home = path.join(tempRoot, "ade-home");
		outputPath = path.join(home, OUTPUT_NAME);
		fs.mkdirSync(home, { recursive: false, mode: 0o700 });
		fs.mkdirSync(path.join(tempRoot, "local-app-data"), { recursive: true });
		fs.mkdirSync(path.join(tempRoot, "roaming-app-data"), { recursive: true });
		fs.mkdirSync(path.join(tempRoot, "os-home"), { recursive: true });
	} catch (error) {
		removeTempRoot(rawTempRoot);
		throw error;
	}
	const deadline = now() + PACKAGED_SMOKE_TIMEOUT_MS;
	let currentLaunch = 1;
	let currentToken = "";
	const issuedTokens = [];
	let lastChildTail = "";
	let failedResult = null;

	try {
		const launches = [];
		for (currentLaunch = 1; currentLaunch <= 2; currentLaunch += 1) {
			const timeoutMs = deadline - now();
			if (timeoutMs <= 0)
				throw new Error("Packaged GUI smoke deadline expired");
			currentToken = randomToken();
			if (!/^[0-9a-f]{64}$/.test(currentToken)) {
				throw new Error("Invalid generated packaged smoke token");
			}
			issuedTokens.push(currentToken);
			if (fs.existsSync(outputPath)) {
				throw new Error("Packaged smoke result unexpectedly pre-exists");
			}
			const environment = buildLaunchEnvironment({
				baseEnvironment: process.env,
				tempRoot,
				home,
				outputPath,
				token: currentToken,
				launch: currentLaunch,
				platform: options.platform,
			});
			const child = await launch({
				appPath: executable,
				environment,
				platform: options.platform,
				launch: currentLaunch,
				home,
				outputPath,
				timeoutMs,
			});
			lastChildTail = child.logTail ?? "";
			const result = readResult(outputPath, {
				launch: currentLaunch,
				platform: options.platform,
				arch,
			});
			if (child.exitCode !== 0 || result.status !== "passed") {
				failedResult = result;
				throw new Error("Packaged application reported a smoke failure");
			}
			launches.push(result);
			fs.rmSync(outputPath);
		}
		return { status: "passed", launches };
	} catch (error) {
		lastChildTail = `${lastChildTail}\n${error.logTail ?? ""}\n${collectDiagnosticLogTail(tempRoot)}`;
		for (const token of issuedTokens) {
			lastChildTail = redactSmokeText(lastChildTail, { token, tempRoot });
		}
		writeFailureArtifacts({
			artifactsPath: options.artifactsPath,
			platform: options.platform,
			arch,
			launch: currentLaunch > 2 ? 2 : currentLaunch,
			result: failedResult,
			logTail: lastChildTail,
		});
		throw new Error("Packaged GUI smoke failed; inspect failure artifacts");
	} finally {
		try {
			try {
				await cleanupTerminalHost(home, options.platform);
			} finally {
				removeTempRoot(tempRoot);
			}
		} catch (error) {
			const code =
				typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)
					? error.code
					: "UNKNOWN";
			writeFailureArtifacts({
				artifactsPath: options.artifactsPath,
				platform: options.platform,
				arch,
				launch: currentLaunch > 2 ? 2 : currentLaunch,
				result: failedResult,
				logTail: redactSmokeText(
					`Packaged smoke private cleanup failed (${code}).`,
					{ tempRoot },
				),
			});
			throw new Error("Packaged smoke private cleanup failed");
		}
	}
}

module.exports = {
	PACKAGED_SMOKE_TIMEOUT_MS,
	buildLaunchEnvironment,
	canonicalizeTempRoot,
	collectDiagnosticLogTail,
	killDetachedTerminalHost,
	launchPackagedExecutable,
	parseArguments,
	parsePackagedSmokeResult,
	redactSmokeText,
	resolvePackagedExecutable,
	runPackagedSmoke,
};

if (require.main === module) {
	runPackagedSmoke(parseArguments(process.argv.slice(2)))
		.then(() => {
			console.log("Packaged GUI smoke passed (two launches)");
		})
		.catch(() => {
			console.error("Packaged GUI smoke failed; inspect failure artifacts");
			process.exitCode = 1;
		});
}
