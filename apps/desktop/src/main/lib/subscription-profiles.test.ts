import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSubscriptionProfileStorageRootForTests } from "./subscription-profile-storage";
import {
	bindSubscriptionProfileToPane,
	createSubscriptionProfile,
	getSelectedSubscriptionProfile,
	getSubscriptionProfileEnvironment,
	getSubscriptionProfileEnvironmentForPane,
	getSubscriptionProfileHome,
	getSubscriptionProfilePaneBinding,
	initializeSubscriptionProfiles,
	listSubscriptionProfiles,
	pruneOrphanedSubscriptionHomes,
	reconcileSubscriptionProfilePaneBindings,
	releaseSubscriptionProfilePane,
	releaseSubscriptionProfileWorkspace,
	removeSubscriptionProfile,
	selectSubscriptionProfile,
	setSubscriptionProfilesRootForTests,
} from "./subscription-profiles";

const TEST_ROOT = join(
	realpathSync.native(tmpdir()),
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
		expect(
			readFileSync(
				join(getSubscriptionProfileHome(personal), "config.toml"),
				"utf8",
			),
		).toContain('cli_auth_credentials_store = "file"');

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

		expect(releaseSubscriptionProfilePane("pane-b")).toBe(true);
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

	it("adds file-backed credentials when a resolved Codex profile has no config", () => {
		const profile = createSubscriptionProfile("codex", "Missing config");
		const configPath = join(getSubscriptionProfileHome(profile), "config.toml");
		rmSync(configPath);

		expect(getSubscriptionProfileEnvironment("codex")).toEqual({
			source: "profile",
			profileId: profile.id,
			environment: { CODEX_HOME: getSubscriptionProfileHome(profile) },
		});
		expect(readFileSync(configPath, "utf8")).toContain(
			'cli_auth_credentials_store = "file"',
		);
	});

	it("preserves unrelated TOML while adding the Codex credential store", () => {
		const profile = createSubscriptionProfile("codex", "Existing config");
		const configPath = join(getSubscriptionProfileHome(profile), "config.toml");
		writeFileSync(
			configPath,
			'model = "gpt-5.4"\n[features]\nweb_search = true\n',
			"utf8",
		);

		getSubscriptionProfileEnvironment("codex");
		const migrated = readFileSync(configPath, "utf8");
		expect(migrated).toContain('model = "gpt-5.4"');
		expect(migrated).toContain("[features]\nweb_search = true\n");
		expect(migrated).toContain('cli_auth_credentials_store = "file"');
		expect(migrated.indexOf("cli_auth_credentials_store")).toBeLessThan(
			migrated.indexOf("[features]"),
		);
	});

	it("replaces an existing non-file Codex credential store assignment", () => {
		const profile = createSubscriptionProfile("codex", "Keyring config");
		const configPath = join(getSubscriptionProfileHome(profile), "config.toml");
		writeFileSync(
			configPath,
			'model = "gpt-5.4"\ncli_auth_credentials_store = "keyring"\n[features]\nweb_search = true\n',
			"utf8",
		);

		getSubscriptionProfileEnvironment("codex");
		const migrated = readFileSync(configPath, "utf8");
		expect(migrated).not.toContain('cli_auth_credentials_store = "keyring"');
		expect(migrated.match(/^cli_auth_credentials_store\s*=/gm)).toHaveLength(1);
		expect(migrated).toContain('cli_auth_credentials_store = "file"');
		expect(migrated).toContain('model = "gpt-5.4"');
		expect(migrated).toContain("[features]\nweb_search = true\n");
	});

	it("migrates an existing Codex config idempotently", () => {
		const profile = createSubscriptionProfile("codex", "Idempotent config");
		const configPath = join(getSubscriptionProfileHome(profile), "config.toml");
		writeFileSync(configPath, 'model = "gpt-5.4"\n', "utf8");

		getSubscriptionProfileEnvironment("codex");
		const firstMigration = readFileSync(configPath, "utf8");
		expect(firstMigration).toContain('cli_auth_credentials_store = "file"');
		getSubscriptionProfileEnvironment("codex");
		expect(readFileSync(configPath, "utf8")).toBe(firstMigration);
	});

	it("binds an explicit account to a pane and permits identical retries", () => {
		const personal = createSubscriptionProfile("codex", "Bound personal");
		const work = createSubscriptionProfile("codex", "Bound work");

		bindSubscriptionProfileToPane(
			"codex",
			"pane-explicit",
			personal.id,
			"workspace-explicit",
		);
		selectSubscriptionProfile("codex", work.id);

		expect(() =>
			bindSubscriptionProfileToPane(
				"codex",
				"pane-explicit",
				personal.id,
				"workspace-explicit",
			),
		).not.toThrow();
		expect(
			getSubscriptionProfileEnvironmentForPane(
				"codex",
				"pane-explicit",
				"workspace-explicit",
			).environment.CODEX_HOME,
		).toBe(getSubscriptionProfileHome(personal));
	});

	it("reads a device-local pane binding without changing it", () => {
		const named = createSubscriptionProfile("codex", "Lookup account");
		bindSubscriptionProfileToPane(
			"codex",
			"pane-binding-lookup",
			named.id,
			"workspace-binding-lookup",
		);

		expect(
			getSubscriptionProfilePaneBinding(
				"codex",
				"pane-binding-lookup",
				"workspace-binding-lookup",
			),
		).toEqual({
			provider: "codex",
			profileId: named.id,
			label: "Lookup account",
		});
		expect(
			getSubscriptionProfilePaneBinding(
				"codex",
				"pane-binding-lookup",
				"other-workspace",
			),
		).toBeNull();
		expect(
			getSubscriptionProfilePaneBinding(
				"claude",
				"pane-binding-lookup",
				"workspace-binding-lookup",
			),
		).toBeNull();
	});

	it("reads an explicit System pane binding", () => {
		bindSubscriptionProfileToPane(
			"claude",
			"pane-system-lookup",
			null,
			"workspace-system-lookup",
		);

		expect(
			getSubscriptionProfilePaneBinding(
				"claude",
				"pane-system-lookup",
				"workspace-system-lookup",
			),
		).toEqual({
			provider: "claude",
			profileId: null,
			label: "System",
		});
	});

	it("rejects conflicting pane account, provider, and workspace bindings", () => {
		const personal = createSubscriptionProfile("claude", "Claude personal");
		const work = createSubscriptionProfile("claude", "Claude work");
		bindSubscriptionProfileToPane(
			"claude",
			"pane-conflict",
			personal.id,
			"workspace-a",
		);

		expect(() =>
			bindSubscriptionProfileToPane(
				"claude",
				"pane-conflict",
				work.id,
				"workspace-a",
			),
		).toThrow("different account");
		expect(() =>
			bindSubscriptionProfileToPane(
				"codex",
				"pane-conflict",
				null,
				"workspace-a",
			),
		).toThrow("different provider");
		expect(() =>
			bindSubscriptionProfileToPane(
				"claude",
				"pane-conflict",
				personal.id,
				"workspace-b",
			),
		).toThrow("different workspace");
	});

	it("validates explicit profile ownership and supports the system account", () => {
		const codexProfile = createSubscriptionProfile("codex", "Codex only");
		expect(() =>
			bindSubscriptionProfileToPane(
				"claude",
				"pane-wrong-provider",
				codexProfile.id,
				"workspace-profile-validation",
			),
		).toThrow("Account profile not found");

		bindSubscriptionProfileToPane(
			"claude",
			"pane-system-explicit",
			null,
			"workspace-profile-validation",
		);
		expect(
			getSubscriptionProfileEnvironmentForPane(
				"claude",
				"pane-system-explicit",
				"workspace-profile-validation",
			),
		).toEqual({ source: "system", environment: {} });
	});

	it("does not remove an account that is pinned to a saved pane", () => {
		const profile = createSubscriptionProfile("claude", "Retained account");
		bindSubscriptionProfileToPane(
			"claude",
			"pane-retained-account",
			profile.id,
			"workspace-retained-account",
		);

		expect(() => removeSubscriptionProfile("claude", profile.id)).toThrow(
			"pinned to a saved terminal pane",
		);
		expect(existsSync(getSubscriptionProfileHome(profile))).toBe(true);
		expect(
			listSubscriptionProfiles().profiles.some(
				(item) => item.id === profile.id,
			),
		).toBe(true);
		expect(releaseSubscriptionProfilePane("pane-retained-account")).toBe(true);
		expect(() => removeSubscriptionProfile("claude", profile.id)).not.toThrow();
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

const MIGRATION_TEST_ROOT = join(
	realpathSync.native(tmpdir()),
	`ade-subscription-profile-migration-${process.pid}-${Date.now()}`,
);
const MIGRATION_ADE_HOME = join(MIGRATION_TEST_ROOT, "syncable-home");
const MIGRATION_LEGACY_ROOT = join(MIGRATION_ADE_HOME, "provider-accounts");
const MIGRATION_PRIVATE_ROOT = join(
	MIGRATION_TEST_ROOT,
	"local-private",
	"provider-accounts",
);

function copyRegularFile(source: string, destination: string): void {
	copyFileSync(source, destination);
}

function createLegacyProfileFixture(): {
	profileId: string;
	credentialPath: string;
} {
	setSubscriptionProfilesRootForTests(MIGRATION_LEGACY_ROOT);
	const profile = createSubscriptionProfile("codex", "Migrated Codex");
	bindSubscriptionProfileToPane(
		"codex",
		"migrated-pane",
		profile.id,
		"migrated-workspace",
	);
	const credentialPath = join(getSubscriptionProfileHome(profile), "auth.json");
	writeFileSync(credentialPath, '{"token":"device-secret"}\n', {
		encoding: "utf8",
		mode: 0o600,
	});
	setSubscriptionProfilesRootForTests(null);
	return { profileId: profile.id, credentialPath };
}

function writeSimpleAccountTree(root: string, value: string): void {
	mkdirSync(join(root, "claude", "11111111-1111-4111-8111-111111111111"), {
		recursive: true,
		mode: 0o700,
	});
	writeFileSync(
		join(
			root,
			"claude",
			"11111111-1111-4111-8111-111111111111",
			"credentials.json",
		),
		value,
		"utf8",
	);
}

describe("subscription profile storage migration", () => {
	beforeEach(() => {
		rmSync(MIGRATION_TEST_ROOT, { recursive: true, force: true });
		mkdirSync(MIGRATION_ADE_HOME, { recursive: true, mode: 0o700 });
		setSubscriptionProfilesRootForTests(null);
		setSubscriptionProfileStorageRootForTests(MIGRATION_PRIVATE_ROOT);
	});

	afterEach(() => {
		setSubscriptionProfileStorageRootForTests(null);
		setSubscriptionProfilesRootForTests(TEST_ROOT);
		rmSync(MIGRATION_TEST_ROOT, { recursive: true, force: true });
	});

	it("migrates profiles, Codex configuration, and pane bindings after a safe host stop", async () => {
		const fixture = createLegacyProfileFixture();
		const events: string[] = [];

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {
				events.push("stop");
				expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(true);
				expect(existsSync(MIGRATION_PRIVATE_ROOT)).toBe(false);
			},
			resetTerminalService: () => {
				events.push("reset");
				expect(existsSync(MIGRATION_PRIVATE_ROOT)).toBe(true);
				expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(true);
			},
		});

		expect(result).toMatchObject({
			root: MIGRATION_PRIVATE_ROOT,
			migrationStatus: "migrated",
		});
		expect(events).toEqual(["stop", "reset"]);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
		expect(
			readFileSync(join(MIGRATION_PRIVATE_ROOT, "profiles.json"), "utf8"),
		).toContain(fixture.profileId);
		expect(
			readFileSync(
				join(MIGRATION_PRIVATE_ROOT, "codex", fixture.profileId, "config.toml"),
				"utf8",
			),
		).toContain('cli_auth_credentials_store = "file"');
		expect(
			getSubscriptionProfilePaneBinding(
				"codex",
				"migrated-pane",
				"migrated-workspace",
			)?.profileId,
		).toBe(fixture.profileId);
		expect(existsSync(fixture.credentialPath)).toBe(false);
		expect(
			readFileSync(
				join(MIGRATION_PRIVATE_ROOT, "codex", fixture.profileId, "auth.json"),
				"utf8",
			),
		).toContain("device-secret");
	});

	it("falls back to a verified copy when atomic promotion reports EXDEV", async () => {
		createLegacyProfileFixture();
		let promotionAttempts = 0;

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
			renameForMigration: (source, destination) => {
				if (
					destination === MIGRATION_PRIVATE_ROOT &&
					promotionAttempts++ === 0
				) {
					const error = new Error(
						"cross-device rename",
					) as NodeJS.ErrnoException;
					error.code = "EXDEV";
					throw error;
				}
				renameSync(source, destination);
			},
		});

		expect(result.migrationStatus).toBe("migrated");
		expect(promotionAttempts).toBeGreaterThan(0);
		expect(existsSync(join(MIGRATION_PRIVATE_ROOT, "profiles.json"))).toBe(
			true,
		);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
	});

	it("keeps the final destination absent throughout an EXDEV fallback copy", async () => {
		createLegacyProfileFixture();
		let promotionAttempts = 0;
		let fallbackCopyObserved = false;
		let destinationWasVisibleDuringFallback = false;

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
			renameForMigration: (source, destination) => {
				if (
					destination === MIGRATION_PRIVATE_ROOT &&
					promotionAttempts++ === 0
				) {
					const error = new Error(
						"cross-device rename",
					) as NodeJS.ErrnoException;
					error.code = "EXDEV";
					throw error;
				}
				renameSync(source, destination);
			},
			copyFileForMigration: (source, destination) => {
				if (source.includes(".provider-accounts-migration-")) {
					fallbackCopyObserved = true;
					destinationWasVisibleDuringFallback ||= existsSync(
						MIGRATION_PRIVATE_ROOT,
					);
				}
				copyRegularFile(source, destination);
			},
		});

		expect(result.migrationStatus).toBe("migrated");
		expect(fallbackCopyObserved).toBe(true);
		expect(destinationWasVisibleDuringFallback).toBe(false);
	});

	it("keeps the legacy root active when staged hashes do not verify", async () => {
		const fixture = createLegacyProfileFixture();
		let resetCalls = 0;

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {
				resetCalls += 1;
			},
			copyFileForMigration: (source, destination) => {
				copyRegularFile(source, destination);
				if (source.endsWith("auth.json")) {
					writeFileSync(destination, "corrupted-copy", "utf8");
				}
			},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_LEGACY_ROOT);
		expect(result.warning).toContain("retry");
		expect(resetCalls).toBe(0);
		expect(existsSync(fixture.credentialPath)).toBe(true);
		expect(existsSync(MIGRATION_PRIVATE_ROOT)).toBe(false);
	});

	it("keeps the verified private copy active when legacy removal is partial", async () => {
		const fixture = createLegacyProfileFixture();

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
			removeTreeForMigration: (root) => {
				rmSync(join(root, "profiles.json"), { force: true });
				throw new Error("simulated partial legacy cleanup");
			},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(result.warning).toContain("cleanup");
		expect(existsSync(MIGRATION_PRIVATE_ROOT)).toBe(true);
		expect(
			readFileSync(
				join(MIGRATION_PRIVATE_ROOT, "codex", fixture.profileId, "auth.json"),
				"utf8",
			),
		).toContain("device-secret");
	});

	it("keeps intact legacy active when cutover reset fails without deleting the verified copy", async () => {
		const fixture = createLegacyProfileFixture();

		const first = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {
				throw new Error("simulated reset failure");
			},
		});

		expect(first.migrationStatus).toBe("deferred");
		expect(first.root).toBe(MIGRATION_LEGACY_ROOT);
		expect(existsSync(fixture.credentialPath)).toBe(true);
		expect(
			readFileSync(
				join(MIGRATION_PRIVATE_ROOT, "codex", fixture.profileId, "auth.json"),
				"utf8",
			),
		).toContain("device-secret");

		const second = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(second.migrationStatus).toBe("duplicate-removed");
		expect(second.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
	});

	it("never reactivates a partially removed legacy conflict on the next launch", async () => {
		writeSimpleAccountTree(MIGRATION_LEGACY_ROOT, "legacy-credential");
		writeSimpleAccountTree(MIGRATION_PRIVATE_ROOT, "private-credential");

		const first = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
			removeTreeForMigration: (root) => {
				rmSync(
					join(
						root,
						"claude",
						"11111111-1111-4111-8111-111111111111",
						"credentials.json",
					),
					{ force: true },
				);
				throw new Error("simulated partial conflict cleanup");
			},
		});

		expect(first.migrationStatus).toBe("deferred");
		expect(first.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(first.recoveryRoot).toBeTruthy();

		const second = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(second.migrationStatus).toBe("deferred");
		expect(second.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(second.recoveryRoot).toBe(first.recoveryRoot);
		expect(
			readFileSync(
				join(
					first.recoveryRoot as string,
					"claude",
					"11111111-1111-4111-8111-111111111111",
					"credentials.json",
				),
				"utf8",
			),
		).toBe("legacy-credential");
	});

	it("keeps an existing verified private root active when recovery is unusable", async () => {
		writeSimpleAccountTree(MIGRATION_LEGACY_ROOT, "legacy-credential");
		writeSimpleAccountTree(MIGRATION_PRIVATE_ROOT, "private-credential");
		const linkedTarget = join(MIGRATION_TEST_ROOT, "linked-recovery-target");
		mkdirSync(linkedTarget, { recursive: true });
		symlinkSync(
			linkedTarget,
			join(
				join(MIGRATION_PRIVATE_ROOT, ".."),
				"provider-accounts-legacy-recovery",
			),
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(true);
	});

	it("refuses nested links in legacy provider storage", async () => {
		writeSimpleAccountTree(MIGRATION_LEGACY_ROOT, "legacy-credential");
		const linkedTarget = join(MIGRATION_TEST_ROOT, "linked-legacy-target");
		mkdirSync(linkedTarget, { recursive: true });
		symlinkSync(
			linkedTarget,
			join(MIGRATION_LEGACY_ROOT, "claude", "linked-home"),
			process.platform === "win32" ? "junction" : "dir",
		);
		let resetCalls = 0;

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {
				resetCalls += 1;
			},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_LEGACY_ROOT);
		expect(resetCalls).toBe(0);
		expect(existsSync(MIGRATION_PRIVATE_ROOT)).toBe(false);
	});

	it("removes only a verified legacy duplicate when both roots are identical", async () => {
		writeSimpleAccountTree(MIGRATION_LEGACY_ROOT, "same-credential");
		writeSimpleAccountTree(MIGRATION_PRIVATE_ROOT, "same-credential");

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(result.migrationStatus).toBe("duplicate-removed");
		expect(result.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
		expect(
			readFileSync(
				join(
					MIGRATION_PRIVATE_ROOT,
					"claude",
					"11111111-1111-4111-8111-111111111111",
					"credentials.json",
				),
				"utf8",
			),
		).toBe("same-credential");
	});

	it("moves a conflicting legacy tree to one local recovery location", async () => {
		writeSimpleAccountTree(MIGRATION_LEGACY_ROOT, "legacy-credential");
		writeSimpleAccountTree(MIGRATION_PRIVATE_ROOT, "private-credential");

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(result.migrationStatus).toBe("conflict-recovered");
		expect(result.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(result.warning).toContain("conflict");
		expect(result.recoveryRoot).toBeTruthy();
		expect(result.recoveryRoot?.startsWith(MIGRATION_ADE_HOME)).toBe(false);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
		expect(
			readFileSync(
				join(
					MIGRATION_PRIVATE_ROOT,
					"claude",
					"11111111-1111-4111-8111-111111111111",
					"credentials.json",
				),
				"utf8",
			),
		).toBe("private-credential");
		expect(
			readFileSync(
				join(
					result.recoveryRoot as string,
					"claude",
					"11111111-1111-4111-8111-111111111111",
					"credentials.json",
				),
				"utf8",
			),
		).toBe("legacy-credential");
	});

	it("keeps the legacy root active when terminal shutdown fails", async () => {
		createLegacyProfileFixture();
		let resetCalls = 0;

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {
				throw new Error("host did not stop");
			},
			resetTerminalService: () => {
				resetCalls += 1;
			},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_LEGACY_ROOT);
		expect(result.warning).toContain("retry");
		expect(resetCalls).toBe(0);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(true);
		expect(existsSync(MIGRATION_PRIVATE_ROOT)).toBe(false);
	});

	it("keeps existing legacy data active when private-root resolution fails", async () => {
		createLegacyProfileFixture();
		setSubscriptionProfileStorageRootForTests(null);

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			platform: "win32",
			env: {},
			homeDir: MIGRATION_TEST_ROOT,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_LEGACY_ROOT);
		expect(existsSync(join(MIGRATION_LEGACY_ROOT, "profiles.json"))).toBe(true);
	});

	it("never falls back into ADE home when new private storage is unsafe", async () => {
		const linkedTarget = join(MIGRATION_TEST_ROOT, "linked-private-target");
		mkdirSync(linkedTarget, { recursive: true });
		mkdirSync(join(MIGRATION_TEST_ROOT, "local-private"), { recursive: true });
		symlinkSync(
			linkedTarget,
			MIGRATION_PRIVATE_ROOT,
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = await initializeSubscriptionProfiles({
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {},
			resetTerminalService: () => {},
		});

		expect(result.migrationStatus).toBe("deferred");
		expect(result.root).toBe(MIGRATION_PRIVATE_ROOT);
		expect(result.warning).toContain("unavailable");
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
		expect(() => createSubscriptionProfile("codex", "Unsafe fallback")).toThrow(
			"linked account storage",
		);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
	});

	it("is idempotent on the second launch and leaves no credential tree in ADE home", async () => {
		createLegacyProfileFixture();
		let stopCalls = 0;
		let resetCalls = 0;
		const options = {
			adeHomeDir: MIGRATION_ADE_HOME,
			stopTerminalSessions: async () => {
				stopCalls += 1;
			},
			resetTerminalService: () => {
				resetCalls += 1;
			},
		};

		expect(
			(await initializeSubscriptionProfiles(options)).migrationStatus,
		).toBe("migrated");
		expect(
			(await initializeSubscriptionProfiles(options)).migrationStatus,
		).toBe("not-needed");
		expect(stopCalls).toBe(1);
		expect(resetCalls).toBe(1);
		expect(existsSync(MIGRATION_LEGACY_ROOT)).toBe(false);
		const remainingSyncableEntries = readdirSync(MIGRATION_ADE_HOME, {
			recursive: true,
		}).map(String);
		expect(
			remainingSyncableEntries.some((entry) =>
				/(?:provider-accounts|auth\.json|credentials\.json|profiles\.json)/.test(
					entry,
				),
			),
		).toBe(false);
	});
});

