import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("default diagnostics export", () => {
	test("contains state-shape query failures instead of aborting the export", async () => {
		const source = await readFile(
			new URL("./runtime.ts", import.meta.url),
			"utf8",
		);
		const stateShape = source.slice(
			source.indexOf("function currentStateShape"),
			source.indexOf("function embeddedBuildNumber"),
		);

		expect(stateShape).toContain("readStateShapeBestEffort");
		expect(stateShape).not.toContain("throw error");
	});

	test("includes crash-dump inventory in storage health", async () => {
		const source = await readFile(
			new URL("./runtime.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("inspectCrashDumpStorage");
		expect(source).toContain("...crashStorage");
	});

	test("contains inaccessible recent-log storage without aborting the export", async () => {
		const source = await readFile(
			new URL("./runtime.ts", import.meta.url),
			"utf8",
		);
		const bundle = source.slice(
			source.indexOf("async function createDefaultBundle"),
			source.indexOf("export async function exportDefaultDiagnostics"),
		);

		expect(bundle).toMatch(
			/readRecentDiagnosticEntries\([\s\S]*?\)\.catch\(\(\) => \[\]\)/,
		);
	});
});
