import { timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ElectronTrpcContext } from "lib/trpc";
import { publicProcedure, router } from "lib/trpc";
import { z } from "zod/v4";

export const PACKAGED_SMOKE_OUTPUT_NAME = "packaged-smoke-result.json";
export const PACKAGED_SMOKE_INTERNAL_TIMEOUT_MS = 75_000;
export const PACKAGED_SMOKE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const launchSchema = z.union([z.literal(1), z.literal(2)]);
const tokenSchema = z.string().refine(isValidToken, {
	message: "Expected a 32-byte lowercase hex token",
});

const PACKAGED_SMOKE_ROOT_PATTERN = /^ade-packaged-gui-[A-Za-z0-9]{6}$/;

const packagedSmokeChecksSchema = z
	.object({
		rendererReady: z.boolean(),
		bootErrorFree: z.boolean(),
		stateHydrated: z.boolean(),
		sixPanesCreated: z.boolean(),
		seventhPaneRejected: z.boolean(),
		claudeAccountMarker: z.boolean(),
		codexAccountMarker: z.boolean(),
		healthQueryCompleted: z.boolean(),
		updateAssetSelected: z.boolean(),
		statePersisted: z.boolean(),
	})
	.strict();

export type PackagedSmokeChecks = z.infer<typeof packagedSmokeChecksSchema>;

const packagedSmokeCommandSchema = z.discriminatedUnion("command", [
	z
		.object({
			command: z.literal("begin"),
			launch: launchSchema,
			token: tokenSchema,
		})
		.strict(),
	z
		.object({
			command: z.literal("complete"),
			launch: launchSchema,
			token: tokenSchema,
			checks: packagedSmokeChecksSchema,
		})
		.strict(),
]);

export type PackagedSmokeCommand = z.infer<typeof packagedSmokeCommandSchema>;

export interface PackagedSmokeStartup {
	home: string;
	root: string;
	launch: 1 | 2;
	outputPath: string;
	token: string;
}

export interface PackagedSmokeResult {
	schemaVersion: 1;
	kind: "ade-packaged-gui-smoke";
	launch: 1 | 2;
	status: "passed" | "failed";
	completedAt: string;
	runtime: {
		platform: string;
		arch: string;
	};
	checks: PackagedSmokeChecks;
}

