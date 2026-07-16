import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import type { PeerClaudeSessionHandoff } from "shared/tabs-sync";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";
import {
	type AppStateBindingReconciliationDependencies,
	type AppStateBindingReconciliationOutcome,
	prepareAppStateForStartup,
} from "./reconciliation";
import { type AppState, createDefaultAppState } from "./schemas";
import {
	AppStateValidationError,
	normalizeAppState,
	parseAppStateJson,
} from "./validation";
import {
	type AppStateConditionalMutationCommit,
	type AppStateMutationCommit,
	AppStateMutationCoordinator,
	type AppStateMutator,
	writeAppStateAtomically,
} from "./write-queue";

const APP_STATE_FILE_NAME = "app-state.json";
const DEVICE_ID_FILE_NAME = "device-id";
const QUARANTINE_PREFIX = "app-state.quarantine.";
const MAX_QUARANTINE_FILES = 3;

interface AppStateDB {
	readonly data: AppState;
}

export type AppStateTrust = "trusted" | "recovered" | "untrusted";
export type AppStateLoadSource =
	| "loaded"
	| "first-run"
	| "invalid-json"
	| "invalid-shape"
	| "read-failure";

export interface AppStateDiagnosticEvent {
	type: "app-state-recovered" | "app-state-recovery-deferred";
	reason: Exclude<AppStateLoadSource, "loaded" | "first-run">;
	quarantineFile?: string;
}

export interface AppStateLoadResult {
	source: AppStateLoadSource;
	trust: AppStateTrust;
	state: AppState;
	quarantineFile?: string;
	reconciliation?: AppStateBindingReconciliationOutcome;
	startupWarnings?: string[];
}

export type {
	AppStateBindingReconciliationDependencies,
	AppStateBindingReconciliationInput,
	AppStateBindingReconciliationOutcome,
} from "./reconciliation";

export interface InitAppStateOptions {
	homeDir?: string;
	deviceIdFactory?: () => string;
	now?: () => number;
	readStateFile?: (path: string) => Promise<string>;
	onDiagnosticEvent?: (event: AppStateDiagnosticEvent) => void;
	reconciliation?: AppStateBindingReconciliationDependencies | false;
	persistStartupPeerHandoff?: (
		handoff: PeerClaudeSessionHandoff,
	) => Promise<void>;
	beforeOverwrite?: (displacedPath: string) => Promise<void>;
	/** @internal Test seam for deterministic promotion races. */
	writeStateAtomically?: typeof writeAppStateAtomically;
}

let _coordinator: AppStateMutationCoordinator | null = null;
let _deviceId: string | null = null;
let _loadResult: AppStateLoadResult | null = null;
let _initializing: Promise<AppStateLoadResult> | null = null;
let _startupPeerPaneIds = new Set<string>();

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === code
	);
}

async function ensurePrivateHome(homeDir: string): Promise<void> {
	await mkdir(homeDir, { recursive: true, mode: SUPERSET_HOME_DIR_MODE });
	await chmod(homeDir, SUPERSET_HOME_DIR_MODE).catch(() => undefined);
}

async function loadOrCreateDeviceId(
	homeDir: string,
	deviceIdFactory: () => string,
): Promise<string> {
	const path = join(homeDir, DEVICE_ID_FILE_NAME);
	try {
		const value = (await readFile(path, "utf8")).trim();
		if (value.length > 0) return value;
	} catch (error) {
		if (!isErrno(error, "ENOENT")) {
			console.warn("[app-state] Failed to read device identity; regenerating.");
		}
	}

	const id = deviceIdFactory();
	try {
		await writeFile(path, id, {
			encoding: "utf8",
			mode: SUPERSET_SENSITIVE_FILE_MODE,
		});
		await chmod(path, SUPERSET_SENSITIVE_FILE_MODE).catch(() => undefined);
	} catch {
		console.error("[app-state] Failed to persist device identity.");
	}
	return id;
}

async function listQuarantineFiles(homeDir: string): Promise<string[]> {
	const entries = await readdir(homeDir, { withFileTypes: true });
	return entries
		.filter(
			(entry) => entry.isFile() && entry.name.startsWith(QUARANTINE_PREFIX),
		)
		.map((entry) => entry.name)
		.sort();
}

async function trimQuarantineFiles(
	homeDir: string,
	maximum: number,
): Promise<void> {
	const files = await listQuarantineFiles(homeDir);
	const excess = files.slice(0, Math.max(0, files.length - maximum));
	for (const file of excess) {
		await rm(join(homeDir, file), { force: true });
	}
}

