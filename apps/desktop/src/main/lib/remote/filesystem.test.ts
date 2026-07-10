import { describe, expect, it } from "bun:test";
import {
	buildRemoteEditorCommitCommand,
	buildSftpArgs,
	buildSftpBatch,
	joinRemotePath,
	normalizeRemoteRelativePath,
	parseDirectoryRecords,
	parseRemoteFileMetadata,
	resolveSystemSftpExecutable,
	validateRemoteEntryName,
} from "./filesystem";

const profile = {
	name: "Remote Mac",
	host: "build.example.com",
	user: "chi",
	port: 2222,
	identityFile: "C:\\Users\\Chi User\\.ssh\\id_ed25519",
	agentForwarding: true,
};

describe("remote filesystem transport", () => {
	it("resolves only the inbox SFTP executable on Windows and macOS", () => {
		expect(
			resolveSystemSftpExecutable("win32", { WINDIR: "D:\\Windows" }),
		).toBe("D:\\Windows\\System32\\OpenSSH\\sftp.exe");
		expect(resolveSystemSftpExecutable("darwin")).toBe("/usr/bin/sftp");
	});

	it("builds deterministic non-interactive SFTP argv with destination last", () => {
		const args = buildSftpArgs(profile);
		expect(args.slice(0, 6)).toEqual(["-b", "-", "-F", "none", "-P", "2222"]);
		expect(args).toContain("StrictHostKeyChecking=yes");
		expect(args).toContain("ForwardAgent=no");
		expect(args).toContain("ClearAllForwardings=yes");
		expect(args).not.toContain("-A");
		expect(args.at(-1)).toBe("chi@build.example.com");
	});

	it("normalizes root-relative paths and rejects traversal or controls", () => {
		expect(normalizeRemoteRelativePath("src//components/./button.tsx")).toBe(
			"src/components/button.tsx",
		);
		expect(normalizeRemoteRelativePath("")).toBe("");
		expect(() => normalizeRemoteRelativePath("../secret")).toThrow(
			"cannot leave",
		);
		expect(() => normalizeRemoteRelativePath("/etc/passwd")).toThrow(
			"root-relative",
		);
		expect(() => normalizeRemoteRelativePath("src\nsecret")).toThrow(
			"controls",
		);
	});

	it("joins paths without allowing the renderer to replace the root", () => {
		expect(joinRemotePath("/srv/worktrees/chi", "src/index.ts")).toBe(
			"/srv/worktrees/chi/src/index.ts",
		);
		expect(joinRemotePath("~/work", "README.md")).toBe("~/work/README.md");
		expect(joinRemotePath("/", "README.md")).toBe("/README.md");
	});

	it("encodes a strict stdin batch and prevents option-like relative operands", () => {
		const batch = buildSftpBatch("~/work trees", [
			'@get "./-notes\\[1\\].md" "C:/Temp/notes.md"',
		]);
		expect(batch).toStartWith('@cd "./work trees"\n');
		expect(batch).toContain('"./-notes\\[1\\].md"');
		expect(batch).toEndWith("@bye\n");
		expect(buildSftpBatch("~", [])).toStartWith('@cd "."\n');
	});

	it("builds a locked compare-and-swap editor commit", () => {
		const revision = "a".repeat(64);
		const command = buildRemoteEditorCommitCommand("~/work trees", {
			relativePath: "scripts/run 'safe'.sh",
			temporaryRelativePath: "scripts/.ade-upload-1",
			expectedRevision: revision,
		});
		expect(command).toContain("ade-save-lock");
		expect(command).toContain("sha256sum");
		expect(command).toContain("chmod");
		expect(command).toContain('"$HOME"/');
		expect(command).toContain(revision);
		expect(() =>
			buildRemoteEditorCommitCommand("~/work", {
				relativePath: "README.md",
				temporaryRelativePath: ".tmp",
				expectedRevision: "not-a-hash",
			}),
		).toThrow("Invalid remote file revision");
	});

	it("parses NUL-delimited metadata without depending on ls formatting", () => {
		const records = parseDirectoryRecords(
			Buffer.from("d\0folder with spaces\0f\0café.ts\0l\0linked file\0"),
		);
		expect(records).toEqual([
			{ type: "d", name: "folder with spaces" },
			{ type: "f", name: "café.ts" },
			{ type: "l", name: "linked file" },
		]);
		expect(() => parseDirectoryRecords(Buffer.from("d\0"))).toThrow(
			"Invalid remote directory response",
		);
	});

	it("parses portable file type and size preflight records", () => {
		expect(
			parseRemoteFileMetadata(Buffer.from(["f", "12345", ""].join("\0"))),
		).toEqual({
			type: "f",
			size: 12_345,
		});
		expect(
			parseRemoteFileMetadata(Buffer.from(["l", "0", ""].join("\0"))),
		).toEqual({
			type: "l",
			size: 0,
		});
		expect(() => parseRemoteFileMetadata(Buffer.from("f\0NaN\0"))).toThrow(
			"Invalid remote file metadata response",
		);
	});

	it("rejects names that could change path scope or batch structure", () => {
		expect(validateRemoteEntryName("feature [one].ts")).toBe(
			"feature [one].ts",
		);
		for (const value of ["", ".", "..", "a/b", "a\nb"]) {
			expect(() => validateRemoteEntryName(value)).toThrow(
				"Invalid remote file name",
			);
		}
	});
});
