/**
 * Prepare better-sqlite3 for Electron's ABI without mutating the development
 * install. Release builds use published prebuilds so contributors do not need
 * a platform compiler toolchain just to package ADE.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const projectRoot = join(import.meta.dirname, "..");
const sourceModule = join(projectRoot, "node_modules", "better-sqlite3");
const cacheRoot = join(
	projectRoot,
	".cache",
	"electron-native",
	"node_modules",
);
const destinationModule = join(cacheRoot, "better-sqlite3");

function fail(message: string): never {
	console.error(`[prepare:electron-native] ${message}`);
	process.exit(1);
}

if (!existsSync(sourceModule)) {
	fail(`better-sqlite3 is missing: ${sourceModule}`);
}

const resolvedDestination = resolve(destinationModule);
const resolvedCacheRoot = `${resolve(cacheRoot)}${sep}`;
if (!resolvedDestination.startsWith(resolvedCacheRoot)) {
	fail("Refusing to prepare a native module outside the build cache");
}

rmSync(destinationModule, { recursive: true, force: true });
mkdirSync(dirname(destinationModule), { recursive: true });
cpSync(sourceModule, destinationModule, { recursive: true });

type DesktopPackage = { devDependencies?: { electron?: string } };
const desktopPackage = JSON.parse(
	readFileSync(join(projectRoot, "package.json"), "utf8"),
) as DesktopPackage;
const electronVersion = desktopPackage.devDependencies?.electron?.replace(
	/^[^0-9]*/,
	"",
);
if (!electronVersion) {
	fail("Could not resolve the Electron version from package.json");
}

const prebuildInstaller = join(
	projectRoot,
	"node_modules",
	"prebuild-install",
	"bin.js",
);
if (!existsSync(prebuildInstaller)) {
	fail(`prebuild-install is missing: ${prebuildInstaller}`);
}

console.log(
	`[prepare:electron-native] Fetching better-sqlite3 for Electron ${electronVersion} (${process.platform}/${process.arch})`,
);
const result = spawnSync(
	"node",
	[
		prebuildInstaller,
		"--runtime=electron",
		`--target=${electronVersion}`,
		`--platform=${process.platform}`,
		`--arch=${process.arch}`,
		"--force",
	],
	{
		cwd: destinationModule,
		stdio: "inherit",
		windowsHide: true,
	},
);

if (result.error) {
	fail(result.error.message);
}
if (result.status !== 0) {
	fail(`prebuild-install exited with status ${result.status ?? "unknown"}`);
}

console.log(
	`[prepare:electron-native] Ready: ${join(destinationModule, "build", "Release", "better_sqlite3.node")}`,
);
