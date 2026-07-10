"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const moduleRoot = process.env.ADE_SMOKE_MODULE_ROOT;
const electronNativeRoot = process.env.ADE_ELECTRON_NATIVE_ROOT;

function loadModule(name) {
	if (moduleRoot) return require(path.join(moduleRoot, name));
	if (name === "better-sqlite3" && electronNativeRoot) {
		const preparedModule = path.resolve(electronNativeRoot, name);
		return require(preparedModule);
	}
	return require(name);
}

function smokeBetterSqlite() {
	const Database = loadModule("better-sqlite3");
	const db = new Database(":memory:");
	try {
		assert.equal(db.prepare("select 1 as value").get().value, 1);
	} finally {
		db.close();
	}
}

function smokeLibsql() {
	const Database = loadModule("libsql");
	const db = new Database(":memory:");
	try {
		assert.equal(db.prepare("select 1 as value").get().value, 1);
	} finally {
		db.close();
	}
}

function smokeAstGrep() {
	const { parse } = loadModule("@ast-grep/napi");
	const tree = parse("typescript", "const value = 1;");
	assert.equal(typeof tree.root, "function");
	assert.equal(tree.root().kind(), "program");
}

async function smokePty(options = {}) {
	const pty = loadModule("node-pty");
	const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
	const args =
		process.platform === "win32"
			? ["-NoLogo", "-NoProfile", "-Command", "exit 0"]
			: ["-c", "exit 0"];

	await new Promise((resolve, reject) => {
		const child = pty.spawn(shell, args, {
			cols: 80,
			rows: 24,
			cwd: process.cwd(),
			env: process.env,
			...options,
		});
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error("node-pty smoke test timed out"));
		}, 10_000);
		child.onExit(({ exitCode }) => {
			clearTimeout(timeout);
			if (exitCode === 0) resolve();
			else reject(new Error(`node-pty exited with code ${exitCode}`));
		});
	});
}

async function main() {
	smokeBetterSqlite();
	smokeLibsql();
	smokeAstGrep();
	await smokePty();
	if (process.platform === "win32") {
		// Keep the winpty fallback healthy for systems where ConPTY is unavailable.
		await smokePty({ useConpty: false });
	}
	console.log("Native Electron runtime smoke test passed");
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
