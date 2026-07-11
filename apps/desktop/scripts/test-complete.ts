import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const skippedDirectories = new Set([
	".cache",
	".turbo",
	"dist",
	"dist-electron",
	"node_modules",
	"release",
]);

function findTestFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (skippedDirectories.has(entry.name)) return [];
			return findTestFiles(path);
		}
		return /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
	});
}

const testFiles = findTestFiles(desktopRoot).sort();

for (const [index, testFile] of testFiles.entries()) {
	const testPath = relative(desktopRoot, testFile);
	console.log(`[complete-test ${index + 1}/${testFiles.length}] ${testPath}`);
	const result = spawnSync(process.execPath, ["test", testPath], {
		cwd: desktopRoot,
		env: process.env,
		stdio: "inherit",
	});

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

console.log(`Complete desktop test suite passed (${testFiles.length} files).`);
