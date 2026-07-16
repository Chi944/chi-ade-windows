const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { basename, join, resolve } = require("node:path");
const { afterEach, describe, test } = require("node:test");
const {
	createPersonalUpdateManifest,
	writePersonalUpdateManifest,
} = require("./create-personal-update-manifest.cjs");
const {
	verifyPersonalUpdateManifest,
} = require("./verify-update-manifests.cjs");

const temporaryDirectories = [];
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const PUBLISHED_AT = "2026-07-16T01:02:03.000Z";
const STABLE_NAMES = [
	"ADE-Windows-x64.exe",
	"ADE-macOS-Apple-Silicon.dmg",
	"ADE-macOS-Intel.dmg",
];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "ade-manifest-test-"));
	temporaryDirectories.push(directory);
	const contents = ["windows-installer", "apple-silicon", "intel-mac"];
	const assetPaths = [];
	for (let index = 0; index < STABLE_NAMES.length; index += 1) {
		const path = join(directory, STABLE_NAMES[index]);
		await writeFile(path, contents[index]);
		assetPaths.push(path);
	}
	return { assetPaths, contents, directory };
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function options(assetPaths) {
	return {
		assetPaths,
		version: "0.6.0",
		buildNumber: 123_456,
		commitSha: COMMIT_SHA,
		publishedAt: PUBLISHED_AT,
	};
}

describe("createPersonalUpdateManifest", () => {
	test("maps the three stable assets deterministically with exact metadata", async () => {
		const { assetPaths, contents } = await fixture();
		const manifest = await createPersonalUpdateManifest(options(assetPaths));

		assert.deepEqual(manifest, {
			schemaVersion: 1,
			version: "0.6.0",
			buildNumber: 123_456,
			commitSha: COMMIT_SHA,
			publishedAt: PUBLISHED_AT,
			releaseNotesUrl:
				"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
			assets: {
				"win32-x64": {
					name: STABLE_NAMES[0],
					url: `https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/${STABLE_NAMES[0]}`,
					size: Buffer.byteLength(contents[0]),
					sha256: sha256(contents[0]),
				},
				"darwin-arm64": {
					name: STABLE_NAMES[1],
					url: `https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/${STABLE_NAMES[1]}`,
					size: Buffer.byteLength(contents[1]),
					sha256: sha256(contents[1]),
				},
				"darwin-x64": {
					name: STABLE_NAMES[2],
					url: `https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/${STABLE_NAMES[2]}`,
					size: Buffer.byteLength(contents[2]),
					sha256: sha256(contents[2]),
				},
			},
		});
		assert.deepEqual(Object.keys(manifest.assets), [
			"win32-x64",
			"darwin-arm64",
			"darwin-x64",
		]);
	});

	test("rejects a missing, duplicate, or unexpected stable asset", async () => {
		const { assetPaths } = await fixture();
		await assert.rejects(
			createPersonalUpdateManifest(options(assetPaths.slice(0, 2))),
			/exactly three/i,
		);
		await assert.rejects(
			createPersonalUpdateManifest(
				options([assetPaths[0], assetPaths[0], assetPaths[2]]),
			),
			/duplicate/i,
		);
		const unexpected = join(
			resolve(assetPaths[0], ".."),
			"renamed-installer.exe",
		);
		await writeFile(unexpected, "unexpected");
		await assert.rejects(
			createPersonalUpdateManifest(
				options([unexpected, assetPaths[1], assetPaths[2]]),
			),
			/unexpected/i,
		);
	});

	test("rejects invalid exact SHA, version, build number, or publication date", async () => {
		const { assetPaths } = await fixture();
		await assert.rejects(
			createPersonalUpdateManifest({
				...options(assetPaths),
				commitSha: "A".repeat(40),
			}),
			/commit SHA/i,
		);
		await assert.rejects(
			createPersonalUpdateManifest({
				...options(assetPaths),
				version: "latest",
			}),
			/semantic version/i,
		);
		await assert.rejects(
			createPersonalUpdateManifest({
				...options(assetPaths),
				buildNumber: 0,
			}),
			/build number/i,
		);
		await assert.rejects(
			createPersonalUpdateManifest({
				...options(assetPaths),
				publishedAt: "yesterday",
			}),
			/publishedAt/i,
		);
	});
});

