import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { resolveLocalPrivateRoot } from "./private-root";

export const BOOT_FAILURE_WINDOW_MS = 10 * 60 * 1_000;
export const SAFE_MODE_START_ATTEMPT_THRESHOLD = 3;
const BOOT_STATE_SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

interface PersistedBootState {
	schemaVersion: typeof BOOT_STATE_SCHEMA_VERSION;
	phase: "starting" | "ready";
	startedAt: number;
	incompleteStartedAt: number[];
}

export interface BootRuntimeStatus {
	phase: "starting" | "ready";
	safeMode: boolean;
	incompleteStarts: number;
	recoveredCorruptState: boolean;
}

export interface StartupCapabilities {
	appStateWatcher: boolean;
	autoUpdater: boolean;
	tray: boolean;
	terminalRestore: boolean;
	terminalPrewarm: boolean;
	sshTunnels: boolean;
	agentHooks: boolean;
	agentWatchers: boolean;
	notifications: boolean;
}

export interface CreateBootStateControllerOptions {
	filePath: string;
	now?: () => number;
}

export interface InitializeBootStateOptions {
	filePath?: string;
	now?: () => number;
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseBootState(raw: string): PersistedBootState {
	const value: unknown = JSON.parse(raw);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).some(
			(key) =>
				!new Set([
					"schemaVersion",
					"phase",
					"startedAt",
					"incompleteStartedAt",
				]).has(key),
		) ||
		(value as Partial<PersistedBootState>).schemaVersion !==
			BOOT_STATE_SCHEMA_VERSION ||
		!(["starting", "ready"] as const).includes(
			(value as Partial<PersistedBootState>).phase as "starting" | "ready",
		) ||
		!isNonNegativeSafeInteger(
			(value as Partial<PersistedBootState>).startedAt,
		) ||
		!Array.isArray(
			(value as Partial<PersistedBootState>).incompleteStartedAt,
		) ||
		!(value as PersistedBootState).incompleteStartedAt.every(
			isNonNegativeSafeInteger,
		)
	) {
		throw new Error("Invalid ADE boot-state file");
	}
	return value as PersistedBootState;
}

async function readPersistedState(
	filePath: string,
): Promise<{ state: PersistedBootState | null; corrupt: boolean }> {
	try {
		return {
			state: parseBootState(await readFile(filePath, "utf8")),
			corrupt: false,
		};
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { state: null, corrupt: false };
		return { state: null, corrupt: true };
	}
}

async function writePersistedState(
	filePath: string,
	state: PersistedBootState,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });
	const temporaryPath = join(
		dirname(filePath),
		`.${randomUUID()}.boot-state.tmp`,
	);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(temporaryPath, "wx", FILE_MODE);
		await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(temporaryPath, filePath);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function validateNow(now: number): number {
	if (!isNonNegativeSafeInteger(now)) {
		throw new Error("Boot timestamp must be a non-negative safe integer");
	}
	return now;
}

function readyState(now: number): PersistedBootState {
	return {
		schemaVersion: BOOT_STATE_SCHEMA_VERSION,
		phase: "ready",
		startedAt: now,
		incompleteStartedAt: [],
	};
}

export class BootStateController {
	private readonly filePath: string;
	private readonly now: () => number;
	private runtimeSafeMode = false;
	private status: BootRuntimeStatus = {
		phase: "ready",
		safeMode: false,
		incompleteStarts: 0,
		recoveredCorruptState: false,
	};

	constructor({ filePath, now = Date.now }: CreateBootStateControllerOptions) {
		this.filePath = filePath;
		this.now = now;
	}

	async markStarting(): Promise<BootRuntimeStatus> {
		const now = validateNow(this.now());
		const previous = await readPersistedState(this.filePath);
		const minimum = now - BOOT_FAILURE_WINDOW_MS;
		const incomplete = (previous.state?.incompleteStartedAt ?? []).filter(
			(timestamp) => timestamp >= minimum && timestamp <= now,
		);
		if (
			previous.state?.phase === "starting" &&
			previous.state.startedAt >= minimum &&
			previous.state.startedAt <= now
		) {
			incomplete.push(previous.state.startedAt);
		}
		const normalizedIncomplete = [...new Set(incomplete)].sort(
			(left, right) => left - right,
		);
		this.runtimeSafeMode =
			normalizedIncomplete.length + 1 >= SAFE_MODE_START_ATTEMPT_THRESHOLD;
		await writePersistedState(this.filePath, {
			schemaVersion: BOOT_STATE_SCHEMA_VERSION,
			phase: "starting",
			startedAt: now,
			incompleteStartedAt: normalizedIncomplete,
		});
		this.status = {
			phase: "starting",
			safeMode: this.runtimeSafeMode,
			incompleteStarts: normalizedIncomplete.length,
			recoveredCorruptState: previous.corrupt,
		};
		return this.getStatus();
	}

	async markRendererReady(): Promise<BootRuntimeStatus> {
		const now = validateNow(this.now());
		await writePersistedState(this.filePath, readyState(now));
		this.status = {
			phase: "ready",
			safeMode: this.runtimeSafeMode,
			incompleteStarts: 0,
			recoveredCorruptState: false,
		};
		return this.getStatus();
	}

	async prepareNormalModeRetry(): Promise<BootRuntimeStatus> {
		return this.markRendererReady();
	}

	getStatus(): BootRuntimeStatus {
		return { ...this.status };
	}

	isSafeMode(): boolean {
		return this.runtimeSafeMode;
	}
}

export function createBootStateController(
	options: CreateBootStateControllerOptions,
): BootStateController {
	return new BootStateController(options);
}

export function getStartupCapabilities(safeMode: boolean): StartupCapabilities {
	const enabled = !safeMode;
	return {
		appStateWatcher: enabled,
		autoUpdater: enabled,
		tray: enabled,
		terminalRestore: enabled,
		terminalPrewarm: enabled,
		sshTunnels: enabled,
		agentHooks: enabled,
		agentWatchers: enabled,
		notifications: enabled,
	};
}

function defaultBootStatePath(): string {
	return join(
		resolveLocalPrivateRoot({ adeHomeDir: SUPERSET_HOME_DIR }),
		"recovery",
		"boot-state.json",
	);
}

let runtimeController: BootStateController | null = null;

export async function initializeBootState(
	options: InitializeBootStateOptions = {},
): Promise<BootRuntimeStatus> {
	runtimeController = createBootStateController({
		filePath: options.filePath ?? defaultBootStatePath(),
		now: options.now,
	});
	return runtimeController.markStarting();
}

function requireRuntimeController(): BootStateController {
	if (!runtimeController) {
		throw new Error("Boot state has not been initialized");
	}
	return runtimeController;
}

export function markRendererReady(): Promise<BootRuntimeStatus> {
	return requireRuntimeController().markRendererReady();
}

export function prepareNormalModeRetry(): Promise<BootRuntimeStatus> {
	return requireRuntimeController().prepareNormalModeRetry();
}

export function getBootRuntimeStatus(): BootRuntimeStatus {
	return requireRuntimeController().getStatus();
}

export function isSafeRecoveryMode(): boolean {
	return requireRuntimeController().isSafeMode();
}

/** @internal */
export function resetBootStateForTests(): void {
	runtimeController = null;
}
