import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectUpdateStorage,
	pruneCompletedInstallerVersions,
} from "./update-storage-health";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ade-update-health-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

async function writeInstaller(
	root: string,
	version: string,
	name: string,
	contents = "completed installer",
): Promise<void> {
	const directory = join(root, version);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, name), contents);
}

describe("update storage health", () => {
	it("accepts one non-empty completed installer in each of multiple versions", async () => {
		const root = await temporaryRoot();
		await writeInstaller(root, "1.0.0", "ADE-Windows-x64.exe");
		await writeInstaller(root, "1.1.0", "ADE-macOS-Apple-Silicon.dmg");

		expect(await inspectUpdateStorage(root)).toEqual({
			completedInstallerVersions: 2,
			completedInstallerBytes: 2 * Buffer.byteLength("completed installer"),
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		});
	});

	it("treats an empty canonical version directory as harmless and unverified", async () => {
		const root = await temporaryRoot();
		await mkdir(join(root, "1.0.0"), { recursive: true });

		expect(await inspectUpdateStorage(root)).toEqual({
			completedInstallerVersions: 0,
			completedInstallerBytes: 0,
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		});
	});

	it("does not treat partial, zero-byte, or malformed staging as completed", async () => {
		const root = await temporaryRoot();
		await writeInstaller(root, "1.1.0", "ADE-Windows-x64.exe.build-4.part");
		await writeInstaller(root, "1.2.0", "ADE-Windows-x64.exe", "");
		await writeInstaller(root, "not-a-version", "ADE-Windows-x64.exe");
		await writeFile(join(root, "orphan.part"), "partial");

		expect(await inspectUpdateStorage(root)).toEqual({
			completedInstallerVersions: 0,
			completedInstallerBytes: 0,
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 4,
		});
	});

	it("reports extra completed installers within a version without penalizing other versions", async () => {
		const root = await temporaryRoot();
		await writeInstaller(root, "2.0.0", "ADE-Windows-x64.exe");
		await writeInstaller(root, "2.0.0", "ADE-macOS-Intel.dmg");
		await writeInstaller(root, "2.1.0", "ADE-Windows-x64.exe");

		expect(await inspectUpdateStorage(root)).toEqual({
			completedInstallerVersions: 2,
			completedInstallerBytes: 3 * Buffer.byteLength("completed installer"),
			updateVersionOverageCount: 1,
			invalidUpdateEntryCount: 0,
		});
	});

	it("treats unexpected files and nested entries as invalid", async () => {
		const root = await temporaryRoot();
		await writeInstaller(root, "3.0.0", "ADE-Windows-x64.exe");
		await writeInstaller(root, "3.0.0", "notes.txt");
		await mkdir(join(root, "3.0.0", "nested"));

		expect(await inspectUpdateStorage(root)).toEqual({
			completedInstallerVersions: 1,
			completedInstallerBytes: Buffer.byteLength("completed installer"),
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 2,
		});
	});

	it("reports an absent update root as an empty healthy inventory", async () => {
		const root = await temporaryRoot();
		const absent = join(root, "updates");

		expect(await inspectUpdateStorage(absent)).toEqual({
			completedInstallerVersions: 0,
			completedInstallerBytes: 0,
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		});
	});

	it("never follows a linked version directory while pruning", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await writeInstaller(root, "1.0.0", "ADE-Windows-x64.exe", "current");
		await writeInstaller(outside, "linked", "ADE-Windows-x64.exe", "outside");
		await symlink(
			join(outside, "linked"),
			join(root, "0.9.0"),
			process.platform === "win32" ? "junction" : "dir",
		);

		await pruneCompletedInstallerVersions(root, "1.0.0");

		expect(
			await readFile(join(outside, "linked", "ADE-Windows-x64.exe"), "utf8"),
		).toBe("outside");
	});

	it("rejects a linked update root without pruning the external target", async () => {
		const container = await temporaryRoot();
		const outside = await temporaryRoot();
		for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
			await writeInstaller(outside, version, "ADE-Windows-x64.exe", version);
		}
		const linkedRoot = join(container, "updates");
		await symlink(
			outside,
			linkedRoot,
			process.platform === "win32" ? "junction" : "dir",
		);

		await expect(
			pruneCompletedInstallerVersions(linkedRoot, "3.0.0"),
		).rejects.toThrow("Update storage root must be a non-link directory");
		await expect(inspectUpdateStorage(linkedRoot)).rejects.toThrow(
			"Update storage root must be a non-link directory",
		);
		expect(
			await readFile(join(outside, "1.0.0", "ADE-Windows-x64.exe"), "utf8"),
		).toBe("1.0.0");
	});

	it("removes an older candidate when cumulative installer bytes exceed the cap", async () => {
		const root = await temporaryRoot();
		const older = join(root, "1.0.0", "ADE-Windows-x64.exe");
		const current = join(root, "2.0.0", "ADE-Windows-x64.exe");
		await writeInstaller(root, "1.0.0", "ADE-Windows-x64.exe", "123456");
		await writeInstaller(root, "2.0.0", "ADE-Windows-x64.exe", "abcdef");

		await pruneCompletedInstallerVersions(root, "2.0.0", {
			maxVersions: 2,
			maxBytes: 10,
		});

		expect((await stat(current)).size).toBe(6);
		await expect(stat(older)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes an oversized installer even when it belongs to the current version", async () => {
		const root = await temporaryRoot();
		const current = join(root, "2.0.0", "ADE-Windows-x64.exe");
		await writeInstaller(root, "2.0.0", "ADE-Windows-x64.exe", "oversized");

		await pruneCompletedInstallerVersions(root, "2.0.0", {
			maxVersions: 2,
			maxBytes: 8,
		});

		await expect(stat(current)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
