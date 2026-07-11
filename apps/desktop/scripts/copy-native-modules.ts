/**
 * Materialize Electron runtime modules for electron-builder.
 *
 * Bun's isolated workspace install can expose direct dependencies as symlinks.
 * electron-builder does not reliably follow those links while creating ASAR
 * archives, so the small external runtime allowlist is copied into place first.
 */

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

const REQUIRED_MODULES = ["better-sqlite3", "node-pty"] as const;
const RUNTIME_DEPENDENCIES = ["bindings", "file-uri-to-path"] as const;

function workspaceNodeModules(nodeModulesDir: string): string {
	return join(nodeModulesDir, "..", "..", "..", "node_modules");
}

function bunFlatNodeModules(nodeModulesDir: string): string {
	return join(workspaceNodeModules(nodeModulesDir), ".bun", "node_modules");
}

function materializeModule(
	nodeModulesDir: string,
	moduleName: string,
	required: boolean,
): boolean {
	const modulePath = join(nodeModulesDir, moduleName);
	const bunStorePath = join(bunFlatNodeModules(nodeModulesDir), moduleName);

	if (!existsSync(modulePath)) {
		if (existsSync(bunStorePath)) {
			console.log(`  ${moduleName}: materializing from Bun store index`);
			mkdirSync(dirname(modulePath), { recursive: true });
			cpSync(realpathSync(bunStorePath), modulePath, { recursive: true });
			return true;
		}
		if (required) {
			throw new Error(`${moduleName} not found at ${modulePath}`);
		}
		console.log(`  ${moduleName}: not found (skipping)`);
		return false;
	}

	if (lstatSync(modulePath).isSymbolicLink()) {
		const sourcePath = realpathSync(modulePath);
		console.log(`  ${moduleName}: replacing symlink with runtime files`);
		unlinkSync(modulePath);
		cpSync(sourcePath, modulePath, { recursive: true });
	} else {
		console.log(`  ${moduleName}: already materialized`);
	}
	return true;
}

function main(): void {
	console.log("Preparing packaged Electron runtime modules...");
	const nodeModulesDir = join(dirname(import.meta.dirname), "node_modules");

	for (const moduleName of REQUIRED_MODULES) {
		materializeModule(nodeModulesDir, moduleName, true);
	}
	for (const moduleName of RUNTIME_DEPENDENCIES) {
		materializeModule(nodeModulesDir, moduleName, true);
	}

	console.log("Packaged runtime modules are materialized");
}

main();
