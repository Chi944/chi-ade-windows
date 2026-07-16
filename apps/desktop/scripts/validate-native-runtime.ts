/**
 * Ensure every bare import left by Electron Vite has a deliberate packaging
 * rule. This prevents a build from succeeding locally and then failing after
 * an unlisted dependency is omitted from the minimal production ASAR.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const projectRoot = join(import.meta.dirname, "..");
const allowedRuntimeImports = new Set([
	"better-sqlite3",
	"electron",
	"node-pty",
]);
const builtins = new Set(
	builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

function fail(message: string): never {
	throw new Error(`[validate:native-runtime] ${message}`);
}

function collectFiles(rootDir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
		const path = join(rootDir, entry.name);
		if (entry.isDirectory()) files.push(...collectFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

function collectBareImports(): Set<string> {
	const distDirs = [
		join(projectRoot, "dist", "main"),
		join(projectRoot, "dist", "preload"),
	];
	const imports = new Set<string>();
	const literalImport = /(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;

	for (const distDir of distDirs) {
		if (!existsSync(distDir)) {
			fail(`Build output is missing: ${distDir}. Run compile:app first.`);
		}
		for (const path of collectFiles(distDir).filter((file) =>
			file.endsWith(".js"),
		)) {
			const source = readFileSync(path, "utf8");
			for (const match of source.matchAll(literalImport)) {
				const specifier = match[1];
				if (
					specifier.startsWith(".") ||
					specifier.startsWith("/") ||
					specifier.startsWith("node:") ||
					builtins.has(specifier)
				) {
					continue;
				}
				imports.add(specifier);
			}
		}
	}
	return imports;
}

export function validatePatchedJsYamlRuntime(distMainRoot: string): void {
	const sourceMapPaths = collectFiles(distMainRoot)
		.filter((path) => path.endsWith(".js.map"))
		.sort();
	if (sourceMapPaths.length === 0) {
		fail(`No main source maps were found beneath ${distMainRoot}`);
	}

	const sources: string[] = [];
	for (const sourceMapPath of sourceMapPaths) {
		let sourceMap: unknown;
		try {
			sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
		} catch {
			fail(`Invalid main source map: ${sourceMapPath}`);
		}
		if (
			typeof sourceMap !== "object" ||
			sourceMap === null ||
			!("sources" in sourceMap) ||
			!Array.isArray(sourceMap.sources) ||
			sourceMap.sources.some((source) => typeof source !== "string")
		) {
			fail(`Invalid main source map: ${sourceMapPath}`);
		}
		sources.push(
			...(sourceMap.sources as string[]).map((source) =>
				source.replaceAll("\\", "/"),
			),
		);
	}

	if (sources.some((source) => source.includes("/.bun/js-yaml@4.1.1/"))) {
		fail("The vulnerable js-yaml 4.1.1 runtime leaked into the main bundle");
	}
	if (!sources.some((source) => source.includes("/.bun/js-yaml@4.3.0/"))) {
		fail("The main bundle is not using the patched js-yaml 4.3.0 runtime");
	}
}

export function validateMainBundleLayout(distMainRoot: string): void {
	const resolvedRoot = resolve(distMainRoot);
	const nestedBundles = collectFiles(resolvedRoot)
		.filter(
			(path) =>
				path.endsWith(".js") &&
				!path.endsWith(".template.js") &&
				dirname(resolve(path)) !== resolvedRoot,
		)
		.map((path) => relative(resolvedRoot, path).replaceAll("\\", "/"))
		.sort();
	if (nestedBundles.length > 0) {
		fail(
			`Main JavaScript bundles must be emitted directly beneath ${resolvedRoot}; nested bundles break runtime asset paths: ${nestedBundles.join(", ")}`,
		);
	}
}

function main(): void {
	const bareImports = collectBareImports();
	const unexpected = [...bareImports].filter(
		(specifier) => !allowedRuntimeImports.has(specifier),
	);
	if (unexpected.length > 0) {
		fail(
			`Unlisted bare imports in build output: ${unexpected.sort().join(", ")}`,
		);
	}

	for (const requiredImport of allowedRuntimeImports) {
		if (!bareImports.has(requiredImport)) {
			fail(
				`Expected runtime import is absent from build output: ${requiredImport}`,
			);
		}
	}

	const distMainRoot = join(projectRoot, "dist", "main");
	validateMainBundleLayout(distMainRoot);
	validatePatchedJsYamlRuntime(distMainRoot);

	const requiredPaths = [
		join(
			projectRoot,
			".cache",
			"electron-native",
			"node_modules",
			"better-sqlite3",
			"build",
			"Release",
			"better_sqlite3.node",
		),
		join(projectRoot, "node_modules", "bindings", "package.json"),
		join(projectRoot, "node_modules", "file-uri-to-path", "package.json"),
		join(projectRoot, "node_modules", "node-pty", "package.json"),
	];
	for (const path of requiredPaths) {
		if (!existsSync(path))
			fail(`Required packaged runtime file is missing: ${path}`);
	}

	console.log(
		`[validate:native-runtime] Runtime imports are explicit: ${[...bareImports].sort().join(", ")}`,
	);
}

if (import.meta.main) main();
