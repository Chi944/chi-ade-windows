/**
 * Electron Builder Configuration
 * @see https://www.electron.build/configuration/configuration
 */

import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AfterPackContext, Configuration } from "electron-builder";
import rcedit from "rcedit";
import pkg from "./package.json";

const currentYear = new Date().getFullYear();
const author = pkg.author?.name ?? pkg.author;
const productName = pkg.productName;

// Release repo — single source of truth for where artifacts + update manifests
// are published. Keep these values in sync with RELEASE_REPO_* in
// src/main/lib/auto-updater.ts.
const RELEASE_REPO_OWNER = "Chi944";
const RELEASE_REPO_NAME = "chi-ade-windows";

// Notarize only when Apple credentials are present in the environment
// (CI signing job, or a local signed build). electron-builder reads the
// APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars to run
// notarytool. Unsigned local smoke-test builds leave APPLE_TEAM_ID unset and
// skip notarization automatically.
const notarize = Boolean(process.env.APPLE_TEAM_ID);
const hasWindowsSigningConfig = Boolean(
	process.env.WIN_CSC_LINK ||
		process.env.CSC_LINK ||
		process.env.WIN_CSC_NAME ||
		process.env.CSC_NAME ||
		process.env.AZURE_TENANT_ID,
);
// Signed builds use electron-builder's normal edit-then-sign path. Unsigned
// native Windows builds use standalone rcedit in afterPack so standard Windows
// accounts do not need symlink rights for electron-builder's mixed-platform
// signing archive. Cross-host editing remains an explicit Wine-powered opt-in.
const shouldEditUnsignedWindowsExecutable =
	!hasWindowsSigningConfig &&
	(process.platform === "win32" ||
		process.env.ADE_WIN_EDIT_EXECUTABLE === "true");
const macIconPath = join(pkg.resources, "build/icons/icon.icns");
const linuxIconPath = join(pkg.resources, "build/icons");
const winIconPath = join(pkg.resources, "build/icons/icon.ico");

type MacNodePtyArch = "arm64" | "x64";

