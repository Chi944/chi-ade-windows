import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";

const supportedExtensions = new Set([
	".cjs",
	".css",
	".js",
	".json",
	".jsonc",
	".jsx",
	".mjs",
	".ts",
	".tsx",
]);

function changedFiles(): string[] {
	const diff = spawnSync(
		"git",
		["diff", "--name-only", "--diff-filter=ACMR", "HEAD^", "HEAD"],
		{ encoding: "utf8" },
	);
	const output =
		diff.status === 0
			? diff.stdout
			: spawnSync(
					"git",
					[
						"show",
						"--pretty=format:",
						"--name-only",
						"--diff-filter=ACMR",
						"HEAD",
					],
					{ encoding: "utf8" },
				).stdout;

	return output
		.split(/\r?\n/)
		.filter(Boolean)
		.filter((file) => supportedExtensions.has(extname(file)))
		.filter(existsSync);
}

const files = changedFiles();
if (files.length === 0) {
	console.log("No Biome-supported files changed in the latest commit");
	process.exit(0);
}

console.log(`Checking ${files.length} changed file(s) with Biome`);
const result = spawnSync(
	process.execPath,
	["x", "@biomejs/biome@2.4.2", "check", ...files],
	{ stdio: "inherit" },
);
process.exit(result.status ?? 1);
