import { describe, expect, mock, test } from "bun:test";
import { createDefaultAppState } from "main/lib/app-state/schemas";
import { stampLocalTabsMutation } from "shared/tabs-sync";

mock.module("main/lib/local-db", () => ({
	localDb: {},
}));

const {
	canonicalizeWorkspace,
	createPortableWorkspaceIdentity,
	matchRequestedCanonicalWorkspaceIds,
	normalizeGitOrigin,
	resolveRequestedLocalWorkspaceIdentities,
} = await import("./workspace-identity");

describe("portable workspace identity", () => {
	test("normalizes HTTPS, credential-bearing HTTPS, SCP, and ssh origins identically", () => {
		const origins = [
			"https://github.com/Chi944/chi-ade-windows.git",
			"https://oauth2:secret-token@GITHUB.COM/Chi944/chi-ade-windows/",
			"git@github.com:Chi944/chi-ade-windows.git",
			"ssh://git@github.com/Chi944/chi-ade-windows.git/",
		];

		const normalized = origins.map(normalizeGitOrigin);
		expect(normalized).toEqual(
			origins.map(() => "github.com/Chi944/chi-ade-windows"),
		);

		const identities = origins.map((origin) =>
			createPortableWorkspaceIdentity({
				origin,
				branch: "main",
				type: "branch",
			}),
		);
		expect(identities.every((identity) => identity.status === "resolved")).toBe(
			true,
		);
		const canonicalIds = identities.flatMap((identity) =>
			identity.status === "resolved" ? [identity.canonical] : [],
		);
		expect(new Set(canonicalIds).size).toBe(1);
	});

	test("normalizes host case, default SSH ports, suffixes, and trailing slashes", () => {
		expect(
			normalizeGitOrigin(
				"ssh://git@GitHub.COM:22/Chi944/chi-ade-windows.GIT///",
			),
		).toBe("github.com/Chi944/chi-ade-windows");
	});

	test("rejects unsupported URL schemes without serializing credentials", () => {
		const secret = "scheme-secret-token";
		for (const scheme of ["http", "git", "ftp"]) {
			const origin = `${scheme}://oauth2:${secret}@github.com/acme/repo.git`;
			expect(normalizeGitOrigin(origin)).toBeNull();
			const identity = createPortableWorkspaceIdentity({
				origin,
				branch: "main",
				type: "branch",
			});
			expect(identity.status).toBe("unresolved");
			expect(JSON.stringify(identity)).not.toContain(secret);
		}
	});

	test("keeps repository, branch, and workspace type in the canonical identity", () => {
		const base = {
			repository: "github.com/Chi944/chi-ade-windows",
			branch: "main",
			type: "branch" as const,
		};
		const canonical = canonicalizeWorkspace(base);

		expect(
			canonicalizeWorkspace({ ...base, repository: "github.com/Chi944/other" }),
		).not.toBe(canonical);
		expect(canonicalizeWorkspace({ ...base, branch: "feature" })).not.toBe(
			canonical,
		);
		expect(canonicalizeWorkspace({ ...base, type: "worktree" })).not.toBe(
			canonical,
		);
	});

	test("batches requested mapping probes by project and filters collisions", () => {
		const mainCanonical = canonicalizeWorkspace({
			repository: "github.com/acme/repo",
			branch: "main",
			type: "branch",
		});
		const readOrigin = mock((path: string) =>
			path === "C:\\repo"
				? "git@github.com:acme/repo.git"
				: "git@github.com:acme/other.git",
		);

		const mappings = matchRequestedCanonicalWorkspaceIds({
			canonicalWorkspaceIds: [mainCanonical],
			projects: [
				{ id: "project-1", mainRepoPath: "C:\\repo" },
				{ id: "project-2", mainRepoPath: "C:\\other" },
				{ id: "project-3", mainRepoPath: "C:\\irrelevant" },
			],
			workspaces: [
				{
					id: "main-workspace",
					projectId: "project-1",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "feature-workspace",
					projectId: "project-1",
					branch: "feature",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "deleting-main-workspace",
					projectId: "project-1",
					branch: "main",
					type: "branch",
					deletingAt: 1,
				},
				{
					id: "other-workspace",
					projectId: "project-2",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "irrelevant-feature-workspace",
					projectId: "project-3",
					branch: "feature",
					type: "branch",
					deletingAt: null,
				},
			],
			readOrigin,
			preferredLocalWorkspaceIdsByCanonical: {
				[mainCanonical]: ["main-workspace"],
			},
			workspaceMetadataByCanonical: {
				[mainCanonical]: {
					repository: "github.com/acme/repo",
					branch: "main",
					type: "branch",
				},
			},
		});

		expect(mappings).toEqual({ [mainCanonical]: "main-workspace" });
		expect(readOrigin.mock.calls.map(([path]) => path)).toEqual([
			"C:\\repo",
			"C:\\other",
		]);

		const duplicateOrigin = mock(() => "git@github.com:acme/repo.git");
		const hiddenPreferredCollision = matchRequestedCanonicalWorkspaceIds({
			canonicalWorkspaceIds: [mainCanonical],
			projects: [
				{ id: "project-a", mainRepoPath: "C:\\clone-a" },
				{ id: "project-b", mainRepoPath: "C:\\clone-b" },
			],
			workspaces: [
				{
					id: "duplicate-a",
					projectId: "project-a",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "duplicate-b",
					projectId: "project-b",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
			],
			readOrigin: duplicateOrigin,
			preferredLocalWorkspaceIdsByCanonical: {
				[mainCanonical]: ["duplicate-a"],
			},
			workspaceMetadataByCanonical: {
				[mainCanonical]: {
					repository: "github.com/acme/repo",
					branch: "main",
					type: "branch",
				},
			},
		});
		expect(hiddenPreferredCollision).toEqual({});
		expect(duplicateOrigin).toHaveBeenCalledTimes(2);

		const collision = matchRequestedCanonicalWorkspaceIds({
			canonicalWorkspaceIds: [mainCanonical],
			projects: [{ id: "project-1", mainRepoPath: "C:\\repo" }],
			workspaces: [
				{
					id: "duplicate-a",
					projectId: "project-1",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "duplicate-b",
					projectId: "project-1",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
			],
			readOrigin,
		});
		expect(collision).toEqual({});
	});

	test("batches reverse identities and invalidates an unchanged owner on a new duplicate", () => {
		const readOrigin = mock((path: string) => {
			if (path === "C:\\unique") return "git@github.com:acme/unique.git";
			if (path === "C:\\unreadable") return "C:\\local-only";
			return "git@github.com:acme/duplicate.git";
		});
		const resolutions = resolveRequestedLocalWorkspaceIdentities({
			workspaceIds: [
				"unique",
				"duplicate-a",
				"duplicate-b",
				"missing",
				"deleted",
				"unreadable",
			],
			projects: [
				{ id: "unique-project", mainRepoPath: "C:\\unique" },
				{ id: "duplicate-project-a", mainRepoPath: "C:\\clone-a" },
				{ id: "duplicate-project-b", mainRepoPath: "C:\\clone-b" },
				{ id: "deleted-project", mainRepoPath: "C:\\deleted" },
				{ id: "unreadable-project", mainRepoPath: "C:\\unreadable" },
			],
			workspaces: [
				{
					id: "unique",
					projectId: "unique-project",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "duplicate-a",
					projectId: "duplicate-project-a",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "duplicate-b",
					projectId: "duplicate-project-b",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
				{
					id: "deleted",
					projectId: "deleted-project",
					branch: "main",
					type: "branch",
					deletingAt: 1,
				},
				{
					id: "unreadable",
					projectId: "unreadable-project",
					branch: "main",
					type: "branch",
					deletingAt: null,
				},
			],
			readOrigin,
		});

		expect(resolutions.unique?.status).toBe("verified");
		expect(resolutions["duplicate-a"]).toEqual({ status: "ambiguous" });
		expect(resolutions["duplicate-b"]).toEqual({ status: "ambiguous" });
		expect(resolutions.missing).toEqual({ status: "missing" });
		expect(resolutions.deleted).toEqual({ status: "deleted" });
		expect(resolutions.unreadable).toEqual({ status: "unresolved" });
		expect(readOrigin).toHaveBeenCalledTimes(4);

		const duplicateCanonical = canonicalizeWorkspace({
			repository: "github.com/acme/duplicate",
			branch: "main",
			type: "branch",
		});
		const state = createDefaultAppState("local-device");
		state.tabsState = {
			tabs: [
				{
					id: "tab",
					name: "Before",
					workspaceId: "duplicate-a",
					createdAt: 1,
					layout: "pane",
				},
			],
			panes: {
				pane: {
					id: "pane",
					tabId: "tab",
					type: "terminal",
					name: "Shell",
				},
			},
			activeTabIds: { "duplicate-a": "tab" },
			focusedPaneIds: { tab: "pane" },
			tabHistoryStacks: { "duplicate-a": [] },
		};
		state.sync.localToCanonical["duplicate-a"] = duplicateCanonical;
		state.sync.perWorkspaceWrittenAt[duplicateCanonical] = {
			deviceId: "local-device",
			at: 10,
		};
		const nextTabs = structuredClone(state.tabsState);
		nextTabs.tabs.push({
			id: "duplicate-tab",
			name: "Duplicate",
			workspaceId: "duplicate-b",
			createdAt: 2,
			layout: "duplicate-pane",
		});
		nextTabs.panes["duplicate-pane"] = {
			id: "duplicate-pane",
			tabId: "duplicate-tab",
			type: "terminal",
			name: "Duplicate shell",
		};
		nextTabs.activeTabIds["duplicate-b"] = "duplicate-tab";
		nextTabs.focusedPaneIds["duplicate-tab"] = "duplicate-pane";
		nextTabs.tabHistoryStacks["duplicate-b"] = [];

		const stamp = stampLocalTabsMutation({
			previousTabs: state.tabsState,
			nextTabs,
			envelope: state.sync,
			identities: resolutions,
			deviceId: "local-device",
			now: 20,
			paneClaudeSessions: {},
		});

		expect(stamp.changedCanonicalIds).toEqual([]);
		expect(stamp.envelope.localToCanonical["duplicate-a"]).toBeUndefined();
		expect(
			stamp.envelope.perWorkspaceWrittenAt[duplicateCanonical],
		).toBeUndefined();
	});

	test("does not include local checkout paths or credentials in portable metadata", () => {
		const windowsPath = String.raw`C:\Users\Alice\secret-project`;
		const macPath = "/Users/alice/secret-project";
		const identity = createPortableWorkspaceIdentity({
			origin:
				"https://alice:super-secret-token@github.com/Chi944/chi-ade-windows.git",
			branch: "main",
			type: "worktree",
		});
		expect(identity.status).toBe("resolved");
		if (identity.status !== "resolved") return;

		expect(identity.metadata).toEqual({
			repository: "github.com/Chi944/chi-ade-windows",
			branch: "main",
			type: "worktree",
		});
		const serialized = JSON.stringify(identity);
		expect(serialized).not.toContain(windowsPath);
		expect(serialized).not.toContain(macPath);
		expect(serialized).not.toContain("alice");
		expect(serialized).not.toContain("super-secret-token");
	});

	test.each([
		String.raw`C:\Users\Alice\repo`,
		"/Users/alice/repo",
		"../relative/repo",
		"file:///Users/alice/repo",
		"file://server/share/repo.git",
	])("returns an unresolved warning for non-portable origin %s", (origin) => {
		const result = createPortableWorkspaceIdentity({
			origin,
			branch: "main",
			type: "branch",
		});

		expect(result).toEqual({
			status: "unresolved",
			warning:
				"Workspace synchronization was skipped because the Git origin is not portable.",
		});
		expect(JSON.stringify(result)).not.toContain(origin);
	});
});
