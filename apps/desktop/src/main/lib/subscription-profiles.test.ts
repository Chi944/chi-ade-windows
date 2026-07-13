import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubscriptionProfile,
	getSelectedSubscriptionProfile,
	getSubscriptionProfileEnvironment,
	getSubscriptionProfileEnvironmentForPane,
	getSubscriptionProfileHome,
	listSubscriptionProfiles,
	pruneOrphanedSubscriptionHomes,
	releaseSubscriptionProfilePane,
	releaseSubscriptionProfileWorkspace,
	removeSubscriptionProfile,
	selectSubscriptionProfile,
	setSubscriptionProfilesRootForTests,
} from "./subscription-profiles";

const TEST_ROOT = join(
	tmpdir(),
	`ade-subscription-profiles-${process.pid}-${Date.now()}`,
);
const LINK_TEST_ROOT = `${TEST_ROOT}-linked-provider`;
const UNBOUND_TEST_ROOT = `${TEST_ROOT}-unbound`;
const PRUNE_TEST_ROOT = `${TEST_ROOT}-prune`;
const CAP_TEST_ROOT = `${TEST_ROOT}-cap`;
const WORKSPACE_TEST_ROOT = `${TEST_ROOT}-workspace`;

function legacyUnboundHome(
	root: string,
	provider: "claude" | "codex",
	scope: string,
): string {
	const suffix = createHash("sha256").update(scope).digest("hex").slice(0, 32);
	return join(root, provider, `unbound-${suffix}`);
}

