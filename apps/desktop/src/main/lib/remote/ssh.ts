import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RemotePortForward, SelectRemoteHost } from "@superset/local-db";
import type { TerminalLaunchSpec } from "../terminal-host/types";

export interface SshProfileInput {
	name: string;
	host: string;
	user?: string | null;
	port: number;
	identityFile?: string | null;
	remoteRoot?: string | null;
	agentForwarding?: boolean;
}

export interface SshWorkspaceBindingInput {
	remotePath?: string | null;
	portForwards?: RemotePortForward[] | null;
}

export interface RemoteWorktreeInput {
	repoPath: string;
	worktreePath: string;
	branch: string;
	baseBranch: string;
}

export interface RemoteWorktreeSshInvocation {
	executable: string;
	args: string[];
	env: Record<string, string>;
}

export interface RemoteWorktreeResult {
	stdout: string;
	stderr: string;
}

interface RemoteWorktreeExecOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	execFileFn?: RemoteWorktreeExecFile;
}

interface RemoteWorktreeExecFileOptions {
	encoding: "utf8";
	timeout: number;
	maxBuffer: number;
	windowsHide: boolean;
	env: Record<string, string>;
}

type RemoteWorktreeExecFile = (
	executable: string,
	args: string[],
	options: RemoteWorktreeExecFileOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

interface BuildSshArgsOptions {
	batch?: boolean;
	trustNewHostKey?: boolean;
	agentForwarding?: boolean;
	deterministic?: boolean;
	requestTty?: boolean;
	keepAlive?: boolean;
	strictHostKey?: boolean;
	portForwards?: RemotePortForward[];
}

const SAFE_DESTINATION_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/;
const REMOTE_WORKTREE_TIMEOUT_MS = 120_000;
const REMOTE_WORKTREE_MAX_BUFFER_BYTES = 64 * 1024;
const REMOTE_WORKTREE_ERROR_DETAIL_LENGTH = 4_000;

export function validateRemotePath(value: string): boolean {
	return (
		(value.startsWith("/") || value === "~" || value.startsWith("~/")) &&
		!/[\r\n\0"']/.test(value)
	);
}

function assertRemoteWorktreePath(value: string, label: string): void {
	if (
		value.length > 2_048 ||
		value.trim() !== value ||
		!validateRemotePath(value) ||
		value.includes("\\")
	) {
		throw new Error(`${label} must be an absolute POSIX or ~/ path`);
	}

	const pathWithoutRoot = value.startsWith("~/")
		? value.slice(2)
		: value.startsWith("/")
			? value.slice(1)
			: "";
	if (
		pathWithoutRoot.length > 0 &&
		pathWithoutRoot
			.split("/")
			.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`${label} cannot contain empty or traversal segments`);
	}
}

function assertGitRef(value: string, label: string): void {
	if (
		value.trim() !== value ||
		!SAFE_GIT_REF.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value.endsWith(".lock") ||
		value.split("/").some((segment) => segment.startsWith("."))
	) {
		throw new Error(`Invalid ${label}`);
	}
}

export function validateRemoteWorktreeInput(input: RemoteWorktreeInput): void {
	assertRemoteWorktreePath(input.repoPath, "Remote repository path");
	assertRemoteWorktreePath(input.worktreePath, "Remote worktree path");
	if (input.worktreePath === "/" || input.worktreePath === "~") {
		throw new Error("Remote worktree path must identify a child directory");
	}
	assertGitRef(input.branch, "worktree branch");
	if (input.branch === "HEAD") throw new Error("Invalid worktree branch");
	assertGitRef(input.baseBranch, "base branch");
}

export function validatePortForward(forward: RemotePortForward): void {
	if (
		!Number.isInteger(forward.listenPort) ||
		forward.listenPort < 1024 ||
		forward.listenPort > 65_535
	) {
		throw new Error("Forward listen ports must be between 1024 and 65535");
	}
	if (
		!Number.isInteger(forward.targetPort) ||
		forward.targetPort < 1 ||
		forward.targetPort > 65_535
	) {
		throw new Error("Forward destination ports must be between 1 and 65535");
	}
	if (
		forward.targetHost.startsWith("-") ||
		!SAFE_DESTINATION_HOST.test(forward.targetHost)
	) {
		throw new Error("Invalid forward destination host");
	}
}

function portForwardArgs(forwards: RemotePortForward[]): string[] {
	const seen = new Set<string>();
	const args: string[] = [];
	for (const forward of forwards) {
		validatePortForward(forward);
		const key = `${forward.direction}:${forward.listenPort}`;
		if (seen.has(key)) {
			throw new Error("Duplicate SSH forward listen port");
		}
		seen.add(key);
		args.push(
			forward.direction === "local" ? "-L" : "-R",
			`127.0.0.1:${forward.listenPort}:${forward.targetHost}:${forward.targetPort}`,
		);
	}
	return args;
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
	options: BuildSshArgsOptions = {},
): string[] {
	const args: string[] = [];
	if (options.deterministic) args.push("-F", "none");
	args.push("-p", String(profile.port));
	if (profile.identityFile) args.push("-i", profile.identityFile);
	const useAgentForwarding =
		options.agentForwarding ?? (!options.batch && profile.agentForwarding);
	args.push(useAgentForwarding ? "-A" : "-a", "-x");
	if (options.batch) {
		args.push(
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=7",
			"-o",
			`StrictHostKeyChecking=${options.trustNewHostKey ? "accept-new" : "yes"}`,
		);
	}
	if (options.strictHostKey && !options.batch) {
		args.push("-o", "StrictHostKeyChecking=yes");
	}
	if (options.keepAlive) {
		args.push(
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"ConnectionAttempts=1",
			"-o",
			"PermitLocalCommand=no",
		);
	}
	if (options.portForwards?.length) {
		args.push("-o", "ExitOnForwardFailure=yes");
		args.push(...portForwardArgs(options.portForwards));
	}
	if (options.requestTty) args.push("-tt");
	args.push("--", sshTarget(profile));
	return args;
}

export function resolveSystemSshExecutable(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "win32") {
		const windowsRoot = env.WINDIR || env.SystemRoot || "C:\\Windows";
		return path.win32.join(windowsRoot, "System32", "OpenSSH", "ssh.exe");
	}
	return "/usr/bin/ssh";
}

