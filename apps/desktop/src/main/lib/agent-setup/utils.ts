import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildCliProcessEnvironment } from "../cli-process-env";
import { getDefaultShell } from "../terminal/env";

const BINARY_DISCOVERY_TIMEOUT_MS = 2_000;
const execFileAsync = promisify(execFile);

/**
 * Finds all paths for a binary on Unix systems using the login shell.
 */
function findBinaryPathsUnix(name: string, env: NodeJS.ProcessEnv): string[] {
	const shell = getDefaultShell();
	const result = execFileSync(
		shell,
		["-l", "-c", 'which -a -- "$1"', "ade-find-binary", name],
		{
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
			timeout: BINARY_DISCOVERY_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: 256 * 1024,
			env,
		},
	);
	return result.trim().split("\n").filter(Boolean);
}

/**
 * Finds all paths for a binary on Windows using where.exe.
 */
function findBinaryPathsWindows(
	name: string,
	env: NodeJS.ProcessEnv,
): string[] {
	const result = execFileSync("where.exe", [name], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "ignore"],
		timeout: BINARY_DISCOVERY_TIMEOUT_MS,
		killSignal: "SIGKILL",
		maxBuffer: 256 * 1024,
		env,
	});
	return result.trim().split(/\r?\n/).filter(Boolean);
}

async function findBinaryPathsUnixAsync(
	name: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	const shell = getDefaultShell();
	const { stdout } = await execFileAsync(
		shell,
		["-l", "-c", 'which -a -- "$1"', "ade-find-binary", name],
		{
			encoding: "utf-8",
			timeout: BINARY_DISCOVERY_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: 256 * 1024,
			env,
		},
	);
	return stdout.trim().split("\n").filter(Boolean);
}

async function findBinaryPathsWindowsAsync(
	name: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	const { stdout } = await execFileAsync("where.exe", [name], {
		encoding: "utf-8",
		timeout: BINARY_DISCOVERY_TIMEOUT_MS,
		killSignal: "SIGKILL",
		maxBuffer: 256 * 1024,
		env,
	});
	return stdout.trim().split(/\r?\n/).filter(Boolean);
}

function filterRealBinaryPaths(allPaths: string[]): string[] {
	const homedir = os.homedir();
	const normalize = (value: string) =>
		path.resolve(value).replaceAll("\\", "/").toLowerCase();
	const adeBinDir = normalize(path.join(homedir, ".ade", "bin"));
	const adePrefix = normalize(path.join(homedir, ".ade-"));
	const paths = allPaths.filter((entry) => {
		if (!entry) return false;
		const normalized = normalize(entry);
		return (
			!normalized.startsWith(`${adeBinDir}/`) &&
			!(normalized.startsWith(adePrefix) && normalized.includes("/bin/"))
		);
	});
	return [...new Set(paths)];
}

/**
 * Finds the real path of a binary, skipping our wrapper scripts.
 * Filters out all superset bin directories (prod, dev, and workspace-specific)
 * to avoid wrapper scripts calling each other.
 */
export function findRealBinaries(
	name: string,
	options: { env?: NodeJS.ProcessEnv } = {},
): string[] {
	try {
		const env = options.env ?? buildCliProcessEnvironment();
		const isWindows = process.platform === "win32";
		const allPaths = isWindows
			? findBinaryPathsWindows(name, env)
			: findBinaryPathsUnix(name, env);

		return filterRealBinaryPaths(allPaths);
	} catch {
		return [];
	}
}

export async function findRealBinariesAsync(
	name: string,
	options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
	try {
		const env = options.env ?? buildCliProcessEnvironment();
		const allPaths =
			process.platform === "win32"
				? await findBinaryPathsWindowsAsync(name, env)
				: await findBinaryPathsUnixAsync(name, env);
		return filterRealBinaryPaths(allPaths);
	} catch {
		return [];
	}
}

export function findRealBinary(name: string): string | null {
	return findRealBinaries(name)[0] ?? null;
}
