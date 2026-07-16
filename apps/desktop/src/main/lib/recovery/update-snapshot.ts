import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const SNAPSHOT_LIMIT = 2;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SNAPSHOT_FILE_PATTERN =
	/^(update-[0-9]{16}-[A-Za-z0-9_-]+)\.(local\.db|app-state\.json)$/;

export interface CreateUpdateSnapshotOptions {
	recoveryDirectory: string;
	backupDatabase: (destination: string) => Promise<void>;
	getAppStateSnapshot: () => unknown;
	now?: () => number;
	createId?: () => string;
}

export interface UpdateSnapshot {
	databasePath: string;
	appStatePath: string;
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function safeUnlink(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
}

async function fsyncFile(path: string): Promise<void> {
	const handle = await open(path, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeAppStatePart(path: string, state: unknown): Promise<void> {
	const handle = await open(path, "wx", FILE_MODE);
	try {
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function reconcileSnapshotDirectory(
	recoveryDirectory: string,
): Promise<void> {
	const names = await readdir(recoveryDirectory);
	const pairs = new Map<string, Set<string>>();
	for (const name of names) {
		if (name.startsWith("update-") && name.endsWith(".part")) {
			await safeUnlink(join(recoveryDirectory, name));
			continue;
		}
		const match = SNAPSHOT_FILE_PATTERN.exec(name);
		if (!match) continue;
		const prefix = match[1];
		const kind = match[2];
		if (!prefix || !kind) continue;
		const kinds = pairs.get(prefix) ?? new Set<string>();
		kinds.add(kind);
		pairs.set(prefix, kinds);
	}
	for (const [prefix, kinds] of pairs) {
		if (kinds.has("local.db") && kinds.has("app-state.json")) continue;
		await safeUnlink(join(recoveryDirectory, `${prefix}.local.db`));
		await safeUnlink(join(recoveryDirectory, `${prefix}.app-state.json`));
	}
}

async function rotateSnapshots(recoveryDirectory: string): Promise<void> {
	const names = await readdir(recoveryDirectory);
	const prefixes = new Set<string>();
	for (const name of names) {
		const match = SNAPSHOT_FILE_PATTERN.exec(name);
		if (match?.[1]) prefixes.add(match[1]);
	}
	const stalePrefixes = [...prefixes].sort().reverse().slice(SNAPSHOT_LIMIT);
	for (const prefix of stalePrefixes) {
		await safeUnlink(join(recoveryDirectory, `${prefix}.local.db`));
		await safeUnlink(join(recoveryDirectory, `${prefix}.app-state.json`));
	}
}

export async function createUpdateSnapshot(
	options: CreateUpdateSnapshotOptions,
): Promise<UpdateSnapshot> {
	const timestamp = (options.now ?? Date.now)();
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new Error("Update snapshot timestamp must be a non-negative integer");
	}
	const id = (options.createId ?? randomUUID)();
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error("Update snapshot ID contains unsafe path characters");
	}

	const serializedState = options.getAppStateSnapshot();
	const prefix = `update-${String(timestamp).padStart(16, "0")}-${id}`;
	const databasePath = join(options.recoveryDirectory, `${prefix}.local.db`);
	const appStatePath = join(
		options.recoveryDirectory,
		`${prefix}.app-state.json`,
	);
	const databasePartPath = `${databasePath}.part`;
	const appStatePartPath = `${appStatePath}.part`;
	let databasePromoted = false;
	let appStatePromoted = false;

	await mkdir(options.recoveryDirectory, {
		recursive: true,
		mode: DIRECTORY_MODE,
	});
	await reconcileSnapshotDirectory(options.recoveryDirectory);

	try {
		await options.backupDatabase(databasePartPath);
		await chmod(databasePartPath, FILE_MODE);
		await fsyncFile(databasePartPath);
		await writeAppStatePart(appStatePartPath, serializedState);

		await rename(databasePartPath, databasePath);
		databasePromoted = true;
		await rename(appStatePartPath, appStatePath);
		appStatePromoted = true;
		await rotateSnapshots(options.recoveryDirectory);
		return { databasePath, appStatePath };
	} catch (error) {
		await safeUnlink(databasePartPath);
		await safeUnlink(appStatePartPath);
		if (databasePromoted) await safeUnlink(databasePath);
		if (appStatePromoted) await safeUnlink(appStatePath);
		throw error;
	}
}