function assertMacNodePtyArch(arch: string): MacNodePtyArch {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported macOS node-pty architecture: ${arch}`);
}

function macNodePtyArchFromBuilder(
	arch: AfterPackContext["arch"],
): MacNodePtyArch {
	// electron-builder's Arch enum uses x64=1 and arm64=3.
	if (arch === 1) return "x64";
	if (arch === 3) return "arm64";
	throw new Error(`Unsupported macOS node-pty architecture value: ${arch}`);
}

export function getNodePtyFiles(
	platform: NodeJS.Platform,
	arch: string,
): string[] {
	return platform === "win32"
		? [
				"package.json",
				"LICENSE",
				"lib/**/*",
				"prebuilds/win32-x64/**/*",
				"!prebuilds/win32-x64/**/*.pdb",
			]
		: platform === "darwin"
			? [
					"package.json",
					"LICENSE",
					"lib/**/*",
					`prebuilds/darwin-${assertMacNodePtyArch(arch)}/**/*`,
				]
			: ["**/*"];
}

const nodePtyFiles = getNodePtyFiles(
	process.platform,
	process.env.ADE_TARGET_ARCH ?? process.arch,
);
const betterSqliteSource = ".cache/electron-native/node_modules/better-sqlite3";

async function editUnsignedWindowsExecutable(context: AfterPackContext) {
	if (
		context.electronPlatformName !== "win32" ||
		!shouldEditUnsignedWindowsExecutable
	) {
		return;
	}

	const appInfo = context.packager.appInfo;
	const iconPath = await context.packager.getIconPath();
	const versionStrings = {
		FileDescription: appInfo.productName,
		ProductName: appInfo.productName,
		LegalCopyright: appInfo.copyright,
		InternalName: appInfo.productFilename,
		OriginalFilename: "",
		...(appInfo.companyName ? { CompanyName: appInfo.companyName } : {}),
	};

	await rcedit(join(context.appOutDir, `${appInfo.productFilename}.exe`), {
		"version-string": versionStrings,
		"file-version": appInfo.shortVersion || appInfo.buildVersion,
		"product-version":
			appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
		...(iconPath ? { icon: resolve(iconPath) } : {}),
	});
}

async function restoreMacNodePtyHelperMode(context: AfterPackContext) {
	if (context.electronPlatformName !== "darwin") return;

	const arch = macNodePtyArchFromBuilder(context.arch);

	const appInfo = context.packager.appInfo;
	const helperPath = join(
		context.appOutDir,
		`${appInfo.productFilename}.app`,
		"Contents",
		"Resources",
		"app.asar.unpacked",
		"node_modules",
		"node-pty",
		"prebuilds",
		`darwin-${arch}`,
		"spawn-helper",
	);

	// ASAR preserves executable metadata only for recognized binary extensions.
	// node-pty's extensionless helper otherwise becomes 0644 and posix_spawnp
	// fails in the packaged app. Restore it before electron-builder signs the app.
	await chmod(helperPath, 0o755);
}

async function preparePackagedApp(context: AfterPackContext) {
	await restoreMacNodePtyHelperMode(context);
	await editUnsignedWindowsExecutable(context);
}

const config: Configuration = {
	appId: "io.github.chi944.ade",
	productName,
	copyright: `Copyright © ${currentYear} — ${author}`,
	electronVersion: pkg.devDependencies.electron.replace(/^\^/, ""),
	// ADE's UI is English-only; omit Chromium's other 54 locale packs.
	electronLanguages: ["en-US"],

	// Generate update manifests for all channels (latest.yml, canary.yml, etc.)
	// This enables proper channel-based auto-updates following electron-builder conventions
	generateUpdatesFilesForAllChannels: true,
	afterPack: preparePackagedApp,

	// Publish target for update manifests (latest-mac.yml, etc.). The release
	// workflow uploads artifacts itself (--publish never), but this makes the
	// generated manifests reference the correct public repo.
	publish: {
		provider: "github",
		owner: RELEASE_REPO_OWNER,
		repo: RELEASE_REPO_NAME,
	},

	// Directories
	directories: {
		output: "release",
		buildResources: join(pkg.resources, "build"),
	},

	// ASAR configuration for native modules and external resources
	asar: true,
	asarUnpack: [
		"**/node_modules/better-sqlite3/**/*",
		// better-sqlite3 uses `bindings` to locate native modules - must be unpacked together
		"**/node_modules/bindings/**/*",
		"**/node_modules/file-uri-to-path/**/*",
		"**/node_modules/node-pty/**/*",
		// ast-grep native bindings (package + platform binary package)
		"**/node_modules/@ast-grep/napi*/**/*",
		// libsql native bindings are loaded from @libsql/<platform>
		"**/node_modules/@libsql/**/*",
		// Sound files must be unpacked so external audio players (afplay, paplay, etc.) can access them
		"**/resources/sounds/**/*",
		// Tray icon must be unpacked so Electron Tray can load it
		"**/resources/tray/**/*",
	],

	// Extra resources placed outside asar archive (accessible via process.resourcesPath)
	extraResources: [
		// Chrome extensions must live outside app.asar for Electron to load them.
		{
			from: join(pkg.resources, "browser-extension"),
			to: "browser-extension",
			filter: ["**/*"],
		},
		// Database migrations - must be outside asar for drizzle-orm to read
		{
			from: "dist/resources/migrations",
			to: "resources/migrations",
			filter: ["**/*"],
		},
		{ from: "../../LICENSE.md", to: "LICENSE.md" },
		{ from: "../../NOTICE", to: "NOTICE" },
		{
			from: "../../THIRD-PARTY-NOTICES.md",
			to: "THIRD-PARTY-NOTICES.md",
		},
	],

	files: [
		"dist/**/*",
		"!dist/**/*.map",
		// Migrations are copied outside ASAR via extraResources below.
		"!dist/resources/migrations/**/*",
		"package.json",
		{
			from: pkg.resources,
			to: "resources",
			// Icons and entitlements are build inputs, not runtime resources.
			filter: ["**/*", "!build/**/*", "!browser-extension/**/*"],
		},
		// Native modules that can't be bundled by Vite.
		// bun creates symlinks for direct deps in workspace node_modules.
		// The copy:native-modules script replaces symlinks with real files
		// before building (required for Bun 1.3+ isolated installs).
		{
			from: betterSqliteSource,
			to: "node_modules/better-sqlite3",
			filter: ["**/*"],
		},
		// better-sqlite3 uses `bindings` package to locate its native .node file
		{
			from: "node_modules/bindings",
			to: "node_modules/bindings",
			filter: ["**/*"],
		},
		// `bindings` requires `file-uri-to-path` for file:// URL handling
		{
			from: "node_modules/file-uri-to-path",
			to: "node_modules/file-uri-to-path",
			filter: ["**/*"],
		},
		{
			from: "node_modules/node-pty",
			to: "node_modules/node-pty",
			// Packages need only node-pty's runtime JS and target prebuild. PDBs,
			// source trees, and binaries for other platforms add about 59 MiB.
			filter: nodePtyFiles,
		},
		// ast-grep native bindings (package + platform binary package)
		{
			from: "node_modules/@ast-grep",
			to: "node_modules/@ast-grep",
			filter: ["**/*"],
		},
		{
			from: "node_modules/libsql",
			to: "node_modules/libsql",
			filter: ["**/*"],
		},
		{
			from: "node_modules/@libsql",
			to: "node_modules/@libsql",
			filter: ["**/*"],
		},
		{
			from: "node_modules/@neon-rs",
			to: "node_modules/@neon-rs",
			filter: ["**/*"],
		},
		{
			from: "node_modules/detect-libc",
			to: "node_modules/detect-libc",
			filter: ["**/*"],
		},
		// friendly-words is a CommonJS module that Vite doesn't bundle
		{
			from: "node_modules/friendly-words",
			to: "node_modules/friendly-words",
			filter: ["**/*"],
		},
		"!**/.DS_Store",
	],

	// Native modules are prepared by scripts/copy-native-modules.ts and
	// validated before packaging. Rebuilding here forces node-gyp for node-pty
	// on Windows even though node-pty ships prebuilds for win32-x64/win32-arm64.
	npmRebuild: false,

	// macOS
	mac: {
		...(existsSync(macIconPath) ? { icon: macIconPath } : {}),
		category: "public.app-category.utilities",
		artifactName: `${productName}-${pkg.version}-\${arch}.\${ext}`,
		target: [
			{
				target: "default",
			},
		],
		// Hardened runtime is required for Apple notarization. The entitlements
		// below (allow-jit, allow-unsigned-executable-memory,
		// disable-library-validation) keep Electron + native modules working
		// under the hardened runtime.
		hardenedRuntime: true,
		gatekeeperAssess: false,
		notarize,
		entitlements: join(pkg.resources, "build/entitlements.mac.plist"),
		entitlementsInherit: join(
			pkg.resources,
			"build/entitlements.mac.inherit.plist",
		),
		extendInfo: {
			CFBundleName: productName,
			CFBundleDisplayName: productName,
			// Required for macOS microphone permission prompt
			NSMicrophoneUsageDescription:
				"ADE needs microphone access so voice-enabled tools like Codex transcription can capture audio input.",
			// Required for macOS local network permission prompt
			NSLocalNetworkUsageDescription:
				"ADE needs access to your local network to discover and connect to development servers running on your network.",
			// Bonjour service types to browse for (triggers the permission prompt)
			NSBonjourServices: ["_http._tcp", "_https._tcp"],
			// Required for Apple Events / Automation permission prompt
			NSAppleEventsUsageDescription:
				"ADE needs to interact with other applications to run terminal commands and development tools.",
		},
	},

	// Deep linking protocol
	protocols: {
		name: productName,
		schemes: ["ade"],
	},

	// Linux
	linux: {
		...(existsSync(linuxIconPath) ? { icon: linuxIconPath } : {}),
		category: "Utility",
		synopsis: pkg.description,
		target: ["AppImage"],
		artifactName: `ade-\${version}-\${arch}.\${ext}`,
	},

	// Windows
	win: {
		...(existsSync(winIconPath) ? { icon: winIconPath } : {}),
		signAndEditExecutable: hasWindowsSigningConfig,
		target: [
			{
				target: "nsis",
				arch: ["x64"],
			},
		],
		artifactName: `${productName}-${pkg.version}-\${arch}.\${ext}`,
	},

	// NSIS installer (Windows)
	nsis: {
		oneClick: false,
		allowToChangeInstallationDirectory: true,
		license: "../../LICENSE.md",
	},
};

export default config;