describe("subscription profiles", () => {
	beforeAll(() => {
		setSubscriptionProfilesRootForTests(TEST_ROOT);
	});

	afterAll(() => {
		setSubscriptionProfilesRootForTests(null);
		rmSync(TEST_ROOT, { recursive: true, force: true });
		rmSync(LINK_TEST_ROOT, { recursive: true, force: true });
		rmSync(UNBOUND_TEST_ROOT, { recursive: true, force: true });
		rmSync(PRUNE_TEST_ROOT, { recursive: true, force: true });
		rmSync(CAP_TEST_ROOT, { recursive: true, force: true });
		rmSync(WORKSPACE_TEST_ROOT, { recursive: true, force: true });
	});

	it("releases workspace bindings without deleting named account homes", () => {
		setSubscriptionProfilesRootForTests(WORKSPACE_TEST_ROOT);
		try {
			const claudeProfile = createSubscriptionProfile("claude", "Personal");
			const codexProfile = createSubscriptionProfile("codex", "Personal");
			const paneA = getSubscriptionProfileEnvironmentForPane(
				"claude",
				"workspace-pane-a",
				"workspace-delete",
			).environment.CLAUDE_CONFIG_DIR;
			const paneB = getSubscriptionProfileEnvironmentForPane(
				"codex",
				"workspace-pane-b",
				"workspace-delete",
			).environment.CODEX_HOME;
			const retainedPane = getSubscriptionProfileEnvironmentForPane(
				"codex",
				"workspace-pane-c",
				"workspace-keep",
			).environment.CODEX_HOME;

			expect(releaseSubscriptionProfileWorkspace("workspace-delete")).toBe(2);
			expect(paneA).toBe(getSubscriptionProfileHome(claudeProfile));
			expect(paneB).toBe(getSubscriptionProfileHome(codexProfile));
			expect(existsSync(paneA)).toBe(true);
			expect(existsSync(paneB)).toBe(true);
			expect(existsSync(retainedPane)).toBe(true);
			expect(releaseSubscriptionProfileWorkspace("workspace-delete")).toBe(0);
		} finally {
			setSubscriptionProfilesRootForTests(TEST_ROOT);
		}
	});

	it("uses the native system account when no named profile is selected", () => {
		setSubscriptionProfilesRootForTests(UNBOUND_TEST_ROOT);
		try {
			const status = getSubscriptionProfileEnvironment("claude");
			const paneA = getSubscriptionProfileEnvironmentForPane("codex", "pane-a");
			const paneB = getSubscriptionProfileEnvironmentForPane("codex", "pane-b");

			expect(status).toEqual({ source: "system", environment: {} });
			expect(paneA).toEqual({ source: "system", environment: {} });
			expect(paneB).toEqual({ source: "system", environment: {} });
			expect(listSubscriptionProfiles().selected).toEqual({});
		} finally {
			setSubscriptionProfilesRootForTests(TEST_ROOT);
		}
	});

	it("prunes legacy unbound homes while preserving active and status homes", () => {
		setSubscriptionProfilesRootForTests(PRUNE_TEST_ROOT);
		try {
			getSubscriptionProfileEnvironmentForPane("codex", "active-pane");
			getSubscriptionProfileEnvironmentForPane("codex", "orphan-pane");
			const statusHome = legacyUnboundHome(
				PRUNE_TEST_ROOT,
				"codex",
				"no-selected-profile",
			);
			const activeHome = legacyUnboundHome(
				PRUNE_TEST_ROOT,
				"codex",
				"pane:active-pane",
			);
			const orphanHome = legacyUnboundHome(
				PRUNE_TEST_ROOT,
				"codex",
				"pane:orphan-pane",
			);
			for (const home of [statusHome, activeHome, orphanHome]) {
				mkdirSync(home, { recursive: true });
			}

			const metadataPath = join(PRUNE_TEST_ROOT, "profiles.json");
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
				bindings: Record<string, unknown>;
			};
			delete metadata.bindings["orphan-pane"];
			writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

			expect(pruneOrphanedSubscriptionHomes()).toBe(1);
			expect(existsSync(orphanHome)).toBe(false);
			expect(existsSync(activeHome)).toBe(true);
			expect(existsSync(statusHome)).toBe(true);

			expect(releaseSubscriptionProfilePane("active-pane")).toBe(true);
			expect(existsSync(activeHome)).toBe(false);
			expect(releaseSubscriptionProfilePane("active-pane")).toBe(false);

			getSubscriptionProfileEnvironmentForPane("codex", "recovered-pane");
			const recoveredHome = legacyUnboundHome(
				PRUNE_TEST_ROOT,
				"codex",
				"pane:recovered-pane",
			);
			mkdirSync(recoveredHome, { recursive: true });
			rmSync(metadataPath);
			expect(pruneOrphanedSubscriptionHomes()).toBe(0);
			expect(existsSync(recoveredHome)).toBe(true);
		} finally {
			setSubscriptionProfilesRootForTests(TEST_ROOT);
		}
	});

	it("refuses to evict a live binding when the safety cap is reached", () => {
		setSubscriptionProfilesRootForTests(CAP_TEST_ROOT);
		try {
			getSubscriptionProfileEnvironmentForPane("claude", "pane-0");
			const metadataPath = join(CAP_TEST_ROOT, "profiles.json");
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
				bindings: Record<string, unknown>;
			};
			const originalBinding = metadata.bindings["pane-0"];
			metadata.bindings = Object.fromEntries(
				Array.from({ length: 5000 }, (_, index) => [
					`pane-${index}`,
					{ ...(originalBinding as object), createdAt: index },
				]),
			);
			writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

			expect(() =>
				getSubscriptionProfileEnvironmentForPane("claude", "pane-over-cap"),
			).toThrow("Too many remembered terminal sessions");
			const unchangedMetadata = JSON.parse(
				readFileSync(metadataPath, "utf8"),
			) as { bindings: Record<string, unknown> };
			expect(Object.keys(unchangedMetadata.bindings)).toHaveLength(5000);
		} finally {
			setSubscriptionProfilesRootForTests(TEST_ROOT);
		}
	});

	it("atomically creates, selects, and removes isolated account homes", () => {
		const personal = createSubscriptionProfile("codex", "Personal");
		const work = createSubscriptionProfile("codex", "Work");

		expect(getSelectedSubscriptionProfile("codex")?.id).toBe(work.id);
		expect(
			getSubscriptionProfileEnvironmentForPane("codex", "pane-a").environment
				.CODEX_HOME,
		).toBe(getSubscriptionProfileHome(work));
		selectSubscriptionProfile("codex", personal.id);
		expect(
			getSubscriptionProfileEnvironment("codex").environment.CODEX_HOME,
		).toBe(getSubscriptionProfileHome(personal));
		expect(
			getSubscriptionProfileEnvironmentForPane("codex", "pane-a").environment
				.CODEX_HOME,
		).toBe(getSubscriptionProfileHome(work));
		expect(
			getSubscriptionProfileEnvironmentForPane("codex", "pane-b").environment
				.CODEX_HOME,
		).toBe(getSubscriptionProfileHome(personal));

		removeSubscriptionProfile("codex", personal.id);
		expect(existsSync(getSubscriptionProfileHome(personal))).toBe(false);
		expect(getSelectedSubscriptionProfile("codex")?.id).toBe(work.id);
		expect(listSubscriptionProfiles().profiles).toHaveLength(1);
		expect(releaseSubscriptionProfilePane("pane-a")).toBe(true);
		expect(existsSync(getSubscriptionProfileHome(work))).toBe(true);

		selectSubscriptionProfile("codex", null);
		expect(getSelectedSubscriptionProfile("codex")).toBeNull();
		expect(getSubscriptionProfileEnvironment("codex")).toEqual({
			source: "system",
			environment: {},
		});
		expect(
			getSubscriptionProfileEnvironmentForPane("codex", "pane-system"),
		).toEqual({ source: "system", environment: {} });
	});

	it("refuses to recursively remove a linked profile directory", () => {
		const profile = createSubscriptionProfile("claude", "Linked");
		const profileHome = getSubscriptionProfileHome(profile);
		const externalHome = join(TEST_ROOT, "external-home");
		const sentinel = join(externalHome, "credential");
		rmSync(profileHome, { recursive: true, force: true });
		mkdirSync(externalHome, { recursive: true });
		writeFileSync(sentinel, "do-not-delete", "utf8");
		symlinkSync(
			externalHome,
			profileHome,
			process.platform === "win32" ? "junction" : "dir",
		);

		expect(() => removeSubscriptionProfile("claude", profile.id)).toThrow(
			"linked account profile",
		);
		expect(existsSync(sentinel)).toBe(true);
		expect(
			listSubscriptionProfiles().profiles.some(
				(item) => item.id === profile.id,
			),
		).toBe(true);
	});

	it("refuses to create credentials through a linked provider directory", () => {
		const externalProvider = join(LINK_TEST_ROOT, "external-provider");
		const linkedProvider = join(LINK_TEST_ROOT, "accounts", "codex");
		mkdirSync(join(LINK_TEST_ROOT, "accounts"), { recursive: true });
		mkdirSync(externalProvider, { recursive: true });
		symlinkSync(
			externalProvider,
			linkedProvider,
			process.platform === "win32" ? "junction" : "dir",
		);

		setSubscriptionProfilesRootForTests(join(LINK_TEST_ROOT, "accounts"));
		try {
			expect(() => createSubscriptionProfile("codex", "Unsafe")).toThrow(
				"linked provider account",
			);
		} finally {
			setSubscriptionProfilesRootForTests(TEST_ROOT);
		}
	});

	it("does not overwrite damaged profile metadata", () => {
		const metadata = join(TEST_ROOT, "profiles.json");
		writeFileSync(metadata, "{truncated", "utf8");
		expect(() => createSubscriptionProfile("codex", "Do not create")).toThrow(
			"metadata is damaged",
		);
		expect(readFileSync(metadata, "utf8")).toBe("{truncated");
	});
});
