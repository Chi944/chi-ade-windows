import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const PRIVATE_NAMESPACE_LENGTH = 16;

export interface ResolveLocalPrivateRootOptions {
	adeHomeDir: string;
	platform?: NodeJS.Platform;
	env?: Readonly<Record<string, string | undefined>>;
	homeDir?: string;
}

/**
 * Resolve the device-local ADE namespace without touching the filesystem.
 * Nothing beneath this root is eligible for ADE home synchronization.
 */
export function resolveLocalPrivateRoot({
	adeHomeDir,
	platform = process.platform,
	env = process.env,
	homeDir = homedir(),
}: ResolveLocalPrivateRootOptions): string {
	if (!adeHomeDir) throw new Error("ADE home directory is required");

	const pathApi = platform === "win32" ? win32 : posix;
	const namespace = createHash("sha256")
		.update(pathApi.resolve(adeHomeDir))
		.digest("hex")
		.slice(0, PRIVATE_NAMESPACE_LENGTH);

	let localDataRoot: string;
	if (platform === "win32") {
		if (!env.LOCALAPPDATA) {
			throw new Error(
				"Windows local application data directory is unavailable",
			);
		}
		localDataRoot = env.LOCALAPPDATA;
	} else if (platform === "darwin") {
		localDataRoot = posix.join(homeDir, "Library", "Application Support");
	} else {
		localDataRoot = env.XDG_DATA_HOME || posix.join(homeDir, ".local", "share");
	}

	return pathApi.join(localDataRoot, "ADE", "private", namespace);
}