async function quarantineStateFile(
	path: string,
	homeDir: string,
	now: () => number,
): Promise<string> {
	await trimQuarantineFiles(homeDir, MAX_QUARANTINE_FILES - 1);
	const quarantineFile = `${QUARANTINE_PREFIX}${String(now()).padStart(13, "0")}.${randomUUID()}.json`;
	await rename(path, join(homeDir, quarantineFile));
	await trimQuarantineFiles(homeDir, MAX_QUARANTINE_FILES);
	return quarantineFile;
}

function classifyValidationFailure(
	error: unknown,
): "invalid-json" | "invalid-shape" {
	return error instanceof AppStateValidationError &&
		error.code === "invalid-json"
		? "invalid-json"
		: "invalid-shape";
}

function emitDiagnosticEvent(
	listener: InitAppStateOptions["onDiagnosticEvent"],
	event: AppStateDiagnosticEvent,
): void {
	try {
		listener?.(event);
	} catch {
		console.warn("[app-state] Diagnostic event observer failed.");
	}
}

async function loadAppState(
	options: Required<
		Pick<
			InitAppStateOptions,
			"homeDir" | "deviceIdFactory" | "now" | "readStateFile"
		>
	> &
		Pick<
			InitAppStateOptions,
			"beforeOverwrite" | "onDiagnosticEvent" | "writeStateAtomically"
		>,
	deviceId: string,
): Promise<{
	result: AppStateLoadResult;
	writesEnabled: boolean;
}> {
	const path = join(options.homeDir, APP_STATE_FILE_NAME);
	const writeStateAtomically =
		options.writeStateAtomically ?? writeAppStateAtomically;
	let exists = true;
	try {
		await lstat(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			exists = false;
		} else {
			return {
				result: {
					source: "read-failure",
					trust: "untrusted",
					state: createDefaultAppState(deviceId),
				},
				writesEnabled: false,
			};
		}
	}

	if (!exists) {
		const state = createDefaultAppState(deviceId);
		await writeStateAtomically(path, state, {
			beforeOverwrite: options.beforeOverwrite,
		});
		return {
			result: { source: "first-run", trust: "untrusted", state },
			writesEnabled: true,
		};
	}

	let source: "invalid-json" | "invalid-shape" | "read-failure" =
		"read-failure";
	let state: AppState | null = null;
	try {
		const raw = await options.readStateFile(path);
		try {
			state = parseAppStateJson(raw, { deviceId });
		} catch (error) {
			source = classifyValidationFailure(error);
		}
	} catch {
		source = "read-failure";
	}

	if (state) {
		return {
			result: { source: "loaded", trust: "trusted", state },
			writesEnabled: true,
		};
	}

	const recoveredState = createDefaultAppState(deviceId);
	try {
		const quarantineFile = await quarantineStateFile(
			path,
			options.homeDir,
			options.now,
		);
		const quarantinePath = join(options.homeDir, quarantineFile);
		const quarantinedRaw = await readFile(quarantinePath, "utf8");
		let quarantineCandidateIsValid = false;
		try {
			parseAppStateJson(quarantinedRaw, { deviceId });
			quarantineCandidateIsValid = true;
		} catch (error) {
			if (!(error instanceof AppStateValidationError)) throw error;
		}
		if (quarantineCandidateIsValid) {
			if (!options.beforeOverwrite) {
				throw new Error(
					"A valid app-state replacement could not be captured during recovery.",
				);
			}
			await options.beforeOverwrite(quarantinePath);
		}
		await writeStateAtomically(path, recoveredState, {
			beforeOverwrite: options.beforeOverwrite,
		});
		if (quarantineCandidateIsValid) {
			await rm(quarantinePath, { force: true }).catch(() => undefined);
		}
		const retainedQuarantineFile = quarantineCandidateIsValid
			? undefined
			: quarantineFile;
		emitDiagnosticEvent(options.onDiagnosticEvent, {
			type: "app-state-recovered",
			reason: source,
			...(retainedQuarantineFile
				? { quarantineFile: retainedQuarantineFile }
				: {}),
		});
		return {
			result: {
				source,
				trust: "recovered",
				state: recoveredState,
				...(retainedQuarantineFile
					? { quarantineFile: retainedQuarantineFile }
					: {}),
			},
			writesEnabled: true,
		};
	} catch {
		emitDiagnosticEvent(options.onDiagnosticEvent, {
			type: "app-state-recovery-deferred",
			reason: source,
		});
		return {
			result: {
				source,
				trust: "untrusted",
				state: recoveredState,
			},
			writesEnabled: false,
		};
	}
}