describe("verifyPersonalUpdateManifest", () => {
	test("accepts the generated file and rejects any changed release asset", async () => {
		const { assetPaths, directory } = await fixture();
		const manifest = await createPersonalUpdateManifest(options(assetPaths));
		const manifestPath = join(directory, "ade-personal-update-v1.json");
		await writePersonalUpdateManifest(manifest, manifestPath);
		await verifyPersonalUpdateManifest(manifestPath);

		for (const assetPath of assetPaths) {
			const original = await readFile(assetPath);
			await writeFile(
				assetPath,
				Buffer.concat([original, Buffer.from("changed")]),
			);
			await assert.rejects(
				verifyPersonalUpdateManifest(manifestPath),
				/(size|SHA-256) mismatch/i,
				basename(assetPath),
			);
			await writeFile(assetPath, original);
		}
	});

	test("rejects altered manifest metadata and excess fields", async () => {
		const { assetPaths, directory } = await fixture();
		const manifest = await createPersonalUpdateManifest(options(assetPaths));
		const manifestPath = join(directory, "ade-personal-update-v1.json");
		manifest.assets["win32-x64"].url =
			"https://example.com/ADE-Windows-x64.exe";
		manifest.extra = true;
		await writeFile(manifestPath, JSON.stringify(manifest));

		await assert.rejects(
			verifyPersonalUpdateManifest(manifestPath),
			/(URL|field|manifest)/i,
		);
	});
});

