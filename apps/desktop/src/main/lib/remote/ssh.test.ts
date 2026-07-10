import { describe, expect, it } from "bun:test";
import {
	buildRemoteWorktreeCommand,
	buildSshArgs,
	buildSshTerminalCommand,
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
});
