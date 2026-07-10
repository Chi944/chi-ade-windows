import { spawn } from "node:child_process";
import {
	CHECKED_BINARIES,
	type CheckedBinary,
	type RuntimeAvailability,
} from "@superset/shared/agent-binaries";
import { findRealBinariesAsync } from "main/lib/agent-setup/utils";
import { treeKillAsync } from "main/lib/tree-kill";

const VERSION_PROBE_TIMEOUT_MS = 2_000;

interface ProbeBinaryCommandOptions {
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

/** Execute a discovered binary safely, including npm .cmd/.bat shims on Windows. */
export function probeBinaryCommand(
	binaryPath: string,
	commandArgs: string[],
	options: ProbeBinaryCommandOptions = {},
): Promise<boolean> {
	const isWindowsScript =
		process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binaryPath);
	if (
		isWindowsScript &&
		commandArgs.some((arg) => !/^[A-Za-z0-9._:/@+=-]+$/.test(arg))
	) {
		return Promise.resolve(false);
	}
	const executable = isWindowsScript
		? (process.env.ComSpec ?? "cmd.exe")
		: binaryPath;
	const args = isWindowsScript
		? ["/d", "/s", "/c", `""${binaryPath}" ${commandArgs.join(" ")}"`]
		: commandArgs;
	const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const settle = (result: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(executable, args, {
				stdio: "ignore",
				windowsHide: true,
				shell: false,
				env: options.env,
			});
		} catch {
			settle(false);
			return;
		}

		child.once("error", () => settle(false));
		child.once("exit", (code) => settle(code === 0));

		timeout = setTimeout(() => {
			void (async () => {
				if (child.pid) {
					await treeKillAsync(child.pid, "SIGKILL");
				} else {
					try {
						child.kill();
					} catch {
						// A process without a pid may already have failed to spawn.
					}
				}
				child.unref();
				settle(false);
			})();
		}, timeoutMs);
	});
}

/** Verify that a discovered binary can actually execute, not merely exist. */
export function probeBinaryVersion(binaryPath: string): Promise<boolean> {
	return probeBinaryCommand(binaryPath, ["--version"]);
}

export async function computeRuntimeAvailability({
	findBinaries = findRealBinariesAsync,
	probeBinary = probeBinaryVersion,
}: {
	findBinaries?: (binary: CheckedBinary) => string[] | Promise<string[]>;
	probeBinary?: (binaryPath: string) => Promise<boolean>;
} = {}): Promise<RuntimeAvailability> {
	const entries = await Promise.all(
		CHECKED_BINARIES.map(async (binary) => {
			let available = false;
			for (const binaryPath of await findBinaries(binary)) {
				if (await probeBinary(binaryPath)) {
					available = true;
					break;
				}
			}
			return [binary, available] as const;
		}),
	);
	return Object.fromEntries(entries) as RuntimeAvailability;
}
