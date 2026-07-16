import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
	initializeSubscriptionProfileStorageRoot,
	resolveSubscriptionProfileStorageRoot,
	setSubscriptionProfileStorageRootForTests,
} from "./subscription-profile-storage";

const TEST_ROOT = join(
	realpathSync.native(tmpdir()),
	`ade-private-profile-storage-${process.pid}-${Date.now()}`,
);
const nativePath = process.platform === "win32" ? win32 : posix;

function namespaceFor(adeHomeDir: string): string {
	return createHash("sha256").update(adeHomeDir).digest("hex").slice(0, 16);
}

afterEach(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("resolveSubscriptionProfileStorageRoot", () => {
	test("uses the exact Windows local application data root", () => {
		const adeHomeDir = "C:\\Users\\Ada\\.ade";

		expect(
			resolveSubscriptionProfileStorageRoot({
				adeHomeDir,
				platform: "win32",
				env: { LOCALAPPDATA: "D:\\LocalAppData" },
				homeDir: "C:\\Users\\Ada",
			}),
		).toBe(
			win32.join(
				"D:\\LocalAppData",
				"ADE",
				"private",
				namespaceFor(win32.resolve(adeHomeDir)),
				"provider-accounts",
			),
		);
	});

	test("uses the exact macOS application support root", () => {
		const adeHomeDir = "/Users/ada/.ade";

		expect(
			resolveSubscriptionProfileStorageRoot({
				adeHomeDir,
				platform: "darwin",
				env: {},
				homeDir: "/Users/ada",
			}),
		).toBe(
			posix.join(
				"/Users/ada/Library/Application Support",
				"ADE",
				"private",
				namespaceFor(posix.resolve(adeHomeDir)),
				"provider-accounts",
			),
		);
	});

	test("uses XDG_DATA_HOME and the exact Linux fallback", () => {
		const adeHomeDir = "/home/ada/.ade";
		const namespace = namespaceFor(posix.resolve(adeHomeDir));

		expect(
			resolveSubscriptionProfileStorageRoot({
				adeHomeDir,
				platform: "linux",
				env: { XDG_DATA_HOME: "/mnt/local-data" },
				homeDir: "/home/ada",
			}),
		).toBe(
			posix.join(
				"/mnt/local-data",
				"ADE",
				"private",
				namespace,
				"provider-accounts",
			),
		);
		expect(
			resolveSubscriptionProfileStorageRoot({
				adeHomeDir,
				platform: "linux",
				env: {},
				homeDir: "/home/ada",
			}),
		).toBe(
			posix.join(
				"/home/ada/.local/share",
				"ADE",
				"private",
				namespace,
				"provider-accounts",
			),
		);
	});

	test("uses a stable hashed namespace for the resolved ADE home", () => {
		const first = resolveSubscriptionProfileStorageRoot({
			adeHomeDir: "/home/ada/work/../.ade",
			platform: "linux",
			env: {},
			homeDir: "/home/ada",
		});
		const second = resolveSubscriptionProfileStorageRoot({
			adeHomeDir: "/home/ada/.ade",
			platform: "linux",
			env: {},
			homeDir: "/home/ada",
		});
		const other = resolveSubscriptionProfileStorageRoot({
			adeHomeDir: "/home/ada/.ade-work",
			platform: "linux",
			env: {},
			homeDir: "/home/ada",
		});

		expect(first).toBe(second);
		expect(first).not.toBe(other);
		expect(posix.basename(posix.dirname(first))).toMatch(/^[0-9a-f]{16}$/);
		expect(first).not.toContain("/home/ada/.ade/");
	});
});

describe("initializeSubscriptionProfileStorageRoot", () => {
	test("honors the internal test override and creates a restrictive root", () => {
		const override = join(TEST_ROOT, "private", "provider-accounts");
		setSubscriptionProfileStorageRootForTests(override);
		try {
			const root = initializeSubscriptionProfileStorageRoot({
				adeHomeDir: join(TEST_ROOT, "syncable"),
			});

			expect(root).toBe(override);
			expect(existsSync(root)).toBe(true);
			expect(lstatSync(root).isDirectory()).toBe(true);
			if (process.platform !== "win32") {
				expect(lstatSync(root).mode & 0o777).toBe(0o700);
			}
		} finally {
			setSubscriptionProfileStorageRootForTests(null);
		}
	});

	test("refuses a linked private root", () => {
		const target = join(TEST_ROOT, "target");
		const linkedRoot = join(TEST_ROOT, "linked-provider-accounts");
		setSubscriptionProfileStorageRootForTests(target);
		try {
			initializeSubscriptionProfileStorageRoot({
				adeHomeDir: join(TEST_ROOT, "syncable"),
			});
			symlinkSync(
				target,
				linkedRoot,
				process.platform === "win32" ? "junction" : "dir",
			);
			setSubscriptionProfileStorageRootForTests(linkedRoot);

			expect(() =>
				initializeSubscriptionProfileStorageRoot({
					adeHomeDir: join(TEST_ROOT, "syncable"),
				}),
			).toThrow("linked private provider storage root");
		} finally {
			setSubscriptionProfileStorageRootForTests(null);
		}
	});

	test("never initializes provider credentials below ADE_HOME_DIR", () => {
		const adeHomeDir = join(TEST_ROOT, "syncable");
		const root = initializeSubscriptionProfileStorageRoot({
			adeHomeDir,
			env: { LOCALAPPDATA: join(TEST_ROOT, "local-app-data") },
			homeDir: TEST_ROOT,
		});
		const relative = nativePath.relative(nativePath.resolve(adeHomeDir), root);

		expect(
			relative === "" ||
				(!relative.startsWith("..") && !nativePath.isAbsolute(relative)),
		).toBe(false);
	});

	test("rejects a parent link into ADE_HOME_DIR before creating the root", () => {
		const adeHomeDir = join(TEST_ROOT, "syncable");
		const localAppData = join(TEST_ROOT, "local-app-data");
		const redirectedPrivateParent = join(adeHomeDir, "redirected-private");
		const requestedRoot = resolveSubscriptionProfileStorageRoot({
			adeHomeDir,
			env: { LOCALAPPDATA: localAppData },
			homeDir: TEST_ROOT,
		});
		const namespace = nativePath.basename(nativePath.dirname(requestedRoot));
		const linkedPrivateParent = nativePath.dirname(
			nativePath.dirname(requestedRoot),
		);
		mkdirSync(nativePath.dirname(linkedPrivateParent), { recursive: true });
		mkdirSync(redirectedPrivateParent, { recursive: true });
		symlinkSync(
			redirectedPrivateParent,
			linkedPrivateParent,
			process.platform === "win32" ? "junction" : "dir",
		);
		const redirectedRoot = join(
			redirectedPrivateParent,
			namespace,
			"provider-accounts",
		);

		expect(() =>
			initializeSubscriptionProfileStorageRoot({
				adeHomeDir,
				env: { LOCALAPPDATA: localAppData },
				homeDir: TEST_ROOT,
			}),
		).toThrow("outside ADE home");
		expect(existsSync(redirectedRoot)).toBe(false);
	});

	test("rejects a parent link outside the canonical OS-local data base", () => {
		const adeHomeDir = join(TEST_ROOT, "syncable");
		const localAppData = join(TEST_ROOT, "local-app-data");
		const redirectedPrivateParent = join(TEST_ROOT, "redirected-private");
		const requestedRoot = resolveSubscriptionProfileStorageRoot({
			adeHomeDir,
			env: { LOCALAPPDATA: localAppData },
			homeDir: TEST_ROOT,
		});
		const namespace = nativePath.basename(nativePath.dirname(requestedRoot));
		const linkedPrivateParent = nativePath.dirname(
			nativePath.dirname(requestedRoot),
		);
		mkdirSync(nativePath.dirname(linkedPrivateParent), { recursive: true });
		mkdirSync(redirectedPrivateParent, { recursive: true });
		symlinkSync(
			redirectedPrivateParent,
			linkedPrivateParent,
			process.platform === "win32" ? "junction" : "dir",
		);
		const redirectedRoot = join(
			redirectedPrivateParent,
			namespace,
			"provider-accounts",
		);

		expect(() =>
			initializeSubscriptionProfileStorageRoot({
				adeHomeDir,
				env: { LOCALAPPDATA: localAppData },
				homeDir: TEST_ROOT,
			}),
		).toThrow("OS-local data base");
		expect(existsSync(redirectedRoot)).toBe(false);
	});
});