export function buildSshProcessEnv(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const allowed = [
		"HOME",
		"PATH",
		"SSH_AUTH_SOCK",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TMPDIR",
		"TMP",
		"TEMP",
	];
	if (platform === "win32") {
		allowed.push(
			"USERPROFILE",
			"HOMEDRIVE",
			"HOMEPATH",
			"LOCALAPPDATA",
			"PROGRAMDATA",
			"SystemRoot",
			"WINDIR",
			"ComSpec",
			"PATHEXT",
		);
	}
	const result: Record<string, string> = { TERM: "xterm-256color" };
	for (const name of allowed) {
		const value = env[name];
		if (typeof value === "string" && value.length > 0) result[name] = value;
	}
	return result;
}

function remotePathExpression(remotePath: string): string {
	if (!validateRemotePath(remotePath)) throw new Error("Invalid remote path");
	if (remotePath === "~") return '"$HOME"';
	if (remotePath.startsWith("~/")) {
		return `"$HOME"/${remoteShellQuote(remotePath.slice(2))}`;
	}
	return remoteShellQuote(remotePath);
}

function remoteSessionName(paneId: string): string {
	return `ade-${createHash("sha256").update(paneId).digest("hex").slice(0, 20)}`;
}

function buildRemoteSessionCommand(
	remotePath: string | null | undefined,
	paneId: string,
): string {
	const changeDirectory = remotePath
		? `cd ${remotePathExpression(remotePath)} && `
		: "";
	const sessionName = remoteSessionName(paneId);
	return `${changeDirectory}if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s '${sessionName}'; else exec "${"$"}{SHELL:-/bin/sh}" -l; fi`;
}

function launchFingerprint(
	kind: TerminalLaunchSpec["kind"],
	executable: string,
	args: string[],
): string {
	return createHash("sha256")
		.update(JSON.stringify({ kind, executable, args }))
		.digest("hex");
}

export function buildSshTerminalLaunch(
	profile: SshProfileInput,
	binding: SshWorkspaceBindingInput,
	paneId: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): TerminalLaunchSpec {
	const executable = resolveSystemSshExecutable(platform, env);
	const args = buildSshArgs(profile, {
		deterministic: true,
		requestTty: true,
		keepAlive: true,
		strictHostKey: true,
		agentForwarding: profile.agentForwarding ?? false,
	});
	args.push(buildRemoteSessionCommand(binding.remotePath, paneId));
	return {
		kind: "ssh",
		executable,
		args,
		fingerprint: launchFingerprint("ssh", executable, args),
		env: buildSshProcessEnv(platform, env),
	};
}

