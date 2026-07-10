import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getDefaultShell } from "../terminal/env";

/**
 * Finds all paths for a binary on Unix systems using the login shell.
 */
function findBinaryPathsUnix(name: string): string[] {
	const shell = getDefaultShell();
	const result = execFileSync(
		shell,
		["-l", "-c", 'which -a -- "$1"', "superset-find-binary", name],
		{
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	return result.trim().split("\n").filter(Boolean);
}

/**
 * Finds all paths for a binary on Windows using where.exe.
 */
function findBinaryPathsWindows(name: string): string[] {
	const result = execFileSync("where.exe", [name], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "ignore"],
	});
	return result.trim().split(/\r?\n/).filter(Boolean);
}

/**
 * Finds the real path of a binary, skipping our wrapper scripts.
 * Filters out all superset bin directories (prod, dev, and workspace-specific)
 * to avoid wrapper scripts calling each other.
 */
export function findRealBinaries(name: string): string[] {
	try {
		const isWindows = process.platform === "win32";
		const allPaths = isWindows
			? findBinaryPathsWindows(name)
			: findBinaryPathsUnix(name);

		const homedir = os.homedir();
		// Filter out wrapper scripts from all ADE directories:
		// - ~/.ade/bin
		// - ~/.ade-*/bin (workspace-specific instances)
		const normalize = (value: string) =>
			path.resolve(value).replaceAll("\\", "/").toLowerCase();
		const supersetBinDir = normalize(path.join(homedir, ".ade", "bin"));
		const supersetPrefix = normalize(path.join(homedir, ".ade-"));
		const paths = allPaths.filter((p) => {
			if (!p) return false;
			const normalized = normalize(p);
			return (
				!normalized.startsWith(`${supersetBinDir}/`) &&
				!(normalized.startsWith(supersetPrefix) && normalized.includes("/bin/"))
			);
		});
		return [...new Set(paths)];
	} catch {
		return [];
	}
}

export function findRealBinary(name: string): string | null {
	return findRealBinaries(name)[0] ?? null;
}