async function defaultReconciliationDependencies(): Promise<AppStateBindingReconciliationDependencies> {
	const [subscriptionProfiles, workspaceIdentity, localDatabase, schema] =
		await Promise.all([
			import("../subscription-profiles"),
			import("../sync/workspace-identity"),
			import("../local-db"),
			import("@superset/local-db"),
		]);
	return {
		resolveLocalWorkspaceId: workspaceIdentity.resolveLocalWorkspaceId,
		getCanonicalForLocalWorkspaceId:
			workspaceIdentity.getCanonicalForLocalWorkspaceId,
		getRemoteWorkspaceIds: () =>
			new Set(
				localDatabase.localDb
					.select({ workspaceId: schema.remoteWorkspaceBindings.workspaceId })
					.from(schema.remoteWorkspaceBindings)
					.all()
					.map(({ workspaceId }) => workspaceId),
			),
		reconcileBindings:
			subscriptionProfiles.reconcileSubscriptionProfilePaneBindings,
	};
}

interface PreparedLoadedAppState {
	state: AppState;
	reconciliation: AppStateBindingReconciliationOutcome;
	startupPeerPaneIds: string[];
	startupPeerClaudeSessionHandoffs: PeerClaudeSessionHandoff[];
}

function sanitizeLoadedAppState(state: AppState): AppState {
	return {
		...state,
		tabsState: sanitizeSubscriptionProfilesForPersistence({
			state: state.tabsState,
		}),
	};
}

async function prepareLoadedAppStateBindings(
	loadResult: AppStateLoadResult,
	localDeviceId: string,
	dependencies?: AppStateBindingReconciliationDependencies,
): Promise<PreparedLoadedAppState> {
	let deps = dependencies;
	try {
		deps ??= await defaultReconciliationDependencies();
	} catch {
		deps = {
			resolveLocalWorkspaceId: () => {
				throw new Error("Workspace identity unavailable");
			},
			getCanonicalForLocalWorkspaceId: () => {
				throw new Error("Workspace identity unavailable");
			},
			getRemoteWorkspaceIds: () => {
				throw new Error("Workspace identity unavailable");
			},
			reconcileBindings: () => {
				throw new Error("Binding metadata unavailable");
			},
		};
	}
	const prepared = prepareAppStateForStartup({
		state: loadResult.state,
		trust: loadResult.trust,
		localDeviceId,
		dependencies: deps,
	});
	return {
		state: prepared.state,
		reconciliation: prepared.outcome,
		startupPeerPaneIds: prepared.startupPeerPaneIds,
		startupPeerClaudeSessionHandoffs: prepared.startupPeerClaudeSessionHandoffs,
	};
}

export async function reconcileLoadedAppStateBindings(
	loadResult: AppStateLoadResult,
	dependencies?: AppStateBindingReconciliationDependencies,
): Promise<AppStateBindingReconciliationOutcome> {
	return (
		await prepareLoadedAppStateBindings(
			loadResult,
			_deviceId ?? loadResult.state.sync.deviceId,
			dependencies,
		)
	).reconciliation;
}

