import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { valid } from "semver";

const COMPLETED_INSTALLER_NAMES = new Set([
	"ADE-Windows-x64.exe",
	"ADE-macOS-Apple-Silicon.dmg",
	"ADE-macOS-Intel.dmg",
]);

export interface UpdateStorageHealth {
	/** Structurally complete final installers; historical files are not rehashed. */
	completedInstallerVersions: number;
	updateVersionOverageCount: number;
	invalidUpdateEntryCount: number;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function inspectUpdateStorage(
	updatesDirectory: string,
): Promise<UpdateStorageHealth> {
	let versionEntries: Dirent<string>[];
	try {
		versionEntries = await readdir(updatesDirectory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) {
			return {
				completedInstallerVersions: 0,
				updateVersionOverageCount: 0,
				invalidUpdateEntryCount: 0,
			};
		}
		throw error;
	}

	let completedInstallerVersions = 0;
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
			const metadata = await stat(join(versionDirectory, installerEntry.name));
			if (!metadata.isFile() || metadata.size <= 0) {
				invalidUpdateEntryCount += 1;
				continue;
			}
			completedInstallerCount += 1;
		}

		if (completedInstallerCount > 0) completedInstallerVersions += 1;
		updateVersionOverageCount += Math.max(0, completedInstallerCount - 1);
	}

	return {
		completedInstallerVersions,
		updateVersionOverageCount,
		invalidUpdateEntryCount,
	};
}
