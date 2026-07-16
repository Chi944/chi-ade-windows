import { randomUUID } from "node:crypto";
import {
	lstat,
	open,
	readdir,
	readFile,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { SUPERSET_HOME_DIR } from "../app-environment";
import type { AppState } from "../app-state/schemas";
import { createDefaultAppState } from "../app-state/schemas";
import { parseAppStateJson } from "../app-state/validation";
import { ensurePrivateDiagnosticsDirectory } from "./logger";
import { resolveLocalPrivateRoot } from "./private-root";

const APP_STATE_SNAPSHOT_LIMIT = 3;
const DATABASE_SNAPSHOT_LIMIT = 2;
const APP_STATE_CAPTURE_MAX_ATTEMPTS = 3;
const FILE_MODE = 0o600;
const STATE_EXTENSION = ".app-state.json";
const DATABASE_EXTENSION = ".local.db";
const SNAPSHOT_NAME_PATTERN =
	/^recovery-[0-9]{16}-[A-Za-z0-9_-]+\.(app-state\.json|local\.db)$/;

export type RecoverySnapshotReason =
	| "manual"
	| "update"
	| "before-restore"
	| "before-reset";

export interface RecoverySnapshot {
	appStatePath: string;
	databasePath?: string;
}

export interface RecoveryStatus {
	hasAppStateSnapshot: boolean;
	appStateSnapshotCount: number;
	databaseSnapshotCount: number;
}

export interface RecoveryManagerDependencies {
	recoveryRoot: string;
	getAppStateSnapshot: () => unknown;
	getAppStateRevision: () => number;
	validateSerializedAppState: (serialized: string) => unknown;
	replaceAppStateAtRevision: (
		state: unknown,
		expectedRevision: number,
	) => Promise<"committed" | "stale">;
	createDefaultAppState: () => unknown;
	backupDatabase: (destination: string) => Promise<void>;
	databaseExists: () => Promise<boolean>;
	now?: () => number;
	createId?: () => string;
}

interface RevisionedRecoverySnapshot extends RecoverySnapshot {
	appStateRevision: number;
}

function captureRevisionedAppState(
	dependencies: Pick<
		RecoveryManagerDependencies,
		"getAppStateRevision" | "getAppStateSnapshot"
	>,
): { state: unknown; revision: number } {
	for (
		let attempt = 0;
		attempt < APP_STATE_CAPTURE_MAX_ATTEMPTS;
		attempt += 1
	) {
		const revisionBefore = dependencies.getAppStateRevision();
		const state = dependencies.getAppStateSnapshot();
		const revisionAfter = dependencies.getAppStateRevision();
		if (revisionBefore === revisionAfter) {
			return { state, revision: revisionAfter };
		}
	}
	throw new Error(
		"App state changed repeatedly while the recovery snapshot was being captured",
	);
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}

async function safeRemove(path: string): Promise<void> {
	try {
		const entry = await lstat(path);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			await rmdir(path);
		} else {
			await unlink(path);
		}
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
	}
}

async function assertRegularNonLinkFile(
	path: string,
	label: string,
): Promise<void> {
	let entry: Awaited<ReturnType<typeof lstat>>;
	try {
		entry = await lstat(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) throw new Error(`${label} is missing`);
		throw error;
	}
	if (entry.isSymbolicLink()) {
		throw new Error(`Refusing to use a symbolic link or junction as ${label}`);
	}
	if (!entry.isFile()) throw new Error(`${label} is not a regular file`);
}

async function finalizeDatabasePart(path: string): Promise<void> {
	await assertRegularNonLinkFile(
		path,
		"database recovery snapshot partial file",
	);
	const handle = await open(path, "r+");
	try {
		const entry = await handle.stat();
		if (!entry.isFile()) {
			throw new Error(
				"Database recovery snapshot partial file is not a regular file",
			);
		}
		await handle.chmod(FILE_MODE);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await assertRegularNonLinkFile(
		path,
		"database recovery snapshot partial file",
	);
}

async function writeStatePart(path: string, state: unknown): Promise<void> {
	const handle = await open(path, "wx", FILE_MODE);
	try {
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function validSnapshotName(name: string, extension: string): boolean {
	return SNAPSHOT_NAME_PATTERN.test(name) && name.endsWith(extension);
}

async function listSnapshots(
	directory: string,
	extension: string,
): Promise<string[]> {
	try {
		const entries = (await readdir(directory, { withFileTypes: true })).filter(
			(entry) => validSnapshotName(entry.name, extension),
		);
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				throw new Error(
					"Refusing to use a symbolic link as a recovery snapshot",
				);
			}
			if (!entry.isFile()) {
				throw new Error("Recovery snapshot is not a regular file");
			}
		}
		return entries.map((entry) => entry.name).sort();
	} catch (error) {
		if (isErrno(error, "ENOENT")) return [];
		throw error;
	}
}

async function cleanParts(directory: string): Promise<void> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return;
		throw error;
	}
	for (const name of names) {
		if (name.endsWith(".part")) await safeRemove(join(directory, name));
	}
}