const RECONCILE_TEST_ROOT = join(
	realpathSync.native(tmpdir()),
	`ade-subscription-profile-reconcile-${process.pid}-${Date.now()}`,
);

describe("subscription profile binding reconciliation", () => {
	beforeEach(() => {
		rmSync(RECONCILE_TEST_ROOT, { recursive: true, force: true });
		setSubscriptionProfilesRootForTests(RECONCILE_TEST_ROOT);
	});

	afterEach(() => {
		setSubscriptionProfilesRootForTests(TEST_ROOT);
		rmSync(RECONCILE_TEST_ROOT, { recursive: true, force: true });
	});

	it("removes only pane IDs absent from trusted durable state and unlocks named profiles", () => {
		const staleProfile = createSubscriptionProfile("claude", "Stale account");
		const retainedProfile = createSubscriptionProfile(
			"claude",
			"Retained account",
		);
		bindSubscriptionProfileToPane(
			"claude",
			"stale-named-pane",
			staleProfile.id,
			"resolved-workspace",
		);
		bindSubscriptionProfileToPane(
			"claude",
			"retained-pane",
			retainedProfile.id,
			"resolved-workspace",
		);

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [
				{
					paneId: "retained-pane",
					provider: "claude",
					workspaceId: "resolved-workspace",
				},
			],
		});

		expect(result).toMatchObject({
			removedBindings: 1,
			preservedUnresolvedBindings: 0,
		});
		expect(
			getSubscriptionProfilePaneBinding(
				"claude",
				"retained-pane",
				"resolved-workspace",
			)?.profileId,
		).toBe(retainedProfile.id);
		expect(() =>
			removeSubscriptionProfile("claude", staleProfile.id),
		).not.toThrow();
	});

	it("removes a reused pane ID whose durable provider or workspace changed", () => {
		const wrongWorkspace = createSubscriptionProfile(
			"claude",
			"Wrong workspace",
		);
		const wrongProvider = createSubscriptionProfile("codex", "Wrong provider");
		bindSubscriptionProfileToPane(
			"claude",
			"workspace-reused-pane",
			wrongWorkspace.id,
			"old-workspace",
		);
		bindSubscriptionProfileToPane(
			"codex",
			"provider-reused-pane",
			wrongProvider.id,
			"current-workspace",
		);

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [
				{
					paneId: "workspace-reused-pane",
					provider: "claude",
					workspaceId: "current-workspace",
				},
				{
					paneId: "provider-reused-pane",
					provider: "claude",
					workspaceId: "current-workspace",
				},
			],
		});

		expect(result.removedBindings).toBe(2);
		expect(() =>
			removeSubscriptionProfile("claude", wrongWorkspace.id),
		).not.toThrow();
		expect(() =>
			removeSubscriptionProfile("codex", wrongProvider.id),
		).not.toThrow();
	});

	it("backfills a trusted workspace identity on a legacy binding", () => {
		const profile = createSubscriptionProfile("claude", "Legacy binding");
		bindSubscriptionProfileToPane(
			"claude",
			"legacy-pane",
			profile.id,
			"resolved-workspace",
		);
		const metadataPath = join(RECONCILE_TEST_ROOT, "profiles.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		delete metadata.bindings["legacy-pane"].workspaceId;
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [
				{
					paneId: "legacy-pane",
					provider: "claude",
					workspaceId: "resolved-workspace",
				},
			],
		});

		expect(result.backfilledWorkspaceIds).toBe(1);
		const persisted = JSON.parse(readFileSync(metadataPath, "utf8"));
		expect(persisted.bindings["legacy-pane"].workspaceId).toBe(
			"resolved-workspace",
		);
	});

	it("removes a proven-stale legacy binding with no workspace identity", () => {
		const profile = createSubscriptionProfile("claude", "Stale legacy binding");
		bindSubscriptionProfileToPane(
			"claude",
			"stale-legacy-pane",
			profile.id,
			"resolved-workspace",
		);
		const metadataPath = join(RECONCILE_TEST_ROOT, "profiles.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		delete metadata.bindings["stale-legacy-pane"].workspaceId;
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [],
			unresolvedWorkspaceIds: new Set(),
		});

		expect(result).toMatchObject({
			removedBindings: 1,
			preservedUnresolvedBindings: 0,
		});
		expect(() => removeSubscriptionProfile("claude", profile.id)).not.toThrow();
	});

	it("preserves a workspace-less legacy binding while any workspace is unresolved", () => {
		const profile = createSubscriptionProfile(
			"claude",
			"Unresolved legacy binding",
		);
		bindSubscriptionProfileToPane(
			"claude",
			"unresolved-legacy-pane",
			profile.id,
			"previous-workspace",
		);
		const metadataPath = join(RECONCILE_TEST_ROOT, "profiles.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		delete metadata.bindings["unresolved-legacy-pane"].workspaceId;
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [],
			unresolvedWorkspaceIds: new Set(["unresolved-workspace"]),
		});

		expect(result).toMatchObject({
			removedBindings: 0,
			preservedUnresolvedBindings: 1,
		});
		expect(() => removeSubscriptionProfile("claude", profile.id)).toThrow(
			"pinned to a saved terminal pane",
		);
	});

	it("prunes a profileless pane home with its stale binding", () => {
		getSubscriptionProfileEnvironmentForPane(
			"codex",
			"stale-system-pane",
			"resolved-workspace",
		);
		const home = legacyUnboundHome(
			RECONCILE_TEST_ROOT,
			"codex",
			"pane:stale-system-pane",
		);
		mkdirSync(home, { recursive: true, mode: 0o700 });

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [],
		});

		expect(result.removedBindings).toBe(1);
		expect(result.prunedHomes).toBe(1);
		expect(existsSync(home)).toBe(false);
	});

	it("preserves bindings whose workspace identity is unresolved", () => {
		getSubscriptionProfileEnvironmentForPane(
			"codex",
			"unresolved-pane",
			"unresolved-workspace",
		);

		const result = reconcileSubscriptionProfilePaneBindings({
			stateTrust: "trusted",
			durablePanes: [],
			unresolvedWorkspaceIds: new Set(["unresolved-workspace"]),
		});

		expect(result.removedBindings).toBe(0);
		expect(result.preservedUnresolvedBindings).toBe(1);
		expect(result.warnings).toHaveLength(1);
		expect(
			getSubscriptionProfilePaneBinding(
				"codex",
				"unresolved-pane",
				"unresolved-workspace",
			),
		).not.toBeNull();
	});

	it("skips destructive cleanup for recovered or otherwise untrusted state", () => {
		getSubscriptionProfileEnvironmentForPane(
			"claude",
			"recovered-pane",
			"resolved-workspace",
		);

		for (const stateTrust of ["recovered", "untrusted"] as const) {
			const result = reconcileSubscriptionProfilePaneBindings({
				stateTrust,
				durablePanes: [],
			});

			expect(result.removedBindings).toBe(0);
			expect(result.warnings).toHaveLength(1);
			expect(
				getSubscriptionProfilePaneBinding(
					"claude",
					"recovered-pane",
					"resolved-workspace",
				),
			).not.toBeNull();
		}
	});
});
