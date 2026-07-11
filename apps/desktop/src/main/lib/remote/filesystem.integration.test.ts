import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createRemoteDirectory,
	createRemoteFile,
	downloadRemoteEntry,
	RemoteFileConflictError,
	type RemoteFilesystemContext,
	readRemoteDirectory,
	readRemoteFile,
	removeRemoteEntry,
	renameRemoteEntry,
	uploadLocalPaths,
	writeRemoteFile,
} from "./filesystem";
import { createRemoteWorktree } from "./ssh";

const live = process.env.ADE_LIVE_SFTP === "1";
const describeLive = live ? describe : describe.skip;

setDefaultTimeout(60_000);

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name} for the live SFTP test`);
	return value;
}

describeLive("remote filesystem against loopback OpenSSH", () => {
	let context: RemoteFilesystemContext;
	let localDirectory: string;

	beforeAll(async () => {
		context = {
			profile: {
				name: "CI loopback",
				host: requiredEnvironment("ADE_LIVE_SSH_HOST"),
				user: requiredEnvironment("ADE_LIVE_SSH_USER"),
				port: Number(requiredEnvironment("ADE_LIVE_SSH_PORT")),
				identityFile: requiredEnvironment("ADE_LIVE_SSH_IDENTITY"),
			},
			remoteRoot: requiredEnvironment("ADE_LIVE_SSH_ROOT"),
		};
		localDirectory = await fs.mkdtemp(path.join(tmpdir(), "ade-live-sftp-"));
	});

	afterAll(async () => {
		if (localDirectory) {
			await fs.rm(localDirectory, { recursive: true, force: true });
		}
	});

	it("browses hidden files and rejects unsafe preview types", async () => {
		const visible = await readRemoteDirectory(context, "", false);
		expect(visible.some((entry) => entry.name === ".hidden.txt")).toBe(false);

		const all = await readRemoteDirectory(context, "", true);
		expect(all.some((entry) => entry.name === ".hidden.txt")).toBe(true);
		expect(await readRemoteFile(context, "binary.bin")).toEqual({
			ok: false,
			reason: "binary",
		});
		expect(await readRemoteFile(context, "oversized.txt")).toEqual({
			ok: false,
			reason: "too-large",
		});
		expect(await readRemoteFile(context, "link.txt")).toEqual({
			ok: false,
			reason: "binary",
		});
	});

	it("creates, edits, conflict-checks, renames, and preserves mode", async () => {
		const directory = await createRemoteDirectory(context, "", "edit space ü");
		const created = await createRemoteFile(
			context,
			directory.relativePath,
			"note.txt",
		);
		const empty = await readRemoteFile(context, created.relativePath);
		expect(empty.ok).toBe(true);
		if (!empty.ok) throw new Error("The created remote file was not readable");

		await writeRemoteFile(context, {
			relativePath: created.relativePath,
			content: "first remote edit\n",
			expectedRevision: empty.revision,
		});
		const first = await readRemoteFile(context, created.relativePath);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("The first remote edit was not readable");

		const absoluteFile = path.join(
			context.remoteRoot,
			...created.relativePath.split("/"),
		);
		await fs.chmod(absoluteFile, 0o755);
		await writeRemoteFile(context, {
			relativePath: created.relativePath,
			content: "mode-preserving edit\n",
			expectedRevision: first.revision,
		});
		expect((await fs.stat(absoluteFile)).mode & 0o777).toBe(0o755);

		const beforeConflict = await readRemoteFile(context, created.relativePath);
		expect(beforeConflict.ok).toBe(true);
		if (!beforeConflict.ok)
			throw new Error("The conflict fixture was not readable");
		await fs.writeFile(absoluteFile, "out-of-band edit\n", "utf8");
		await expect(
			writeRemoteFile(context, {
				relativePath: created.relativePath,
				content: "stale edit\n",
				expectedRevision: beforeConflict.revision,
			}),
		).rejects.toBeInstanceOf(RemoteFileConflictError);

		const renamed = await renameRemoteEntry(
			context,
			created.relativePath,
			"renamed.txt",
		);
		expect((await readRemoteFile(context, renamed.relativePath)).ok).toBe(true);
		await removeRemoteEntry(context, renamed.relativePath);
		await removeRemoteEntry(context, directory.relativePath);
	});

	it("uploads and downloads through the real SFTP client", async () => {
		const directory = await createRemoteDirectory(context, "", "transfers ü");
		const firstLocal = path.join(localDirectory, "upload ü.txt");
		const secondLocal = path.join(localDirectory, "-option.txt");
		await fs.writeFile(firstLocal, "one\n", "utf8");
		await fs.writeFile(secondLocal, "two\n", "utf8");

		const result = await uploadLocalPaths(context, directory.relativePath, [
			firstLocal,
			secondLocal,
		]);
		expect(result.uploaded).toHaveLength(2);
		const remoteFirst = `${directory.relativePath}/upload ü.txt`;
		expect(await readRemoteFile(context, remoteFirst)).toMatchObject({
			ok: true,
			content: "one\n",
		});
		await expect(
			uploadLocalPaths(context, directory.relativePath, [firstLocal]),
		).rejects.toThrow("already exists");

		const downloadedFile = path.join(localDirectory, "downloaded.txt");
		await fs.writeFile(downloadedFile, "old\n", "utf8");
		await downloadRemoteEntry(context, remoteFirst, downloadedFile);
		expect(await fs.readFile(downloadedFile, "utf8")).toBe("one\n");

		const downloadedDirectory = path.join(
			localDirectory,
			"downloaded-directory",
		);
		await downloadRemoteEntry(
			context,
			directory.relativePath,
			downloadedDirectory,
		);
		expect(
			await fs.readFile(path.join(downloadedDirectory, "-option.txt"), "utf8"),
		).toBe("two\n");

		await removeRemoteEntry(context, `${directory.relativePath}/upload ü.txt`);
		await removeRemoteEntry(context, `${directory.relativePath}/-option.txt`);
		await removeRemoteEntry(context, directory.relativePath);
	});

	it("creates a Git worktree through the real SSH client", async () => {
		const worktreePath = `${context.remoteRoot}/worktree-ci`;
		const result = await createRemoteWorktree(context.profile, {
			repoPath: `${context.remoteRoot}/repo`,
			worktreePath,
			branch: `ci/live-${Date.now()}`,
			baseBranch: "main",
		});
		expect(result.stderr).not.toContain("fatal:");
		expect((await fs.stat(worktreePath)).isDirectory()).toBe(true);
	});
});
