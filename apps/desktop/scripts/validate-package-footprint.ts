import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const MIB = 1024 * 1024;
const REQUIRED_SOUND_FILES = [
	"agentisdonewoman.mp3",
	"arcade.mp3",
	"codecompleteafrican.mp3",
	"codecompleteafrobeat.mp3",
	"codecompleteedm.mp3",
	"comebacktothecode.mp3",
	"ping.mp3",
	"shabalabadingdong.mp3",
	"shamisen.mp3",
	"supersetdoowap.mp3",
	"supersetquick.mp3",
] as const;

const LIMITS = {
	win32: {
		appAsarMiB: 72,
		appUnpackedMiB: 48,
		resourcesMiB: 128,
		bundleMiB: 450,
		artifactMiB: 135,
	},
	darwin: {
		appAsarMiB: 72,
		appUnpackedMiB: 48,
		resourcesMiB: 128,
		bundleMiB: 500,
		artifactMiB: 175,
	},
} as const;

type SupportedPlatform = keyof typeof LIMITS;
type SupportedArch = "arm64" | "x64";

export interface PackageFootprintOptions {
	releaseDir: string;
	platform: SupportedPlatform;
	arch: SupportedArch;
	requireArtifacts?: boolean;
}

function fail(message: string): never {
	throw new Error(`[validate:package-footprint] ${message}`);
}

function assertExists(path: string, description: string): void {
	if (!existsSync(path)) fail(`${description} is missing: ${path}`);
}

export function directorySize(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += directorySize(child);
		else if (entry.isFile()) total += statSync(child).size;
	}
	return total;
}

function findDirectories(root: string, suffix: string): string[] {
	const matches: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const child = join(root, entry.name);
		if (!entry.isDirectory()) continue;
		if (entry.name.endsWith(suffix)) matches.push(child);
		else matches.push(...findDirectories(child, suffix));
	}
	return matches;
}

function listRuntimePackages(nodeModulesDir: string): string[] {
	const packages: string[] = [];
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith("@")) {
			packages.push(entry.name);
			continue;
		}

		const scopeDir = join(nodeModulesDir, entry.name);
		for (const child of readdirSync(scopeDir, { withFileTypes: true })) {
			if (child.isDirectory()) packages.push(`${entry.name}/${child.name}`);
		}
	}
	return packages.sort();
}

function expectedNativePackages(
	platform: SupportedPlatform,
	arch: SupportedArch,
): { nodePtyTarget: string } {
	if (platform === "win32") {
		if (arch !== "x64") fail(`Windows ${arch} packaging is not supported`);
		return { nodePtyTarget: "win32-x64" };
	}

	return { nodePtyTarget: `darwin-${arch}` };
}

function assertAtMost(path: string, bytes: number, maxMiB: number): void {
	if (bytes > maxMiB * MIB) {
		fail(
			`${basename(path)} is ${(bytes / MIB).toFixed(1)} MiB; limit is ${maxMiB} MiB`,
		);
	}
}

function assertResourceAllowlist(
	resourcesDir: string,
	platform: SupportedPlatform,
): void {
	const common = new Set([
		"app-update.yml",
		"app.asar",
		"app.asar.unpacked",
		"browser-extension",
		"LICENSE.md",
		"NOTICE",
		"resources",
		"THIRD-PARTY-NOTICES.md",
	]);
	const unexpected = readdirSync(resourcesDir).filter((name) => {
		if (common.has(name)) return false;
		if (platform === "win32") return name !== "elevate.exe";
		return !name.endsWith(".icns") && !name.endsWith(".lproj");
	});
	if (unexpected.length > 0) {
		fail(`Unexpected app resource entries: ${unexpected.sort().join(", ")}`);
	}
}

