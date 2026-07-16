import type { Dirent } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { rcompare, valid } from "semver";

export const MAX_COMPLETED_INSTALLER_VERSIONS = 2;
export const MAX_COMPLETED_INSTALLER_BYTES = 1024 * 1024 * 1024;

export interface CompletedInstallerRetentionLimits {
	maxVersions: number;
	maxBytes: number;
}

const DEFAULT_COMPLETED_INSTALLER_RETENTION_LIMITS: CompletedInstallerRetentionLimits =
	{
		maxVersions: MAX_COMPLETED_INSTALLER_VERSIONS,
		maxBytes: MAX_COMPLETED_INSTALLER_BYTES,
	};

const COMPLETED_INSTALLER_NAMES = new Set([
	"ADE-Windows-x64.exe",
	"ADE-macOS-Apple-Silicon.dmg",
	"ADE-macOS-Intel.dmg",
]);

export interface UpdateStorageHealth {
	/** Structurally complete final installers; historical files are not rehashed. */
	completedInstallerVersions: number;
	completedInstallerBytes: number;
	updateVersionOverageCount: number;
	invalidUpdateEntryCount: number;
}

interface CompletedVersion {
	version: string;
	bytes: number;
	installerPaths: string[];
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function validateUpdateStorageRoot(
	updatesDirectory: string,
): Promise<boolean> {
	try {
		const metadata = await lstat(updatesDirectory);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error("Update storage root must be a non-link directory");
		}
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function isSafeVersionDirectory(directory: string): Promise<boolean> {
	try {
		const metadata = await lstat(directory);
		return !metadata.isSymbolicLink() && metadata.isDirectory();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

export async function inspectUpdateStorage(
	updatesDirectory: string,
): Promise<UpdateStorageHealth> {
	if (!(await validateUpdateStorageRoot(updatesDirectory))) {
		return {
			completedInstallerVersions: 0,
			completedInstallerBytes: 0,
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		};
	}
	let versionEntries: Dirent<string>[];
	try {
		versionEntries = await readdir(updatesDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return {
				completedInstallerVersions: 0,
				completedInstallerBytes: 0,
				updateVersionOverageCount: 0,
				invalidUpdateEntryCount: 0,
			};
		}
		throw error;
	}

	let completedInstallerVersions = 0;
	let completedInstallerBytes = 0;
	let updateVersionOverageCount = 0;
	let invalidUpdateEntryCount = 0;

	for (const versionEntry of versionEntries) {
		if (
			!versionEntry.isDirectory() ||
			valid(versionEntry.name) !== versionEntry.name
		) {
			invalidUpdateEntryCount += 1;
			continue;
		}

		const versionDirectory = join(updatesDirectory, versionEntry.name);
		if (!(await isSafeVersionDirectory(versionDirectory))) {
			invalidUpdateEntryCount += 1;
			continue;
		}
		const installerEntries = await readdir(versionDirectory, {
			withFileTypes: true,
		});
		let completedInstallerCount = 0;
		for (const installerEntry of installerEntries) {
			if (
				!installerEntry.isFile() ||
				!COMPLETED_INSTALLER_NAMES.has(installerEntry.name)
			) {
				invalidUpdateEntryCount += 1;
				continue;
			}
			const metadata = await lstat(join(versionDirectory, installerEntry.name));
			if (
				metadata.isSymbolicLink() ||
				!metadata.isFile() ||
				metadata.size <= 0
			) {
				invalidUpdateEntryCount += 1;
				continue;
			}
			completedInstallerCount += 1;
			completedInstallerBytes += metadata.size;
		}

		if (completedInstallerCount > 0) completedInstallerVersions += 1;
		updateVersionOverageCount += Math.max(0, completedInstallerCount - 1);
	}

	return {
		completedInstallerVersions,
		completedInstallerBytes,
		updateVersionOverageCount,
		invalidUpdateEntryCount,
	};
}

async function completedVersions(
	updatesDirectory: string,
): Promise<CompletedVersion[]> {
	if (!(await validateUpdateStorageRoot(updatesDirectory))) return [];
	let entries: Dirent<string>[];
	try {
		entries = await readdir(updatesDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const versions: CompletedVersion[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || valid(entry.name) !== entry.name) continue;
		const directory = join(updatesDirectory, entry.name);
		if (!(await isSafeVersionDirectory(directory))) continue;
		const installerPaths: string[] = [];
		let bytes = 0;
		for (const installer of await readdir(directory, { withFileTypes: true })) {
			if (
				!installer.isFile() ||
				!COMPLETED_INSTALLER_NAMES.has(installer.name)
			) {
				continue;
			}
			const path = join(directory, installer.name);
			const metadata = await lstat(path);
			if (
				metadata.isSymbolicLink() ||
				!metadata.isFile() ||
				metadata.size <= 0
			) {
				continue;
			}
			installerPaths.push(path);
			bytes += metadata.size;
		}
		if (installerPaths.length > 0) {
			versions.push({ version: entry.name, bytes, installerPaths });
		}
	}
	return versions.sort((left, right) => rcompare(left.version, right.version));
}

export async function pruneCompletedInstallerVersions(
	updatesDirectory: string,
	keepVersion: string,
	limits: CompletedInstallerRetentionLimits = DEFAULT_COMPLETED_INSTALLER_RETENTION_LIMITS,
): Promise<void> {
	const versions = await completedVersions(updatesDirectory);
	const current = versions.find(({ version }) => version === keepVersion);
	const retained = new Set<string>();
	let retainedBytes = 0;
	if (current && current.bytes <= limits.maxBytes) {
		retained.add(current.version);
		retainedBytes = current.bytes;
	}
	for (const candidate of versions) {
		if (retained.has(candidate.version)) continue;
		if (
			retained.size >= limits.maxVersions ||
			retainedBytes + candidate.bytes > limits.maxBytes
		) {
			continue;
		}
		retained.add(candidate.version);
		retainedBytes += candidate.bytes;
	}

	for (const stale of versions.filter(
		({ version }) => !retained.has(version),
	)) {
		for (const path of stale.installerPaths) {
			const metadata = await lstat(path);
			if (!metadata.isSymbolicLink() && metadata.isFile()) await unlink(path);
		}
		await rmdir(join(updatesDirectory, stale.version)).catch((error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
		});
	}
}
