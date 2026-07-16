import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const SQLITE_AUXILIARY_SUFFIXES = ["-journal", "-shm", "-wal"] as const;
type FileSystemEntry = NonNullable<ReturnType<typeof lstatSync>>;

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function normalizeAbsolutePath(path: string, label: string): string {
	if (!path || path.includes("\0") || !isAbsolute(path)) {
		throw new Error(`${label} must be a valid absolute path`);
	}
	return resolve(path);
}

function filesystemRoot(path: string, label: string): string {
	return parse(normalizeAbsolutePath(path, label)).root;
}

/**
 * Enumerate only the controlled segments below a filesystem/volume root. The
 * root itself is deliberately not inspected: Windows drive and UNC roots can
 * be represented by OS-managed reparse points even though the child path is
 * safe, and they are not application-controlled entries.
 */
function controlledSegments(
	path: string,
	trustedBoundary: string,
	label: string,
): { absolute: string; boundary: string; segments: string[] } {
	const absolute = normalizeAbsolutePath(path, label);
	const boundary = normalizeAbsolutePath(
		trustedBoundary,
		`${label} trusted boundary`,
	);
	const relativePath = relative(boundary, absolute);
	const segments = relativePath ? relativePath.split(sep) : [];
	if (
		parse(absolute).root !== parse(boundary).root ||
		isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`${label} escapes its trusted boundary or is malformed`);
	}
	return { absolute, boundary, segments };
}

function getEntry(path: string): FileSystemEntry | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

function assertDirectoryMetadata(entry: FileSystemEntry, label: string): void {
	if (entry.isSymbolicLink()) {
		throw new Error(
			`Refusing to traverse a symbolic link or junction in ${label}`,
		);
	}
	if (!entry.isDirectory()) {
		throw new Error(`${label} contains a non-directory entry`);
	}
}

function assertDirectoryEntry(path: string, label: string): void {
	const entry = getEntry(path);
	if (!entry) throw new Error(`${label} is missing`);
	assertDirectoryMetadata(entry, label);
}

export function assertSafeExistingDirectoryPath(
	directory: string,
	label: string,
	trustedBoundary?: string,
): string {
	const { absolute, boundary, segments } = controlledSegments(
		directory,
		trustedBoundary ?? filesystemRoot(directory, label),
		label,
	);
	if (segments.length === 0) {
		throw new Error(`${label} must be below its trusted boundary`);
	}
	let cursor = boundary;
	for (const segment of segments) {
		cursor = join(cursor, segment);
		assertDirectoryEntry(cursor, label);
	}
	return absolute;
}

export function ensureSafeDirectoryPath(
	directory: string,
	label: string,
	trustedBoundary?: string,
	mode = PRIVATE_DIRECTORY_MODE,
): string {
	const { absolute, boundary, segments } = controlledSegments(
		directory,
		trustedBoundary ?? filesystemRoot(directory, label),
		label,
	);
	if (segments.length === 0) {
		throw new Error(`${label} must be below its trusted boundary`);
	}
	let cursor = boundary;
	for (const segment of segments) {
		cursor = join(cursor, segment);
		let entry = getEntry(cursor);
		if (!entry) {
			try {
				mkdirSync(cursor, { mode });
			} catch (mkdirError) {
				if (!isAlreadyPresent(mkdirError)) throw mkdirError;
			}
			entry = getEntry(cursor);
			if (!entry) throw new Error(`${label} could not be created safely`);
		}
		assertDirectoryMetadata(entry, label);
	}
	try {
		chmodSync(absolute, mode);
	} catch {
		// Windows ACLs protect the per-user directory; POSIX mode repair is best effort.
	}
	return absolute;
}

export function assertSafeRegularFilePath(
	path: string,
	label: string,
	trustedBoundary?: string,
): string {
	const { absolute, boundary, segments } = controlledSegments(
		path,
		trustedBoundary ?? filesystemRoot(path, label),
		label,
	);
	if (segments.length === 0) {
		throw new Error(`${label} must be below its trusted boundary`);
	}
	let cursor = boundary;
	for (const segment of segments.slice(0, -1)) {
		cursor = join(cursor, segment);
		assertDirectoryEntry(cursor, `${label} parent directory`);
	}
	const entry = getEntry(absolute);
	if (!entry) throw new Error(`${label} is missing`);
	if (entry.isSymbolicLink()) {
		throw new Error(`Refusing to use a symbolic link or junction as ${label}`);
	}
	if (!entry.isFile()) throw new Error(`${label} is not a regular file`);
	return absolute;
}

function inspectSafeRegularFilePath(
	path: string,
	label: string,
	trustedBoundary: string,
): boolean {
	const absolute = normalizeAbsolutePath(path, label);
	if (!getEntry(absolute)) return false;
	assertSafeRegularFilePath(absolute, label, trustedBoundary);
	return true;
}

export function openValidatedLocalDatabase<T>(
	databasePath: string,
	open: (validatedPath: string) => T,
): { database: T; existedBeforeOpen: boolean } {
	const absolute = normalizeAbsolutePath(databasePath, "local database path");
	const databaseDirectory = dirname(absolute);
	ensureSafeDirectoryPath(databaseDirectory, "local database directory");
	const existedBeforeOpen = inspectSafeRegularFilePath(
		absolute,
		"local database",
		databaseDirectory,
	);
	for (const suffix of SQLITE_AUXILIARY_SUFFIXES) {
		inspectSafeRegularFilePath(
			`${absolute}${suffix}`,
			`local database ${suffix.slice(1)} file`,
			databaseDirectory,
		);
	}
	return { database: open(absolute), existedBeforeOpen };
}
