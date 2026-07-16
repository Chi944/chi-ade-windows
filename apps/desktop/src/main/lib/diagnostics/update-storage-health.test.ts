import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUpdateStorage } from "./update-storage-health";

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
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		});
	});

	it("treats an empty canonical version directory as harmless and unverified", async () => {
		const root = await temporaryRoot();
		await mkdir(join(root, "1.0.0"), { recursive: true });

		expect(await inspectUpdateStorage(root)).toEqual({
			completedInstallerVersions: 0,
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
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 2,
		});
	});

	it("reports an absent update root as an empty healthy inventory", async () => {
		const root = await temporaryRoot();
		const absent = join(root, "updates");

		expect(await inspectUpdateStorage(absent)).toEqual({
			completedInstallerVersions: 0,
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		});
	});
});