async function initialize(
	options: InitAppStateOptions,
): Promise<AppStateLoadResult> {
	const homeDir = options.homeDir ?? SUPERSET_HOME_DIR;
	await ensurePrivateHome(homeDir);
	const deviceId = await loadOrCreateDeviceId(
		homeDir,
		options.deviceIdFactory ?? randomUUID,
	);
	_deviceId = deviceId;
	const appStatePath = join(homeDir, APP_STATE_FILE_NAME);
	const { result, writesEnabled } = await loadAppState(
		{
			homeDir,
			deviceIdFactory: options.deviceIdFactory ?? randomUUID,
			now: options.now ?? Date.now,
			readStateFile:
				options.readStateFile ?? ((path) => readFile(path, "utf8")),
			onDiagnosticEvent: options.onDiagnosticEvent,
			beforeOverwrite: options.beforeOverwrite,
			writeStateAtomically: options.writeStateAtomically,
		},
		deviceId,
	);

	const prepared =
		options.reconciliation === false
			? {
					state:
						result.trust === "trusted"
							? sanitizeLoadedAppState(result.state)
							: result.state,
					reconciliation: {
						status: "deferred" as const,
						warning: "Disabled by test seam.",
					},
					startupPeerPaneIds: [],
					startupPeerClaudeSessionHandoffs: [],
				}
			: await prepareLoadedAppStateBindings(
					result,
					deviceId,
					options.reconciliation || undefined,
				);
	const startupWarnings: string[] = [];
	const persistStartupPeerHandoff =
		options.persistStartupPeerHandoff ??
		(async (handoff: PeerClaudeSessionHandoff) => {
			const { writeClaudeSessionIdToHistory } = await import(
				"../terminal-history"
			);
			await writeClaudeSessionIdToHistory(
				handoff.workspaceId,
				handoff.paneId,
				handoff.claudeSessionId,
			);
		});
	for (const handoff of prepared.startupPeerClaudeSessionHandoffs) {
		try {
			await persistStartupPeerHandoff(handoff);
		} catch {
			const warning = "A peer Claude session could not be staged for startup.";
			if (!startupWarnings.includes(warning)) startupWarnings.push(warning);
			console.warn(`[app-state] ${warning}`);
		}
	}
	_startupPeerPaneIds = new Set(prepared.startupPeerPaneIds);
	const preparedResult = { ...result, state: prepared.state };
	const writeCommittedState = async (state: AppState): Promise<void> => {
		if (!writesEnabled) {
			throw new Error(
				"App-state writes are disabled because recovery could not preserve the source file.",
			);
		}
		await (options.writeStateAtomically ?? writeAppStateAtomically)(
			appStatePath,
			state,
			{
				beforeOverwrite: options.beforeOverwrite,
			},
		);
	};
	_coordinator = new AppStateMutationCoordinator(preparedResult.state, {
		validate: (state) => normalizeAppState(state, { deviceId }),
		write: writeCommittedState,
	});
	_loadResult = {
		...preparedResult,
		reconciliation: prepared.reconciliation,
		...(startupWarnings.length > 0 ? { startupWarnings } : {}),
	};
	console.log(
		`App state initialized (source=${result.source}, trust=${result.trust}, deviceId=${deviceId.slice(0, 8)}...).`,
	);
	return _loadResult;
}

export async function initAppState(
	options: InitAppStateOptions = {},
): Promise<AppStateLoadResult> {
	if (_loadResult) return _loadResult;
	_initializing ??= initialize(options);
	try {
		return await _initializing;
	} finally {
		_initializing = null;
	}
}

export function getDeviceId(): string {
	if (!_deviceId) {
		throw new Error("Device ID not initialized. Call initAppState() first.");
	}
	return _deviceId;
}

export function getAppStateSnapshot(): AppState {
	if (!_coordinator) {
		throw new Error("App state not initialized. Call initAppState() first.");
	}
	return _coordinator.getSnapshot();
}

export function getAppStateRevision(): number {
	if (!_coordinator) {
		if (_initializing && _deviceId) return 0;
		throw new Error("App state not initialized. Call initAppState() first.");
	}
	return _coordinator.getRevision();
}

/**
 * Drains one-time peer-origin markers for renderer hydration. The markers are
 * deliberately kept outside persisted app state so they cannot echo to peers.
 */
export function takeStartupPeerPaneIds(): string[] {
	const paneIds = [..._startupPeerPaneIds].sort();
	_startupPeerPaneIds.clear();
	return paneIds;
}

export async function enqueueAppStateMutation<T>(
	label: string,
	mutate: AppStateMutator<T>,
): Promise<AppStateMutationCommit<T>> {
	if (!_coordinator) {
		throw new Error("App state not initialized. Call initAppState() first.");
	}
	return _coordinator.enqueue(label, mutate);
}

export async function enqueueAppStateMutationAtRevision<T>(
	label: string,
	expectedRevision: number,
	mutate: AppStateMutator<T>,
): Promise<AppStateConditionalMutationCommit<T>> {
	if (!_coordinator) {
		throw new Error("App state not initialized. Call initAppState() first.");
	}
	return _coordinator.enqueueAtRevision(label, expectedRevision, mutate);
}

/** @internal Test seam. */
export function resetAppStateForTests(): void {
	_coordinator = null;
	_deviceId = null;
	_loadResult = null;
	_initializing = null;
	_startupPeerPaneIds.clear();
}

export const appState = new Proxy({} as AppStateDB, {
	get(_target, property) {
		if (!_coordinator) {
			throw new Error("App state not initialized. Call initAppState() first.");
		}
		if (property === "data") return _coordinator.getSnapshot();
		return undefined;
	},
});
