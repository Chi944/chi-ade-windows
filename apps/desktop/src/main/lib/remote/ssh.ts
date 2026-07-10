import { execFile } from "node:child_process";
import type { SelectRemoteHost } from "@superset/local-db";

export interface SshProfileInput {
	name: string;
	host: string;
	user?: string | null;
	port: number;
	identityFile?: string | null;
	remoteRoot?: string | null;
	agentForwarding?: boolean;
}

function localShellQuote(value: string, platform: NodeJS.Platform): string {
	if (/[\r\n\0]/.test(value)) {
		throw new Error("SSH arguments cannot contain control characters");
	}
	return platform === "win32"
		? `'${value.replaceAll("'", "''")}'`
		: `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remoteShellQuote(value: string): string {
	if (value.includes("'") || /[\r\n\0]/.test(value)) {
		throw new Error(
			"Remote paths and branches cannot contain quotes or controls",
		);
	}
	return `'${value}'`;
}

export function sshTarget(profile: SshProfileInput): string {
	if (
		profile.host.startsWith("-") ||
		!/^[A-Za-z0-9.:[\]-]+$/.test(profile.host) ||
		profile.host.includes("@")
	) {
		throw new Error("Invalid SSH host");
	}
	if (profile.user && !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(profile.user)) {
		throw new Error("Invalid SSH user");
	}
	return profile.user ? `${profile.user}@${profile.host}` : profile.host;
}

export function buildSshArgs(
	profile: SshProfileInput,
	options: { batch?: boolean } = {},
): string[] {
	const args = ["-p", String(profile.port)];
	if (profile.identityFile) args.push("-i", profile.identityFile);
	if (profile.agentForwarding) args.push("-A");
	if (options.batch) {
		args.push(
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=7",
			"-o",
			"StrictHostKeyChecking=accept-new",
		);
	}
	args.push("--", sshTarget(profile));
	return args;
}

export function buildSshTerminalCommand(
	profile: SshProfileInput,
	platform: NodeJS.Platform = process.platform,
): string {
	const args = buildSshArgs(profile).map((arg) =>
		localShellQuote(arg, platform),
	);
	return platform === "win32"
		? `& ssh ${args.join(" ")}`
		: `ssh ${args.join(" ")}`;
}

/**
 * Build a remote Git worktree command without interpolating unquoted user data.
 * The command runs inside the remote POSIX shell selected by OpenSSH.
 */
export function buildRemoteWorktreeCommand(
	profile: SshProfileInput,
	input: {
		repoPath: string;
		worktreePath: string;
		branch: string;
		baseBranch: string;
	},
	platform: NodeJS.Platform = process.platform,
): string {
	const remoteCommand = [
		"git",
		"-C",
		remoteShellQuote(input.repoPath),
		"worktree",
		"add",
		remoteShellQuote(input.worktreePath),
		"-b",
		remoteShellQuote(input.branch),
		remoteShellQuote(input.baseBranch),
	].join(" ");
	const args = [...buildSshArgs(profile), remoteCommand].map((arg) =>
		localShellQuote(arg, platform),
	);
	return platform === "win32"
		? `& ssh ${args.join(" ")}`
		: `ssh ${args.join(" ")}`;
}

export function testSshConnection(
	profile: SelectRemoteHost,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		execFile(
			"ssh",
			[...buildSshArgs(profile, { batch: true }), "printf ADE_REMOTE_OK"],
			{ encoding: "utf8", timeout: 10_000, windowsHide: true },
			(error, stdout, stderr) => {
				if (!error && stdout === "ADE_REMOTE_OK") {
					resolve({ ok: true, latencyMs: Date.now() - startedAt });
					return;
				}
				const detail = (stderr || error?.message || "SSH check failed")
					.trim()
					.slice(0, 1_000);
				resolve({ ok: false, error: detail });
			},
		);
	});
}
