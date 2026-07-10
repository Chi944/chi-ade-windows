import { describe, expect, it } from "bun:test";
import {
	buildRemoteWorktreeCommand,
	buildSshArgs,
	buildSshProcessEnv,
	buildSshTerminalCommand,
	buildSshTerminalLaunch,
	buildSshTunnelLaunch,
	resolveSystemSshExecutable,
} from "./ssh";

const profile = {
	name: "Build Mac",
	host: "build.example.com",
	user: "chi",
	port: 2222,
	identityFile: "C:\\Users\\Chi User\\.ssh\\id_ed25519",
	remoteRoot: "/srv/chi",
	agentForwarding: true,
};

describe("SSH command builder", () => {
	it("builds cross-platform OpenSSH arguments without a shell", () => {
		expect(buildSshArgs(profile)).toEqual([
			"-p",
			"2222",
			"-i",
			profile.identityFile,
			"-A",
			"-x",
			"--",
			"chi@build.example.com",
		]);
	});

	it("rejects option-like SSH targets before invoking OpenSSH", () => {
		expect(() =>
			buildSshArgs({
				...profile,
				user: null,
				host: "-oProxyCommand=where.exe",
			}),
		).toThrow("Invalid SSH host");
	});

	it("quotes PowerShell arguments without interpolation", () => {
		const command = buildSshTerminalCommand(
			{ ...profile, identityFile: "$(Get-Date) $env:USERPROFILE" },
			"win32",
		);
		expect(command).toContain("'$(Get-Date) $env:USERPROFILE'");
		expect(command).toEndWith("'chi@build.example.com'");
	});

	it("quotes every remote worktree value", () => {
		const command = buildRemoteWorktreeCommand(
			profile,
			{
				repoPath: "/srv/repo with space/$(date)",
				worktreePath: "/srv/worktrees/feature-one",
				branch: "feature/one",
				baseBranch: "origin/main",
			},
			"linux",
		);
		expect(command).toContain("git -C '");
		expect(command).toContain("$(date)");
		expect(command).toContain("'feature/one'");
		expect(command).toContain("'origin/main'");
	});

	it("uses the fixed platform OpenSSH executable", () => {
		expect(resolveSystemSshExecutable("win32", { WINDIR: "D:\\Windows" })).toBe(
			"D:\\Windows\\System32\\OpenSSH\\ssh.exe",
		);
		expect(resolveSystemSshExecutable("darwin")).toBe("/usr/bin/ssh");
	});

	it("builds a durable tmux-backed SSH launch without renderer argv", () => {
		const launch = buildSshTerminalLaunch(
			profile,
			{ remotePath: "~/worktrees/chi ade" },
			"pane-remote-one",
			"darwin",
			{
				HOME: "/Users/chi",
				PATH: "/usr/bin:/bin",
				OPENAI_API_KEY: "must-not-leak",
			},
		);

		expect(launch.executable).toBe("/usr/bin/ssh");
		expect(launch.args).toContain("-tt");
		expect(launch.args).toContain("StrictHostKeyChecking=yes");
		expect(launch.args.at(-1)).toContain('cd "$HOME"/');
		expect(launch.args.at(-1)).toContain("tmux new-session -A");
		expect(launch.env.OPENAI_API_KEY).toBeUndefined();
		expect(launch.env.HOME).toBe("/Users/chi");
	});

	it("changes the transport fingerprint for a different pane session", () => {
		const first = buildSshTerminalLaunch(profile, {}, "pane-one", "darwin");
		const second = buildSshTerminalLaunch(profile, {}, "pane-two", "darwin");
		expect(first.fingerprint).not.toBe(second.fingerprint);
	});

	it("builds one strict loopback tunnel with local and remote forwards", () => {
		const launch = buildSshTunnelLaunch(
			profile,
			[
				{
					id: "2e257083-2001-4b61-995b-9c259642f090",
					direction: "local",
					listenPort: 3000,
					targetHost: "127.0.0.1",
					targetPort: 3000,
				},
				{
					id: "54530a52-55b1-4209-80f1-72ad8539fdc8",
					direction: "remote",
					listenPort: 9000,
					targetHost: "localhost",
					targetPort: 9001,
				},
			],
			"darwin",
		);

		expect(launch.args).toContain("-N");
		expect(launch.args).toContain("-T");
		expect(launch.args).toContain("StrictHostKeyChecking=yes");
		expect(launch.args).toContain("127.0.0.1:3000:127.0.0.1:3000");
		expect(launch.args).toContain("127.0.0.1:9000:localhost:9001");
		expect(launch.args).not.toContain("-A");
		expect(launch.hidden).toBe(true);
	});

	it("rejects unsafe or conflicting tunnel rules", () => {
		expect(() =>
			buildSshTunnelLaunch(profile, [
				{
					id: "a",
					direction: "local",
					listenPort: 80,
					targetHost: "localhost",
					targetPort: 80,
				},
			]),
		).toThrow("between 1024 and 65535");

		expect(() =>
			buildSshTunnelLaunch(profile, [
				{
					id: "a",
					direction: "local",
					listenPort: 3000,
					targetHost: "localhost",
					targetPort: 3000,
				},
				{
					id: "b",
					direction: "local",
					listenPort: 3000,
					targetHost: "$(whoami)",
					targetPort: 3001,
				},
			]),
		).toThrow();
	});

	it("only preserves the environment required by OpenSSH", () => {
		const env = buildSshProcessEnv("win32", {
			WINDIR: "C:\\Windows",
			USERPROFILE: "C:\\Users\\Chi",
			SSH_AUTH_SOCK: "pipe",
			ANTHROPIC_API_KEY: "secret",
		});
		expect(env.WINDIR).toBe("C:\\Windows");
		expect(env.SSH_AUTH_SOCK).toBe("pipe");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
