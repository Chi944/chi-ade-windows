import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_SUPERSET_DIR_NAME } from "shared/constants";
import {
	ensureProjectConfigExists,
	getProjectConfigPath,
} from "./project-config-files";

const originalCwd = process.cwd();
let testRoot: string;
let installedAppDir: string;

describe("project config paths", () => {
	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "ade-config-path-"));
		installedAppDir = join(testRoot, "Program Files", "ADE");
		mkdirSync(installedAppDir, { recursive: true });
		process.chdir(installedAppDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(testRoot, { recursive: true, force: true });
	});

	test("does not write category config beneath the packaged working directory", () => {
		expect(ensureProjectConfigExists("")).toBeNull();
		expect(ensureProjectConfigExists("   ")).toBeNull();
		expect(existsSync(join(installedAppDir, ".superset"))).toBeFalse();
		expect(
			existsSync(join(installedAppDir, PROJECT_SUPERSET_DIR_NAME)),
		).toBeFalse();
	});

	test("rejects corrupt relative repository paths", () => {
		expect(getProjectConfigPath("relative-repository")).toBeNull();
		expect(ensureProjectConfigExists("relative-repository")).toBeNull();
		expect(
			existsSync(join(installedAppDir, "relative-repository")),
		).toBeFalse();
	});

	test("rejects padded absolute repository paths instead of remapping them", () => {
		const repository = join(testRoot, "repository");
		mkdirSync(repository, { recursive: true });

		expect(getProjectConfigPath(` ${repository}`)).toBeNull();
		expect(ensureProjectConfigExists(` ${repository}`)).toBeNull();
	});

	test("does not recreate a missing absolute repository", () => {
		const missingRepository = join(testRoot, "missing-repository");

		expect(getProjectConfigPath(missingRepository)).toBeNull();
		expect(ensureProjectConfigExists(missingRepository)).toBeNull();
		expect(existsSync(missingRepository)).toBeFalse();
	});

	test("creates config only inside an absolute repository path", () => {
		const repository = join(testRoot, "repository");
		mkdirSync(repository, { recursive: true });

		const configPath = ensureProjectConfigExists(repository);

		expect(configPath).toBe(
			join(repository, PROJECT_SUPERSET_DIR_NAME, "config.json"),
		);
		expect(configPath && existsSync(configPath)).toBeTrue();
		expect(configPath && JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(
			{
				setup: [],
				teardown: [],
			},
		);
	});
});