export interface PackagedSmokeCaller {
	senderId: number;
	isMainFrame: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function isValidToken(token: string): boolean {
	return PACKAGED_SMOKE_TOKEN_PATTERN.test(token);
}

function canonicalDirectory(value: string | undefined): string | null {
	if (!value || !isAbsolute(value)) return null;
	try {
		const stat = lstatSync(value);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
		const canonical = realpathSync.native(value);
		return resolve(value) === canonical ? canonical : null;
	} catch {
		return null;
	}
}

function outputDoesNotExist(outputPath: string): boolean {
	try {
		lstatSync(outputPath);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

export function canonicalizePackagedSmokeTempDirectory(
	value: string = tmpdir(),
	realpath: (value: string) => string = realpathSync.native,
): string | null {
	if (!isAbsolute(value)) return null;
	try {
		return realpath(value);
	} catch {
		return null;
	}
}

function isExpectedPackagedSmokeRoot(root: string): boolean {
	const canonicalTempDirectory = canonicalizePackagedSmokeTempDirectory();
	return (
		canonicalTempDirectory !== null &&
		dirname(root) === canonicalTempDirectory &&
		PACKAGED_SMOKE_ROOT_PATTERN.test(basename(root))
	);
}

/**
 * Read the fail-closed startup contract. Normal production processes never
 * register the smoke-only router because every dedicated condition is required.
 */
export function readPackagedSmokeStartup(
	environment: Environment = process.env,
	options: { isPackaged?: boolean } = {},
): PackagedSmokeStartup | null {
	if (
		options.isPackaged !== true ||
		environment.NODE_ENV !== "production" ||
		environment.ADE_PACKAGED_SMOKE !== "1" ||
		environment.ADE_DISABLE_PROTOCOL_REGISTRATION !== "1" ||
		environment.ADE_ENABLE_DESKTOP_AUTOMATION !== undefined ||
		environment.ELECTRON_RUN_AS_NODE !== undefined ||
		environment.NODE_OPTIONS !== undefined
	) {
		return null;
	}

	const token = environment.ADE_PACKAGED_SMOKE_TOKEN;
	const root = canonicalDirectory(environment.ADE_PACKAGED_SMOKE_ROOT);
	const home = canonicalDirectory(environment.ADE_HOME_DIR);
	const outputPath = environment.ADE_PACKAGED_SMOKE_OUTPUT;
	const launch = Number(environment.ADE_PACKAGED_SMOKE_LAUNCH);
	if (
		!token ||
		!isValidToken(token) ||
		!root ||
		!isExpectedPackagedSmokeRoot(root) ||
		!home ||
		!outputPath ||
		!isAbsolute(outputPath) ||
		(launch !== 1 && launch !== 2) ||
		home !== join(root, "ade-home") ||
		resolve(outputPath) !== join(home, PACKAGED_SMOKE_OUTPUT_NAME) ||
		dirname(resolve(outputPath)) !== home ||
		!outputDoesNotExist(outputPath)
	) {
		return null;
	}

	return {
		home,
		root,
		launch,
		outputPath: resolve(outputPath),
		token,
	};
}

let activeStartup: PackagedSmokeStartup | null | undefined;

export function scrubPackagedSmokeEnvironment(
	environment: NodeJS.ProcessEnv,
): void {
	for (const key of [
		"ADE_PACKAGED_SMOKE",
		"ADE_PACKAGED_SMOKE_TOKEN",
		"ADE_PACKAGED_SMOKE_LAUNCH",
		"ADE_PACKAGED_SMOKE_ROOT",
		"ADE_PACKAGED_SMOKE_OUTPUT",
	]) {
		delete environment[key];
	}
}

/** Capture once in bootstrap, then remove every packaged-smoke credential. */
export function consumePackagedSmokeStartup(options: {
	environment?: NodeJS.ProcessEnv;
	isPackaged: boolean;
}): PackagedSmokeStartup | null {
	if (activeStartup !== undefined) return activeStartup;
	const environment = options.environment ?? process.env;
	activeStartup = readPackagedSmokeStartup(environment, options);
	scrubPackagedSmokeEnvironment(environment);
	return activeStartup;
}

export function getActivePackagedSmokeStartup(): PackagedSmokeStartup | null {
	return activeStartup ?? null;
}

export function getPackagedSmokeWindowQuery(
	startup: PackagedSmokeStartup,
): Record<string, string> {
	return {
		adePackagedSmoke: "1",
		adePackagedSmokeLaunch: String(startup.launch),
		adePackagedSmokeToken: startup.token,
	};
}

export function parsePackagedSmokeCommand(
	value: unknown,
): PackagedSmokeCommand {
	return packagedSmokeCommandSchema.parse(value);
}

function tokensMatch(actual: string, expected: string): boolean {
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(
		Buffer.from(actual, "utf8"),
		Buffer.from(expected, "utf8"),
	);
}

async function writeResultAtomically(
	outputPath: string,
	result: PackagedSmokeResult,
): Promise<void> {
	const temporaryPath = `${outputPath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	await rename(temporaryPath, outputPath);
}

function failingChecks(): PackagedSmokeChecks {
	return {
		rendererReady: false,
		bootErrorFree: false,
		stateHydrated: false,
		sixPanesCreated: false,
		seventhPaneRejected: false,
		claudeAccountMarker: false,
		codexAccountMarker: false,
		healthQueryCompleted: false,
		updateAssetSelected: false,
		statePersisted: false,
	};
}

export interface PackagedSmokeController {
	handle: (
		command: PackagedSmokeCommand,
		caller: PackagedSmokeCaller,
	) => Promise<{ platform: string; arch: string } | { accepted: true }>;
	fail: () => Promise<void>;
}

export function createPackagedSmokeController(options: {
	startup: PackagedSmokeStartup;
	authorizedSenderId: number;
	platform?: string;
	arch?: string;
	now?: () => Date;
	writeResult?: (
		outputPath: string,
		result: PackagedSmokeResult,
	) => Promise<void>;
	scheduleExit: (code: number) => void;
	setTimer?: (
		callback: () => void,
		durationMs: number,
	) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}): PackagedSmokeController {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const now = options.now ?? (() => new Date());
	const writeResult = options.writeResult ?? writeResultAtomically;
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? clearTimeout;
	let state: "armed" | "running" | "settled" = "armed";
	let timer: ReturnType<typeof setTimeout> | null = null;
	let expectedToken = options.startup.token;

	const authorize = (
		command: PackagedSmokeCommand,
		caller: PackagedSmokeCaller,
	) => {
		if (
			caller.senderId !== options.authorizedSenderId ||
			!caller.isMainFrame ||
			command.launch !== options.startup.launch ||
			!tokensMatch(command.token, expectedToken)
		) {
			throw new Error("Unauthorized packaged smoke command");
		}
	};

	const settle = async (checks: PackagedSmokeChecks): Promise<void> => {
		if (state === "settled") return;
		state = "settled";
		expectedToken = "";
		options.startup.token = "";
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		const passed = Object.values(checks).every(Boolean);
		const result: PackagedSmokeResult = {
			schemaVersion: 1,
			kind: "ade-packaged-gui-smoke",
			launch: options.startup.launch,
			status: passed ? "passed" : "failed",
			completedAt: now().toISOString(),
			runtime: { platform, arch },
			checks,
		};
		try {
			await writeResult(options.startup.outputPath, result);
		} finally {
			options.scheduleExit(passed ? 0 : 1);
		}
	};

	return {
		async handle(rawCommand, caller) {
			const command = parsePackagedSmokeCommand(rawCommand);
			if (state === "settled") {
				throw new Error("Packaged smoke launch already settled");
			}
			authorize(command, caller);

			if (command.command === "begin") {
				if (state !== "armed") {
					throw new Error(
						state === "running"
							? "Packaged smoke launch already begun"
							: "Packaged smoke launch already settled",
					);
				}
				state = "running";
				timer = setTimer(() => {
					void settle(failingChecks());
				}, PACKAGED_SMOKE_INTERNAL_TIMEOUT_MS);
				timer.unref?.();
				return { platform, arch };
			}

			if (state !== "running") {
				throw new Error(
					state === "armed"
						? "Packaged smoke launch has not begun"
						: "Packaged smoke launch already settled",
				);
			}
			await settle(command.checks);
			return { accepted: true };
		},
		fail: () => settle(failingChecks()),
	};
}

export function createPackagedSmokeRouter(controller: PackagedSmokeController) {
	return router({
		packagedSmoke: router({
			command: publicProcedure
				.input(packagedSmokeCommandSchema)
				.mutation(({ input, ctx }) =>
					controller.handle(input, {
						senderId: (ctx as ElectronTrpcContext).senderId ?? -1,
						isMainFrame: (ctx as ElectronTrpcContext).isMainFrame === true,
					}),
				),
		}),
	});
}

export type PackagedSmokeRouter = ReturnType<typeof createPackagedSmokeRouter>;