async function rotate(
	directory: string,
	extension: string,
	limit: number,
): Promise<void> {
	const names = await listSnapshots(directory, extension);
	for (const stale of names.slice(0, Math.max(0, names.length - limit))) {
		await safeRemove(join(directory, stale));
	}
}

function validateSnapshotIdentity(timestamp: number, id: string): void {
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new Error("Recovery timestamp must be a non-negative safe integer");
	}
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error("Recovery snapshot ID contains unsafe path characters");
	}
}

function ensureRecoveryDirectories(recoveryRoot: string): {
	stateDirectory: string;
	databaseDirectory: string;
} {
	const stateDirectory = join(recoveryRoot, "app-state");
	const databaseDirectory = join(recoveryRoot, "database");
	ensurePrivateDiagnosticsDirectory(stateDirectory);
	ensurePrivateDiagnosticsDirectory(databaseDirectory);
	return { stateDirectory, databaseDirectory };
}

export class RecoveryManager {
	private readonly dependencies: RecoveryManagerDependencies;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(dependencies: RecoveryManagerDependencies) {
		this.dependencies = dependencies;
	}

	private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	createSnapshot(reason: RecoverySnapshotReason): Promise<RecoverySnapshot> {
		return this.enqueueOperation(async () => {
			const { appStateRevision: _appStateRevision, ...snapshot } =
				await this.createSnapshotInternal(reason);
			return snapshot;
		});
	}

	private async createSnapshotInternal(
		reason: RecoverySnapshotReason,
	): Promise<RevisionedRecoverySnapshot> {
		const timestamp = (this.dependencies.now ?? Date.now)();
		const id = (this.dependencies.createId ?? randomUUID)();
		validateSnapshotIdentity(timestamp, id);
		const prefix = `recovery-${String(timestamp).padStart(16, "0")}-${reason}-${id}`;
		const { stateDirectory, databaseDirectory } = ensureRecoveryDirectories(
			this.dependencies.recoveryRoot,
		);
		await cleanParts(stateDirectory);
		await cleanParts(databaseDirectory);
		await Promise.all([
			listSnapshots(stateDirectory, STATE_EXTENSION),
			listSnapshots(databaseDirectory, DATABASE_EXTENSION),
		]);

		const appStatePath = join(stateDirectory, `${prefix}${STATE_EXTENSION}`);
		const appStatePartPath = `${appStatePath}.part`;
		const shouldBackupDatabase = await this.dependencies.databaseExists();
		const databasePath = shouldBackupDatabase
			? join(databaseDirectory, `${prefix}${DATABASE_EXTENSION}`)
			: undefined;
		const databasePartPath = databasePath ? `${databasePath}.part` : undefined;
		let statePromoted = false;
		let databasePromoted = false;

		try {
			const { state: appStateSnapshot, revision: appStateRevision } =
				captureRevisionedAppState(this.dependencies);
			await writeStatePart(appStatePartPath, appStateSnapshot);
			if (databasePartPath) {
				await this.dependencies.backupDatabase(databasePartPath);
				await finalizeDatabasePart(databasePartPath);
				await rename(databasePartPath, databasePath as string);
				databasePromoted = true;
			}
			await rename(appStatePartPath, appStatePath);
			statePromoted = true;
			await rotate(stateDirectory, STATE_EXTENSION, APP_STATE_SNAPSHOT_LIMIT);
			await rotate(
				databaseDirectory,
				DATABASE_EXTENSION,
				DATABASE_SNAPSHOT_LIMIT,
			);
			return {
				appStatePath,
				...(databasePath ? { databasePath } : {}),
				appStateRevision,
			};
		} catch (error) {
			await safeRemove(appStatePartPath);
			if (databasePartPath) await safeRemove(databasePartPath);
			if (statePromoted) await safeRemove(appStatePath);
			if (databasePromoted && databasePath) await safeRemove(databasePath);
			throw error;
		}
	}

	restoreLatestAppStateSnapshot(): Promise<{ restored: true }> {
		return this.enqueueOperation(() =>
			this.restoreLatestAppStateSnapshotInternal(),
		);
	}

