import { describe, expect, it } from "bun:test";
import {
	buildRemoteWorktreeCommand,
	buildRemoteWorktreeRemoteCommand,
	buildRemoteWorktreeSshInvocation,
	buildSshArgs,
	buildSshProcessEnv,
	buildSshTerminalCommand,
	buildSshTerminalLaunch,
	buildSshTunnelLaunch,
	createRemoteWorktree,
	resolveSystemSshExecutable,
	validateRemoteWorktreeInput,
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
		const input = {
			repoPath: "/srv/repo with space/$(date)",
			worktreePath: "/srv/worktrees/feature-one",
			branch: "feature/one",
			baseBranch: "origin/main",
		};
		const remoteCommand = buildRemoteWorktreeRemoteCommand(input);
		const displayCommand = buildRemoteWorktreeCommand(profile, input, "linux");

		expect(remoteCommand).toBe(
			"git -C '/srv/repo with space/$(date)' worktree add -b 'feature/one' '/srv/worktrees/feature-one' 'origin/main'",
		);
		expect(displayCommand).toContain("'/usr/bin/ssh'");
		expect(displayCommand).toContain("StrictHostKeyChecking=yes");
	});

	it("expands home-relative worktree paths on the remote host", () => {
		const command = buildRemoteWorktreeRemoteCommand({
			repoPath: "~/repos/project",
			worktreePath: "~/worktrees/feature-one",
			branch: "feature/one",
			baseBranch: "origin/main",
		});

		expect(command).toContain("git -C \"$HOME\"/'repos/project'");
		expect(command).toContain("\"$HOME\"/'worktrees/feature-one'");
		expect(command).not.toContain("'~/");
	});

	it("rejects relative, traversal, root, and unsafe ref inputs", () => {
		const valid = {
			repoPath: "/srv/repos/project",
			worktreePath: "/srv/worktrees/feature-one",
			branch: "feature/one",
			baseBranch: "origin/main",
		};

		expect(() =>
			validateRemoteWorktreeInput({ ...valid, repoPath: "srv/repos/project" }),
		).toThrow("absolute POSIX");
		expect(() =>
			validateRemoteWorktreeInput({
				...valid,
				worktreePath: "/srv/worktrees/../outside",
			}),
		).toThrow("traversal");
		expect(() =>
			validateRemoteWorktreeInput({ ...valid, worktreePath: "/" }),
		).toThrow("child directory");
		expect(() =>
			validateRemoteWorktreeInput({ ...valid, branch: "-oProxyCommand=bad" }),
		).toThrow("Invalid worktree branch");
		expect(() =>
			validateRemoteWorktreeInput({ ...valid, baseBranch: "origin/main;rm" }),
		).toThrow("Invalid base branch");
	});

	it("builds strict non-interactive worktree SSH argv", () => {
		const invocation = buildRemoteWorktreeSshInvocation(
			profile,
			{
				repoPath: "/srv/repos/project",
				worktreePath: "/srv/worktrees/feature-one",
				branch: "feature/one",
				baseBranch: "origin/main",
			},
			"darwin",
			{
				HOME: "/Users/chi",
				PATH: "/usr/bin:/bin",
				OPENAI_API_KEY: "must-not-leak",
			},
		);

		expect(invocation.executable).toBe("/usr/bin/ssh");
		expect(invocation.args).toContain("-F");
		expect(invocation.args).toContain("none");
		expect(invocation.args).toContain("BatchMode=yes");
		expect(invocation.args).toContain("StrictHostKeyChecking=yes");
		expect(invocation.args).toContain("ClearAllForwardings=yes");
		expect(invocation.args).toContain("-T");
		expect(invocation.args).toContain("-a");
		expect(invocation.args).not.toContain("-A");
		expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
		expect(invocation.args.at(-1)).toContain("git -C");
	});

	it("executes the fixed invocation with bounded process options", async () => {
		let captured:
			| {
					executable: string;
					args: string[];
					options: { timeout: number; maxBuffer: number; windowsHide: boolean };
			  }
			| undefined;
		const result = await createRemoteWorktree(
			profile,
			{
				repoPath: "/srv/repos/project",
				worktreePath: "/srv/worktrees/feature-one",
				branch: "feature/one",
				baseBranch: "origin/main",
			},
			{
				platform: "darwin",
				env: { HOME: "/Users/chi", PATH: "/usr/bin:/bin" },
				timeoutMs: 12_345,
				execFileFn: (executable, args, options, callback) => {
					captured = { executable, args, options };
					callback(null, " created\n", "");
				},
			},
		);

		expect(result).toEqual({ stdout: "created", stderr: "" });
		expect(captured?.executable).toBe("/usr/bin/ssh");
		expect(captured?.args.at(-1)).toContain("git -C");
		expect(captured?.options).toMatchObject({
			timeout: 12_345,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
	});

	it("bounds SSH failure details and reports timeouts", async () => {
		const input = {
			repoPath: "/srv/repos/project",
			worktreePath: "/srv/worktrees/feature-one",
			branch: "feature/one",
			baseBranch: "origin/main",
		};
		const longError = `start-${"x".repeat(5_000)}-end`;
		const failed = createRemoteWorktree(profile, input, {
			execFileFn: (_executable, _args, _options, callback) =>
				callback(new Error("failed"), "", longError),
		});
		await expect(failed).rejects.toThrow("Remote worktree creation failed");
		await expect(failed).rejects.not.toThrow("-end");

		const timedOut = createRemoteWorktree(profile, input, {
			timeoutMs: 500,
			execFileFn: (_executable, _args, _options, callback) =>
				callback(Object.assign(new Error("killed"), { killed: true }), "", ""),
		});
		await expect(timedOut).rejects.toThrow("timed out after 500 ms");
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