export function validatePackageFootprint({
	releaseDir,
	platform,
	arch,
	requireArtifacts = true,
}: PackageFootprintOptions): void {
	const limits = LIMITS[platform];
	const appBundle =
		platform === "win32"
			? join(releaseDir, "win-unpacked")
			: findDirectories(releaseDir, ".app")[0];
	if (!appBundle) fail(`No packaged app found under ${releaseDir}`);
	assertExists(appBundle, "Packaged app");

	const resourcesDir =
		platform === "win32"
			? join(appBundle, "resources")
			: join(appBundle, "Contents", "Resources");
	const appAsar = join(resourcesDir, "app.asar");
	const appUnpacked = join(resourcesDir, "app.asar.unpacked");
	const unpackedModules = join(appUnpacked, "node_modules");
	assertExists(appAsar, "app.asar");
	assertExists(unpackedModules, "Unpacked runtime node_modules");

	const appAsarBytes = statSync(appAsar).size;
	const appUnpackedBytes = directorySize(appUnpacked);
	const resourcesBytes = directorySize(resourcesDir);
	const bundleBytes = directorySize(appBundle);
	assertResourceAllowlist(resourcesDir, platform);
	assertAtMost(appAsar, appAsarBytes, limits.appAsarMiB);
	assertAtMost(appUnpacked, appUnpackedBytes, limits.appUnpackedMiB);
	assertAtMost(resourcesDir, resourcesBytes, limits.resourcesMiB);
	assertAtMost(appBundle, bundleBytes, limits.bundleMiB);
	const unpackedEntries = readdirSync(appUnpacked).sort();
	const expectedUnpackedEntries = ["dist", "node_modules", "resources"];
	if (unpackedEntries.join("\0") !== expectedUnpackedEntries.join("\0")) {
		fail(`Unexpected app.asar.unpacked entries: ${unpackedEntries.join(", ")}`);
	}

	const runtimeSounds = join(appUnpacked, "resources", "sounds");
	assertExists(runtimeSounds, "Unpacked runtime sounds");
	for (const file of REQUIRED_SOUND_FILES) {
		assertExists(join(runtimeSounds, file), "Runtime sound file");
	}
	const duplicateCompiledSounds = join(
		appUnpacked,
		"dist",
		"resources",
		"sounds",
	);
	if (existsSync(duplicateCompiledSounds)) {
		fail(
			`Duplicate compiled sound resources must not be packaged: ${duplicateCompiledSounds}`,
		);
	}

	const native = expectedNativePackages(platform, arch);
	const expected = new Set([
		"better-sqlite3",
		"bindings",
		"file-uri-to-path",
		"node-pty",
	]);
	const actual = listRuntimePackages(unpackedModules);
	const missing = [...expected].filter((name) => !actual.includes(name));
	const unexpected = actual.filter((name) => !expected.has(name));
	if (missing.length > 0)
		fail(`Missing runtime packages: ${missing.join(", ")}`);
	if (unexpected.length > 0) {
		fail(`Unexpected unpacked runtime packages: ${unexpected.join(", ")}`);
	}

	const requiredFiles = [
		join(
			unpackedModules,
			"better-sqlite3",
			"build",
			"Release",
			"better_sqlite3.node",
		),
		join(unpackedModules, "node-pty", "prebuilds", native.nodePtyTarget),
	];
	for (const path of requiredFiles) assertExists(path, "Native runtime file");

	const artifactExtensions = platform === "win32" ? [".exe"] : [".dmg", ".zip"];
	const artifacts = readdirSync(releaseDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				artifactExtensions.some((extension) =>
					entry.name.endsWith(extension),
				) &&
				!entry.name.includes(".__uninstaller"),
		)
		.map((entry) => join(releaseDir, entry.name));
	if (requireArtifacts && artifacts.length === 0)
		fail(`No installer artifacts found in ${releaseDir}`);
	for (const artifact of artifacts) {
		assertAtMost(artifact, statSync(artifact).size, limits.artifactMiB);
	}

	console.log(
		[
			"[validate:package-footprint] Package is within its storage budget",
			`  app.asar: ${(appAsarBytes / MIB).toFixed(1)} MiB / ${limits.appAsarMiB} MiB`,
			`  app.asar.unpacked: ${(appUnpackedBytes / MIB).toFixed(1)} MiB / ${limits.appUnpackedMiB} MiB`,
			`  resources: ${(resourcesBytes / MIB).toFixed(1)} MiB / ${limits.resourcesMiB} MiB`,
			`  app bundle: ${(bundleBytes / MIB).toFixed(1)} MiB / ${limits.bundleMiB} MiB`,
			`  installers: ${
				artifacts.length > 0
					? artifacts
							.map(
								(path) =>
									`${basename(path)} ${(statSync(path).size / MIB).toFixed(1)} MiB`,
							)
							.join(", ")
					: "directory-only build"
			}`,
		].join("\n"),
	);
}

if (import.meta.main) {
	const releaseDir = resolve(import.meta.dirname, "..", "release");
	const platform = process.platform;
	if (platform !== "win32" && platform !== "darwin") {
		fail(`Unsupported validation platform: ${platform}`);
	}
	const targetArch = process.env.ADE_TARGET_ARCH ?? process.arch;
	if (targetArch !== "x64" && targetArch !== "arm64") {
		fail(`Unsupported validation architecture: ${targetArch}`);
	}
	validatePackageFootprint({
		releaseDir,
		platform,
		arch: targetArch,
		requireArtifacts: process.env.ADE_PACKAGE_DIR_ONLY !== "true",
	});
}