export function buildSshTunnelLaunch(
	profile: SshProfileInput,
	forwards: RemotePortForward[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): TerminalLaunchSpec {
	if (forwards.length === 0)
		throw new Error("At least one port forward is required");
	if (forwards.length > 16)
		throw new Error("A tunnel supports at most 16 forwards");
	const executable = resolveSystemSshExecutable(platform, env);
	const args = [
		...buildSshArgs(profile, {
			batch: true,
			deterministic: true,
			keepAlive: true,
			agentForwarding: false,
			portForwards: forwards,
		}),
	];
	const targetIndex = args.indexOf("--");
	args.splice(targetIndex, 0, "-N", "-T");
	return {
		kind: "ssh-tunnel",
		executable,
		args,
		fingerprint: launchFingerprint("ssh-tunnel", executable, args),
		env: buildSshProcessEnv(platform, env),
		hidden: true,
	};
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

export function buildRemoteWorktreeRemoteCommand(
	input: RemoteWorktreeInput,
): string {
	validateRemoteWorktreeInput(input);
	return [
		"git",
		"-C",
		remotePathExpression(input.repoPath),
		"worktree",
		"add",
		"-b",
		remoteShellQuote(input.branch),
		remotePathExpression(input.worktreePath),
		remoteShellQuote(input.baseBranch),
	].join(" ");
}

export function buildRemoteWorktreeSshInvocation(
	profile: SshProfileInput,
	input: RemoteWorktreeInput,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): RemoteWorktreeSshInvocation {
	const args = buildSshArgs(profile, {
		batch: true,
		deterministic: true,
		keepAlive: true,
		agentForwarding: false,
	});
	const targetIndex = args.indexOf("--");
	args.splice(targetIndex, 0, "-T", "-o", "ClearAllForwardings=yes");
	args.push(buildRemoteWorktreeRemoteCommand(input));
	return {
		executable: resolveSystemSshExecutable(platform, env),
		args,
		env: buildSshProcessEnv(platform, env),
	};
}

/**
 * Build a copyable command for display without using it for execution.
 * Automated worktree creation must call createRemoteWorktree instead.
 */
export function buildRemoteWorktreeCommand(
	profile: SshProfileInput,
	input: RemoteWorktreeInput,
	platform: NodeJS.Platform = process.platform,
): string {
	const invocation = buildRemoteWorktreeSshInvocation(profile, input, platform);
	const command = [invocation.executable, ...invocation.args]
		.map((arg) => localShellQuote(arg, platform))
		.join(" ");
	return platform === "win32" ? `& ${command}` : command;
}

export function createRemoteWorktree(
	profile: SshProfileInput,
	input: RemoteWorktreeInput,
	options: RemoteWorktreeExecOptions = {},
): Promise<RemoteWorktreeResult> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const timeoutMs = options.timeoutMs ?? REMOTE_WORKTREE_TIMEOUT_MS;
	const invocation = buildRemoteWorktreeSshInvocation(
		profile,
		input,
		platform,
		env,
	);
	const execFileFn =
		options.execFileFn ?? (execFile as unknown as RemoteWorktreeExecFile);

	return new Promise((resolve, reject) => {
		execFileFn(
			invocation.executable,
			invocation.args,
			{
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: REMOTE_WORKTREE_MAX_BUFFER_BYTES,
				windowsHide: true,
				env: invocation.env,
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
					return;
				}

				const processError = error as Error & {
					killed?: boolean;
					signal?: string | null;
				};
				const timedOut =
					processError.killed || processError.signal === "SIGTERM";
				const detail = (stderr || stdout || error.message || "SSH failed")
					.trim()
					.slice(0, REMOTE_WORKTREE_ERROR_DETAIL_LENGTH);
				if (timedOut) {
					reject(
						new Error(
							`Remote worktree creation timed out after ${timeoutMs} ms${detail ? `: ${detail}` : ""}`,
						),
					);
					return;
				}
				reject(
					new Error(
						`Remote worktree creation failed${detail ? `: ${detail}` : ""}`,
					),
				);
			},
		);
	});
}

export function testSshConnection(
	profile: SelectRemoteHost,
	options: { trustNewHostKey?: boolean } = {},
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		execFile(
			resolveSystemSshExecutable(),
			[
				...buildSshArgs(profile, {
					batch: true,
					deterministic: true,
					agentForwarding: false,
					trustNewHostKey: options.trustNewHostKey,
				}),
				"printf ADE_REMOTE_OK",
			],
			{
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
				env: buildSshProcessEnv(),
			},
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