	private async restoreLatestAppStateSnapshotInternal(): Promise<{
		restored: true;
	}> {
		const { stateDirectory } = ensureRecoveryDirectories(
			this.dependencies.recoveryRoot,
		);
		const latestName = (
			await listSnapshots(stateDirectory, STATE_EXTENSION)
		).at(-1);
		if (!latestName)
			throw new Error("No app-state recovery snapshot is available");
		const serialized = await readFile(join(stateDirectory, latestName), "utf8");
		const validated = this.dependencies.validateSerializedAppState(serialized);
		const safetySnapshot = await this.createSnapshotInternal("before-restore");
		await this.replaceAppStateAtRevision(
			validated,
			safetySnapshot.appStateRevision,
		);
		return { restored: true };
	}

	resetAppStateWithBackup(): Promise<{ reset: true }> {
		return this.enqueueOperation(() => this.resetAppStateWithBackupInternal());
	}

	private async resetAppStateWithBackupInternal(): Promise<{ reset: true }> {
		const safetySnapshot = await this.createSnapshotInternal("before-reset");
		await this.replaceAppStateAtRevision(
			this.dependencies.createDefaultAppState(),
			safetySnapshot.appStateRevision,
		);
		return { reset: true };
	}

	private async replaceAppStateAtRevision(
		replacement: unknown,
		expectedRevision: number,
	): Promise<void> {
		const outcome = await this.dependencies.replaceAppStateAtRevision(
			replacement,
			expectedRevision,
		);
		if (outcome === "stale") {
			throw new Error(
				"App state changed while the recovery backup was being created; recovery was cancelled without replacing the newer state.",
			);
		}
	}

	async getStatus(): Promise<RecoveryStatus> {
		const { stateDirectory, databaseDirectory } = ensureRecoveryDirectories(
			this.dependencies.recoveryRoot,
		);
		const [appStateSnapshots, databaseSnapshots] = await Promise.all([
			listSnapshots(stateDirectory, STATE_EXTENSION),
			listSnapshots(databaseDirectory, DATABASE_EXTENSION),
		]);
		return {
			hasAppStateSnapshot: appStateSnapshots.length > 0,
			appStateSnapshotCount: appStateSnapshots.length,
			databaseSnapshotCount: databaseSnapshots.length,
		};
	}
}

export function createRecoveryManager(
	dependencies: RecoveryManagerDependencies,
): RecoveryManager {
	return new RecoveryManager(dependencies);
}

export function resolveRecoveryRoot(adeHomeDir = SUPERSET_HOME_DIR): string {
	return join(resolveLocalPrivateRoot({ adeHomeDir }), "recovery");
}

let defaultManager: Promise<RecoveryManager> | null = null;

async function getDefaultRecoveryManager(): Promise<RecoveryManager> {
	defaultManager ??= (async () => {
		const [appStateModule, localDatabase] = await Promise.all([
			import("../app-state"),
			import("../local-db"),
		]);
		const databasePath = join(SUPERSET_HOME_DIR, "local.db");
		return createRecoveryManager({
			recoveryRoot: resolveRecoveryRoot(),
			getAppStateSnapshot: appStateModule.getAppStateSnapshot,
			getAppStateRevision: appStateModule.getAppStateRevision,
			validateSerializedAppState: (serialized) =>
				parseAppStateJson(serialized, {
					deviceId: appStateModule.getDeviceId(),
				}),
			replaceAppStateAtRevision: async (state, expectedRevision) => {
				const replacement = state as AppState;
				const outcome = await appStateModule.enqueueAppStateMutationAtRevision(
					"recovery.replace-app-state",
					expectedRevision,
					(draft) => {
						draft.tabsState = structuredClone(replacement.tabsState);
						draft.themeState = structuredClone(replacement.themeState);
						draft.hotkeysState = structuredClone(replacement.hotkeysState);
						draft.sync = structuredClone(replacement.sync);
					},
				);
				return outcome.status;
			},
			createDefaultAppState: () =>
				createDefaultAppState(appStateModule.getDeviceId()),
			backupDatabase: localDatabase.backupLocalDatabase,
			databaseExists: async () => {
				try {
					return (await lstat(databasePath)).isFile();
				} catch (error) {
					if (isErrno(error, "ENOENT")) return false;
					throw error;
				}
			},
		});
	})();
	return defaultManager;
}

export async function createRecoverySnapshot(
	reason: RecoverySnapshotReason = "manual",
): Promise<RecoverySnapshot> {
	return (await getDefaultRecoveryManager()).createSnapshot(reason);
}

export async function restoreLatestAppStateSnapshot(): Promise<{
	restored: true;
}> {
	return (await getDefaultRecoveryManager()).restoreLatestAppStateSnapshot();
}

export async function resetAppStateWithBackup(): Promise<{ reset: true }> {
	return (await getDefaultRecoveryManager()).resetAppStateWithBackup();
}

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
	return (await getDefaultRecoveryManager()).getStatus();
}

/** @internal */
export function resetRecoveryManagerForTests(): void {
	defaultManager = null;
}
