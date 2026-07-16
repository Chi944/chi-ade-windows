import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	validateMainBundleLayout,
	validatePatchedJsYamlRuntime,
} from "./validate-native-runtime";

const roots: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "ade-native-runtime-test-"));
	roots.push(root);
	return root;
}

function writeSourceMap(root: string, relativePath: string, sources: string[]) {
	const path = join(root, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 3, sources }), "utf8");
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("packaged js-yaml source-map validation", () => {
	test("accepts the patched runtime when code splitting moves it into a chunk", () => {
		const root = fixture();
		writeSourceMap(root, "index.js.map", ["../../src/main/index.ts"]);
		writeSourceMap(root, "chunks/vendor.js.map", [
			"../../../../../node_modules/.bun/js-yaml@4.3.0/node_modules/js-yaml/index.js",
		]);

		expect(() => validatePatchedJsYamlRuntime(root)).not.toThrow();
	});

	test("rejects a vulnerable runtime found in any chunk", () => {
		const root = fixture();
		writeSourceMap(root, "index.js.map", [
			"../../node_modules/.bun/js-yaml@4.3.0/node_modules/js-yaml/index.js",
		]);
		writeSourceMap(root, "chunks/legacy.js.map", [
			"../../node_modules/.bun/js-yaml@4.1.1/node_modules/js-yaml/index.js",
		]);

		expect(() => validatePatchedJsYamlRuntime(root)).toThrow(
			"vulnerable js-yaml 4.1.1 runtime leaked into the main bundle",
		);
	});

	test("rejects missing patched runtime evidence", () => {
		const root = fixture();
		writeSourceMap(root, "index.js.map", ["../../src/main/index.ts"]);

		expect(() => validatePatchedJsYamlRuntime(root)).toThrow(
			"main bundle is not using the patched js-yaml 4.3.0 runtime",
		);
	});

	test("fails clearly for malformed or absent source maps", () => {
		const malformedRoot = fixture();
		writeFileSync(join(malformedRoot, "index.js.map"), "not-json", "utf8");
		expect(() => validatePatchedJsYamlRuntime(malformedRoot)).toThrow(
			"Invalid main source map",
		);

		const emptyRoot = fixture();
		expect(() => validatePatchedJsYamlRuntime(emptyRoot)).toThrow(
			"No main source maps were found",
		);
	});
});

describe("main bundle layout validation", () => {
	test("accepts executable bundles emitted directly beneath dist/main", () => {
		const root = fixture();
		writeFileSync(join(root, "index.js"), "export {};", "utf8");
		writeFileSync(join(root, "runtime-a1b2.js"), "export {};", "utf8");

		expect(() => validateMainBundleLayout(root)).not.toThrow();
	});

	test("rejects nested chunks that break __dirname-based runtime assets", () => {
		const root = fixture();
		mkdirSync(join(root, "chunks"), { recursive: true });
		writeFileSync(join(root, "chunks", "index-a1b2.js"), "export {};", "utf8");

		expect(() => validateMainBundleLayout(root)).toThrow(
			"Main JavaScript bundles must be emitted directly beneath",
		);
	});
});
