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
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";
import { type AppState, createDefaultAppState } from "./schemas";
import {
	AppStateValidationError,
	normalizeAppState,
	parseAppStateJson,
} from "./validation";
import {
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
}

export interface AppStateBindingReconciliationInput {
	stateTrust: "trusted" | "recovered" | "untrusted";
	durablePanes: ReadonlyArray<{
		paneId: string;
		provider: "claude" | "codex" | null;
		workspaceId?: string;
	}>;
	unresolvedWorkspaceIds?: ReadonlySet<string>;
}

export interface AppStateBindingReconciliationDependencies {
	resolveLocalWorkspaceId: (
		canonical: string,
		embeddedMeta?: {
			mainRepoPath: string;
			branch: string;
			type: string;
		},
		options?: { autoCreate?: boolean },
	) => string | null;
	getCanonicalForLocalWorkspaceId: (
		workspaceId: string,
	) => { canonical: string } | null;
	getRemoteWorkspaceIds: () => ReadonlySet<string>;
	reconcileBindings: (input: AppStateBindingReconciliationInput) => unknown;
}

export type AppStateBindingReconciliationOutcome =
	| { status: "completed"; result: unknown }
	| { status: "deferred"; warning: string }
	| { status: "failed"; warning: string };

export interface InitAppStateOptions {
	homeDir?: string;
	deviceIdFactory?: () => string;
	now?: () => number;
	readStateFile?: (path: string) => Promise<string>;
	onDiagnosticEvent?: (event: AppStateDiagnosticEvent) => void;
	reconciliation?: AppStateBindingReconciliationDependencies | false;
}

let _coordinator: AppStateMutationCoordinator | null = null;
let _deviceId: string | null = null;
let _loadResult: AppStateLoadResult | null = null;
let _initializing: Promise<AppStateLoadResult> | null = null;

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
		Pick<InitAppStateOptions, "onDiagnosticEvent">,
	deviceId: string,
): Promise<{
	result: AppStateLoadResult;
	writesEnabled: boolean;
}> {
	const path = join(options.homeDir, APP_STATE_FILE_NAME);
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
		await writeAppStateAtomically(path, state);
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
		const sanitizedState: AppState = {
			...state,
			tabsState: sanitizeSubscriptionProfilesForPersistence({
				state: state.tabsState,
			}),
		};
		return {
			result: { source: "loaded", trust: "trusted", state: sanitizedState },
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
		await writeAppStateAtomically(path, recoveredState);
		emitDiagnosticEvent(options.onDiagnosticEvent, {
			type: "app-state-recovered",
			reason: source,
			quarantineFile,
		});
		return {
			result: {
				source,
				trust: "recovered",
				state: recoveredState,
				quarantineFile,
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

export async function reconcileLoadedAppStateBindings(
	loadResult: AppStateLoadResult,
	dependencies?: AppStateBindingReconciliationDependencies,
): Promise<AppStateBindingReconciliationOutcome> {
	if (loadResult.trust !== "trusted") {
		return {
			status: "deferred",
			warning:
				"Provider account binding cleanup was deferred because app state is not trusted.",
		};
	}

	try {
		const deps = dependencies ?? (await defaultReconciliationDependencies());
		const state = loadResult.state;
		const remoteWorkspaceIds = deps.getRemoteWorkspaceIds();
		const localizedWorkspaceIds = new Map<string, string>();
		const unresolvedWorkspaceIds = new Set<string>();

		for (const tab of state.tabsState.tabs) {
			const workspaceId = tab.workspaceId;
			if (
				localizedWorkspaceIds.has(workspaceId) ||
				unresolvedWorkspaceIds.has(workspaceId)
			) {
				continue;
			}
			if (remoteWorkspaceIds.has(workspaceId)) {
				localizedWorkspaceIds.set(workspaceId, workspaceId);
				continue;
			}

			const canonical = state.sync.localToCanonical[workspaceId];
			if (canonical) {
				const localWorkspaceId = deps.resolveLocalWorkspaceId(
					canonical,
					state.sync.workspaceMetadata[canonical],
					{ autoCreate: false },
				);
				if (localWorkspaceId) {
					localizedWorkspaceIds.set(workspaceId, localWorkspaceId);
				} else {
					unresolvedWorkspaceIds.add(workspaceId);
				}
				continue;
			}

			if (deps.getCanonicalForLocalWorkspaceId(workspaceId)) {
				localizedWorkspaceIds.set(workspaceId, workspaceId);
			} else {
				unresolvedWorkspaceIds.add(workspaceId);
			}
		}

		const workspaceIdByTabId = new Map(
			state.tabsState.tabs.map((tab) => [tab.id, tab.workspaceId] as const),
		);
		const durablePanes = Object.values(state.tabsState.panes).map((pane) => {
			const writerWorkspaceId = workspaceIdByTabId.get(pane.tabId);
			const workspaceId = writerWorkspaceId
				? (localizedWorkspaceIds.get(writerWorkspaceId) ?? writerWorkspaceId)
				: undefined;
			const isRemote = Boolean(
				workspaceId && remoteWorkspaceIds.has(workspaceId),
			);
			const provider =
				!isRemote &&
				pane.type === "terminal" &&
				(pane.agentRuntime === "claude" || pane.agentRuntime === "codex")
					? pane.agentRuntime
					: null;
			return { paneId: pane.id, provider, workspaceId };
		});

		const result = deps.reconcileBindings({
			stateTrust: "trusted",
			durablePanes,
			unresolvedWorkspaceIds,
		});
		return { status: "completed", result };
	} catch {
		return {
			status: "failed",
			warning:
				"Provider account binding cleanup failed and was safely deferred.",
		};
	}
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
		},
		deviceId,
	);

	const writeCommittedState = async (state: AppState): Promise<void> => {
		if (!writesEnabled) {
			throw new Error(
				"App-state writes are disabled because recovery could not preserve the source file.",
			);
		}
		await writeAppStateAtomically(appStatePath, state);
	};
	_coordinator = new AppStateMutationCoordinator(result.state, {
		validate: (state) => normalizeAppState(state, { deviceId }),
		write: writeCommittedState,
	});
	const reconciliation =
		options.reconciliation === false
			? { status: "deferred" as const, warning: "Disabled by test seam." }
			: await reconcileLoadedAppStateBindings(
					result,
					options.reconciliation || undefined,
				);
	_loadResult = { ...result, reconciliation };
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

export async function enqueueAppStateMutation<T>(
	label: string,
	mutate: AppStateMutator<T>,
): Promise<AppStateMutationCommit<T>> {
	if (!_coordinator) {
		throw new Error("App state not initialized. Call initAppState() first.");
	}
	return _coordinator.enqueue(label, mutate);
}

/** @internal Test seam. */
export function resetAppStateForTests(): void {
	_coordinator = null;
	_deviceId = null;
	_loadResult = null;
	_initializing = null;
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
