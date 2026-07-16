import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openValidatedLocalDatabase } from "./filesystem-safety";

const temporaryDirectories: string[] = [];

function createTemporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ade-local-db-safety-"));
	temporaryDirectories.push(root);
	return root;
}

function createPathLink(target: string, path: string): void {
	if (process.platform === "win32") {
		mkdirSync(target, { recursive: true });
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(target, path, "junction");
		return;
	}
	writeFileSync(target, "outside");
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path, "file");
}

function createDirectoryLink(target: string, path: string): void {
	mkdirSync(target, { recursive: true });
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("openValidatedLocalDatabase", () => {
	test("creates a missing database parent one segment at a time before opening", () => {
		const root = createTemporaryRoot();
		const databasePath = join(root, "nested", "ade-home", "local.db");
		const open = mock((path: string) => {
			expect(lstatSync(dirname(path)).isDirectory()).toBe(true);
			writeFileSync(path, "sqlite");
			return { path };
		});

		const result = openValidatedLocalDatabase(databasePath, open);

		expect(result.existedBeforeOpen).toBe(false);
		expect(result.database).toEqual({ path: databasePath });
		expect(open).toHaveBeenCalledTimes(1);
		expect(existsSync(databasePath)).toBe(true);
	});

	test("reports an existing regular database before opening it", () => {
		const root = createTemporaryRoot();
		const databasePath = join(root, "ade-home", "local.db");
		mkdirSync(dirname(databasePath), { recursive: true });
		writeFileSync(databasePath, "sqlite");
		const open = mock((path: string) => path);

		const result = openValidatedLocalDatabase(databasePath, open);

		expect(result.existedBeforeOpen).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
	});

	test("rejects a linked database parent before calling the SQLite opener", () => {
		const root = createTemporaryRoot();
		const outside = join(root, "outside-home");
		const linkedHome = join(root, "linked-home");
		createDirectoryLink(outside, linkedHome);
		const open = mock((path: string) => path);

		expect(() =>
			openValidatedLocalDatabase(join(linkedHome, "local.db"), open),
		).toThrow(/symbolic link|junction/i);
		expect(open).not.toHaveBeenCalled();
		expect(existsSync(join(outside, "local.db"))).toBe(false);
	});

	test("rejects a linked ancestor before calling the SQLite opener", () => {
		const root = createTemporaryRoot();
		const canonicalBoundary = join(root, "canonical-boundary");
		const linkedBoundary = join(root, "linked-boundary");
		createDirectoryLink(canonicalBoundary, linkedBoundary);
		const databasePath = join(linkedBoundary, "ade-home", "local.db");
		const open = mock((path: string) => path);

		expect(() => openValidatedLocalDatabase(databasePath, open)).toThrow(
			/symbolic link|junction/i,
		);
		expect(open).not.toHaveBeenCalled();
		expect(existsSync(join(canonicalBoundary, "ade-home", "local.db"))).toBe(
			false,
		);
	});

	test("rejects a linked database target before calling the SQLite opener", () => {
		const root = createTemporaryRoot();
		const databasePath = join(root, "ade-home", "local.db");
		const outside = join(root, "outside-database");
		createPathLink(outside, databasePath);
		const open = mock((path: string) => path);

		expect(() => openValidatedLocalDatabase(databasePath, open)).toThrow(
			/symbolic link|junction/i,
		);
		expect(open).not.toHaveBeenCalled();
	});

	test("rejects a directory at the database target before opening", () => {
		const root = createTemporaryRoot();
		const databasePath = join(root, "ade-home", "local.db");
		mkdirSync(databasePath, { recursive: true });
		const open = mock((path: string) => path);

		expect(() => openValidatedLocalDatabase(databasePath, open)).toThrow(
			/regular file/i,
		);
		expect(open).not.toHaveBeenCalled();
	});

	test("rejects a linked SQLite sidecar before opening the database", () => {
		const root = createTemporaryRoot();
		const databasePath = join(root, "ade-home", "local.db");
		mkdirSync(dirname(databasePath), { recursive: true });
		writeFileSync(databasePath, "sqlite");
		createPathLink(join(root, "outside-wal"), `${databasePath}-wal`);
		const open = mock((path: string) => path);

		expect(() => openValidatedLocalDatabase(databasePath, open)).toThrow(
			/symbolic link|junction/i,
		);
		expect(open).not.toHaveBeenCalled();
	});
});
