import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDiagnosticsDirectory } from "../diagnostics/logger";
import {
	assertSafeExistingDirectoryPath,
	assertSafeRegularFilePath,
} from "./filesystem-safety";

const MARKER_SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DATABASE_SNAPSHOT_LIMIT = 2;
const DATABASE_SNAPSHOT_PATTERN =
	/^recovery-[0-9]{16}-[A-Za-z0-9_-]+\.local\.db$/;

interface MigrationFingerprintMarker {
	schemaVersion: typeof MARKER_SCHEMA_VERSION;
	fingerprint: string;
}

export interface PrepareMigrationBackupOptions {
	databaseExists: boolean;
	migrationsFolder: string;
	recoveryDirectory: string;
	markerPath: string;
	backupDatabase: (destination: string) => Promise<void>;
	now?: () => number;
	createId?: () => string;
}

export interface PreparedMigrationBackup {
	status: "database-absent" | "already-backed-up" | "backed-up";
	fingerprint: string;
	markMigrationComplete: () => void;
}

function updateHashWithFile(
	hash: ReturnType<typeof createHash>,
	name: string,
	contents: Buffer,
): void {
	hash.update(String(Buffer.byteLength(name)));
	hash.update(":");
	hash.update(name);
	hash.update(":");
	hash.update(String(contents.byteLength));
	hash.update(":");
	hash.update(contents);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function getEntry(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

function assertRegularNonLinkFile(path: string, label: string): void {
	assertSafeRegularFilePath(path, label);
}

function assertPathAbsent(path: string, label: string): void {
	const entry = getEntry(path);
	if (!entry) return;
	if (entry.isSymbolicLink()) {
		throw new Error(`Refusing to replace a symbolic link at ${label}`);
	}
	throw new Error(`${label} already exists`);
}

function assertMarkerTargetSafe(markerPath: string): void {
	const entry = getEntry(markerPath);
	if (!entry) return;
	if (entry.isSymbolicLink()) {
		throw new Error("Refusing to use a symbolic link as migration marker");
	}
	if (!entry.isFile()) {
		throw new Error("Migration marker is not a regular file");
	}
}

function removeRegularFileBestEffort(path: string): void {
	try {
		const entry = getEntry(path);
		if (entry?.isFile() && !entry.isSymbolicLink()) {
			rmSync(path, { force: true });
		}
	} catch {
		// Cleanup must not follow links or mask the original backup failure.
	}
}

export function computeMigrationFingerprint(migrationsFolder: string): string {
	const safeMigrationsFolder = assertSafeExistingDirectoryPath(
		migrationsFolder,
		"migrations directory",
	);
	const migrationNames = readdirSync(safeMigrationsFolder, {
		withFileTypes: true,
	})
		.filter((entry) => entry.name.endsWith(".sql"))
		.map((entry) => {
			assertSafeRegularFilePath(
				join(safeMigrationsFolder, entry.name),
				`migration SQL file ${entry.name}`,
				safeMigrationsFolder,
			);
			return entry.name;
		})
		.sort();
	const metaDirectory = assertSafeExistingDirectoryPath(
		join(safeMigrationsFolder, "meta"),
		"migration metadata directory",
		safeMigrationsFolder,
	);
	const journalPath = assertSafeRegularFilePath(
		join(metaDirectory, "_journal.json"),
		"migration journal",
		safeMigrationsFolder,
	);
	const journalContents = readFileSync(journalPath);
	let journal: unknown;
	try {
		journal = JSON.parse(journalContents.toString("utf8"));
	} catch {
		throw new Error("Migration journal is malformed JSON");
	}
	if (
		typeof journal !== "object" ||
		journal === null ||
		Array.isArray(journal) ||
		!Array.isArray((journal as { entries?: unknown }).entries)
	) {
		throw new Error("Migration journal must contain an entries array");
	}
	for (const entry of (journal as { entries: unknown[] }).entries) {
		const tag =
			typeof entry === "object" && entry !== null && !Array.isArray(entry)
				? (entry as { tag?: unknown }).tag
				: undefined;
		if (typeof tag !== "string" || !tag || tag.includes("\0")) {
			throw new Error("Migration journal contains an unsafe migration tag");
		}
		const migrationPath = resolve(safeMigrationsFolder, `${tag}.sql`);
		if (dirname(migrationPath) !== safeMigrationsFolder) {
			throw new Error("Migration journal contains an unsafe migration tag");
		}
		assertSafeRegularFilePath(
			migrationPath,
			`migration SQL file ${tag}.sql`,
			safeMigrationsFolder,
		);
	}
	const hash = createHash("sha256");
	for (const name of migrationNames) {
		const path = assertSafeRegularFilePath(
			join(safeMigrationsFolder, name),
			`migration SQL file ${name}`,
			safeMigrationsFolder,
		);
		updateHashWithFile(hash, name, readFileSync(path));
	}
	const journalName = "meta/_journal.json";
	assertSafeRegularFilePath(
		journalPath,
		"migration journal",
		safeMigrationsFolder,
	);
	updateHashWithFile(hash, journalName, journalContents);
	return hash.digest("hex");
}

function readMarker(markerPath: string): MigrationFingerprintMarker | null {
	assertMarkerTargetSafe(markerPath);
	if (!getEntry(markerPath)) return null;
	try {
		const value: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).length !== 2 ||
			(value as Partial<MigrationFingerprintMarker>).schemaVersion !==
				MARKER_SCHEMA_VERSION ||
			typeof (value as Partial<MigrationFingerprintMarker>).fingerprint !==
				"string" ||
			!/^[a-f0-9]{64}$/.test((value as MigrationFingerprintMarker).fingerprint)
		) {
			return null;
		}
		return value as MigrationFingerprintMarker;
	} catch {
		return null;
	}
}