describe("publication integration", () => {
	test("supports the legacy four-file rollout and swaps the manifest last", async () => {
		const script = (
			await readFile(resolve(__dirname, "publish-direct-downloads.sh"), "utf8")
		).replace(/\r\n?/g, "\n");
		assert.match(script, /LEGACY_STABLE_FILES=/);
		const stableBlock = script.match(/STABLE_FILES=\(([\s\S]*?)\)/)?.[1] ?? "";
		assert.ok(stableBlock.includes('"ade-personal-update-v1.json"'));
		assert.ok(
			stableBlock.lastIndexOf('"ade-personal-update-v1.json"') >
				stableBlock.lastIndexOf('"SHA256SUMS.txt"'),
			"manifest must be the last stable asset swapped",
		);
		assert.match(script, /optional old manifest/i);
	});

	test("keeps transient old and next asset cleanup recoverable", async () => {
		const script = (
			await readFile(resolve(__dirname, "publish-direct-downloads.sh"), "utf8")
		).replace(/\r\n?/g, "\n");
		assert.match(script, /delete_asset_with_retry\(\)/);
		assert.match(script, /is_managed_old_name\(\)/);
		assert.match(script, /is_managed_next_name\(\)/);
		assert.match(script, /cleanup_reconcilable_release_assets\(\)/);
		assert.match(script, /current_complete=true/);
		assert.match(script, /legacy_complete=true/);
		assert.match(
			script,
			/if test "\$current_complete" = "true"; then[\s\S]*is_managed_old_name[\s\S]*is_managed_next_name/,
		);
		assert.match(
			script,
			/elif test "\$legacy_complete" = "true"[\s\S]*is_managed_next_name/,
		);
		const rollbackCleanup =
			script.match(
				/delete_next_assets\(\) \{([\s\S]*?)\n\}\n\nupdate_existing_release/,
			)?.[1] ?? "";
		assert.match(rollbackCleanup, /delete_asset_with_retry/);
		assert.doesNotMatch(rollbackCleanup, /--method DELETE/);
		assert.match(script, /swap_committed=true/);
		assert.match(
			script,
			/swap_committed=true[\s\S]*delete_asset_with_retry[\s\S]*verify_exact_inventory[\s\S]*trap - EXIT/,
		);
		assert.match(
			script,
			/if test "\$swap_committed" != "true"; then[\s\S]*rollback_assets/,
		);
	});

	test("embeds exact build identity, verifies exact-SHA CI, and retains packaged smoke", async () => {
		const workflow = await readFile(
			resolve(__dirname, "../workflows/personal-distribution-build.yml"),
			"utf8",
		);
		assert.match(workflow, /actions:\s*read/);
		assert.match(workflow, /Require successful CI for exact SHA/);
		assert.match(workflow, /GITHUB_SHA/);
		assert.match(workflow, /conclusion[^\n]*success/);
		assert.match(workflow, /ADE_BUILD_SHA:\s*\$\{\{ github\.sha \}\}/);
		assert.match(
			workflow,
			/ADE_BUILD_NUMBER:\s*\$\{\{ github\.run_number \}\}/,
		);
		assert.match(workflow, /create-personal-update-manifest\.cjs/);
		assert.match(workflow, /verify-update-manifests\.cjs/);
		assert.match(
			workflow,
			/node --test \.github\/scripts\/create-personal-update-manifest\.test\.cjs/,
		);
		assert.match(
			workflow,
			/Smoke packaged Windows GUI[\s\S]*smoke:packaged-gui -- --platform win32/,
		);
		assert.match(
			workflow,
			/Smoke packaged macOS GUI[\s\S]*smoke:packaged-gui -- --platform darwin/,
		);

		const viteConfig = await readFile(
			resolve(__dirname, "../../apps/desktop/electron.vite.config.ts"),
			"utf8",
		);
		assert.match(viteConfig, /process\.env\.ADE_BUILD_SHA/);
		assert.match(viteConfig, /process\.env\.ADE_BUILD_NUMBER/);
	});

	test("ships desktop 0.6.0 with accurate verified personal-update guidance", async () => {
		const desktopPackage = JSON.parse(
			await readFile(
				resolve(__dirname, "../../apps/desktop/package.json"),
				"utf8",
			),
		);
		assert.equal(desktopPackage.version, "0.6.0");

		const lockfile = await readFile(
			resolve(__dirname, "../../bun.lock"),
			"utf8",
		);
		assert.match(lockfile, /"apps\/desktop": \{[\s\S]*?"version": "0\.6\.0"/);

		const installGuide = await readFile(
			resolve(__dirname, "../../docs/personal-install.md"),
			"utf8",
		);
		assert.match(installGuide, /one-time manual.*0\.6\.0/is);
		assert.match(installGuide, /ade-personal-update-v1\.json/);
		assert.match(installGuide, /size and SHA-256/i);
		assert.match(installGuide, /Download[\s\S]*Open Installer/i);
		assert.match(installGuide, /recovery snapshot/i);

		const readme = await readFile(
			resolve(__dirname, "../../README.md"),
			"utf8",
		);
		assert.match(readme, /verified personal update manifest/i);
		assert.doesNotMatch(readme, /choose \*\*Install & Restart\*\*/);

		const requiredPage = await readFile(
			resolve(
				__dirname,
				"../../apps/desktop/src/renderer/components/UpdateRequiredPage/UpdateRequiredPage.tsx",
			),
			"utf8",
		);
		assert.match(requiredPage, /Open Installer/);
		assert.doesNotMatch(requiredPage, /Install & Restart/);
		assert.match(requiredPage, /AUTO_UPDATE_READY_ACTION\.OPEN_INSTALLER/);
		assert.match(requiredPage, /Restart to Install/);

		const updateToast = await readFile(
			resolve(
				__dirname,
				"../../apps/desktop/src/renderer/components/UpdateToast/UpdateToast.tsx",
			),
			"utf8",
		);
		assert.match(updateToast, /AUTO_UPDATE_READY_ACTION\.OPEN_INSTALLER/);
		assert.match(updateToast, /Open Installer/);
		assert.match(updateToast, /Restart to Install/);
	});
});
