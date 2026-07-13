import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectProject } from "@superset/local-db";
import { PROJECT_SUPERSET_DIR_NAME } from "shared/constants";

const category: SelectProject = {
	id: "category-1",
	mainRepoPath: "",
	name: "Windows Projects",
	color: "default",
	tabOrder: 0,
	isPinned: false,
	lastOpenedAt: Date.now(),
	createdAt: Date.now(),
	configToastDismissed: false,
	defaultBranch: null,
	githubOwner: null,
	branchPrefixMode: null,
	branchPrefixCustom: null,
	hideImage: false,
	iconUrl: null,
	neonProjectId: null,
	defaultApp: null,
	workspaceBaseBranch: null,
	worktreeBaseDir: null,
};

const getProject = mock(() => category);
const localDb = {
	select: () => ({
		from: () => ({
			where: () => ({ get: getProject }),
		}),
	}),
};

mock.module("main/lib/local-db", () => ({ localDb }));
mock.module("main/lib/feature-flags", () => ({
	MEMORY_SCAFFOLD_ENABLED: true,
}));
mock.module("main/lib/runtime-availability", () => ({
	computeRuntimeAvailability: mock(async () => ({})),
}));

const { createConfigRouter } = await import("./config");

const originalCwd = process.cwd();
let testRoot: string;
let installedAppDir: string;

describe("config router categories", () => {
	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "ade-config-router-"));
		installedAppDir = join(testRoot, "Program Files", "ADE");
		mkdirSync(installedAppDir, { recursive: true });
		process.chdir(installedAppDir);
		getProject.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(testRoot, { recursive: true, force: true });
	});

	test("returns safe values without touching the packaged working directory", async () => {
		const caller = createConfigRouter().createCaller({});

		expect(
			await caller.getConfigFilePath({ projectId: category.id }),
		).toBeNull();
		expect(await caller.getConfigContent({ projectId: category.id })).toEqual({
			content: null,
			exists: false,
		});
		expect(
			await caller.shouldShowSetupCard({ projectId: category.id }),
		).toBeFalse();
		expect(
			await caller.getSetupOnboardingDefaults({ projectId: category.id }),
		).toEqual({
			projectSummary: "",
			actions: [],
			setupTemplate: [],
			signals: {},
		});
		await expect(
			caller.updateConfig({
				projectId: category.id,
				setup: ["bun install"],
				teardown: [],
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});

		expect(existsSync(join(installedAppDir, ".superset"))).toBeFalse();
		expect(
			existsSync(join(installedAppDir, PROJECT_SUPERSET_DIR_NAME)),
		).toBeFalse();
	});
});