function writeMarker(markerPath: string, fingerprint: string): void {
	ensurePrivateDiagnosticsDirectory(dirname(markerPath));
	assertMarkerTargetSafe(markerPath);
	const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | null = null;
	try {
		assertPathAbsent(temporaryPath, "migration marker temporary file");
		descriptor = openSync(temporaryPath, "wx", FILE_MODE);
		writeFileSync(
			descriptor,
			`${JSON.stringify({ schemaVersion: MARKER_SCHEMA_VERSION, fingerprint })}\n`,
			"utf8",
		);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		assertRegularNonLinkFile(temporaryPath, "migration marker temporary file");
		assertMarkerTargetSafe(markerPath);
		renameSync(temporaryPath, markerPath);
		assertRegularNonLinkFile(markerPath, "migration marker");
	} finally {
		if (descriptor !== null) closeSync(descriptor);
		removeRegularFileBestEffort(temporaryPath);
	}
}

function cleanParts(recoveryDirectory: string): void {
	for (const name of readdirSync(recoveryDirectory)) {
		if (name.endsWith(".part")) {
			const partPath = join(recoveryDirectory, name);
			assertRegularNonLinkFile(partPath, "migration backup partial file");
			rmSync(partPath, { force: true });
		}
	}
}

function listDatabaseSnapshots(recoveryDirectory: string): string[] {
	const snapshots = readdirSync(recoveryDirectory)
		.filter((name) => DATABASE_SNAPSHOT_PATTERN.test(name))
		.sort();
	for (const snapshot of snapshots) {
		assertRegularNonLinkFile(
			join(recoveryDirectory, snapshot),
			"database recovery snapshot",
		);
	}
	return snapshots;
}

function rotateDatabaseSnapshots(recoveryDirectory: string): void {
	const snapshots = listDatabaseSnapshots(recoveryDirectory);
	for (const stale of snapshots.slice(
		0,
		Math.max(0, snapshots.length - DATABASE_SNAPSHOT_LIMIT),
	)) {
		rmSync(join(recoveryDirectory, stale), { force: true });
	}
}

export async function prepareMigrationBackup({
	databaseExists,
	migrationsFolder,
	recoveryDirectory,
	markerPath,
	backupDatabase,
	now = Date.now,
	createId = randomUUID,
}: PrepareMigrationBackupOptions): Promise<PreparedMigrationBackup> {
	const fingerprint = computeMigrationFingerprint(migrationsFolder);
	ensurePrivateDiagnosticsDirectory(dirname(markerPath));
	ensurePrivateDiagnosticsDirectory(recoveryDirectory);
	assertMarkerTargetSafe(markerPath);
	const persistCompletion = () => writeMarker(markerPath, fingerprint);
	if (!databaseExists) {
		return {
			status: "database-absent",
			fingerprint,
			markMigrationComplete: persistCompletion,
		};
	}
	if (readMarker(markerPath)?.fingerprint === fingerprint) {
		return {
			status: "already-backed-up",
			fingerprint,
			markMigrationComplete: () => undefined,
		};
	}

	const timestamp = now();
	const id = createId();
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new Error("Migration backup timestamp must be non-negative");
	}
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error("Migration backup ID contains unsafe path characters");
	}
	cleanParts(recoveryDirectory);
	listDatabaseSnapshots(recoveryDirectory);
	const name = `recovery-${String(timestamp).padStart(16, "0")}-migration-${fingerprint.slice(0, 12)}-${id}.local.db`;
	const destination = join(recoveryDirectory, name);
	const partPath = `${destination}.part`;
	assertPathAbsent(destination, "database recovery snapshot");
	assertPathAbsent(partPath, "migration backup partial file");
	let promoted = false;
	try {
		await backupDatabase(partPath);
		assertRegularNonLinkFile(partPath, "migration backup partial file");
		chmodSync(partPath, FILE_MODE);
		const descriptor = openSync(partPath, "r+");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		assertPathAbsent(destination, "database recovery snapshot");
		renameSync(partPath, destination);
		promoted = true;
		assertRegularNonLinkFile(destination, "database recovery snapshot");
		writeMarker(markerPath, fingerprint);
		rotateDatabaseSnapshots(recoveryDirectory);
		return {
			status: "backed-up",
			fingerprint,
			markMigrationComplete: () => undefined,
		};
	} catch (error) {
		removeRegularFileBestEffort(partPath);
		let markerMatches = false;
		try {
			markerMatches = readMarker(markerPath)?.fingerprint === fingerprint;
		} catch {
			// A concurrently replaced marker must not mask the original failure.
		}
		if (promoted && !markerMatches) {
			removeRegularFileBestEffort(destination);
		}
		throw error;
	}
}

export async function runMigrationsWithBackup({
	prepareBackup,
	migrate,
}: {
	prepareBackup: () => Promise<PreparedMigrationBackup>;
	migrate: () => void;
}): Promise<PreparedMigrationBackup> {
	const prepared = await prepareBackup();
	migrate();
	prepared.markMigrationComplete();
	return prepared;
}
