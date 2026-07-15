import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSensitiveSyncIgnoreReady,
	ensureSensitiveSyncIgnore,
	SENSITIVE_SYNC_IGNORE_BEGIN,
	SENSITIVE_SYNC_IGNORE_END,
} from "./sensitive-ignore";

const TEST_ROOT = join(
	tmpdir(),
	`ade-sensitive-ignore-${process.pid}-${Date.now()}`,
);
const IGNORE_PATH = join(TEST_ROOT, ".stignore");

afterEach(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ensureSensitiveSyncIgnore", () => {
	test("creates the managed block with every local-sensitive pattern", () => {
		mkdirSync(TEST_ROOT, { recursive: true });

		const result = ensureSensitiveSyncIgnore(TEST_ROOT);
		const contents = readFileSync(IGNORE_PATH, "utf8");

		expect(result).toEqual({ path: IGNORE_PATH, changed: true });
		expect(contents).toContain(SENSITIVE_SYNC_IGNORE_BEGIN);
		expect(contents).toContain(SENSITIVE_SYNC_IGNORE_END);
		expect(contents).toContain("/device-id");
		expect(contents).toContain("/provider-accounts/**");
		expect(contents).toContain("/diagnostics/**");
		expect(contents).toContain("/recovery/**");
		expect(contents).toContain("/crash-dumps/**");
		expect(contents).toContain("/logs/**");
		expect(contents).toContain("/updates/**");
		expect(contents).toContain("*.part");
		expect(contents).toContain("/terminal-host.*");
		expect(contents).toContain("/service.log");
	});

	test("preserves every existing byte while prepending the block", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const original = Buffer.concat([
			Buffer.from("// user comment\r\n(?d) user-cache/**\r\n", "utf8"),
			Buffer.from([0xff, 0x00, 0x7f]),
		]);
		writeFileSync(IGNORE_PATH, original);

		ensureSensitiveSyncIgnore(TEST_ROOT);
		const next = readFileSync(IGNORE_PATH);

		expect(
			next.subarray(0, SENSITIVE_SYNC_IGNORE_BEGIN.length).toString(),
		).toBe(SENSITIVE_SYNC_IGNORE_BEGIN);
		expect(next.subarray(next.length - original.length).equals(original)).toBe(
			true,
		);
	});

	test("replaces only the managed block and preserves byte-exact prefix and suffix", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const prefix = Buffer.from("// keep-before\r\n", "utf8");
		const staleBlock = Buffer.from(
			`${SENSITIVE_SYNC_IGNORE_BEGIN}\n/stale-private-path/**\n${SENSITIVE_SYNC_IGNORE_END}`,
			"utf8",
		);
		const suffix = Buffer.concat([
			Buffer.from("\r\n// keep-after\r\n", "utf8"),
			Buffer.from([0xfe, 0x01]),
		]);
		writeFileSync(IGNORE_PATH, Buffer.concat([prefix, staleBlock, suffix]));

		ensureSensitiveSyncIgnore(TEST_ROOT);
		const next = readFileSync(IGNORE_PATH);

		expect(
			next.subarray(0, SENSITIVE_SYNC_IGNORE_BEGIN.length).toString(),
		).toBe(SENSITIVE_SYNC_IGNORE_BEGIN);
		const outside = Buffer.concat([prefix, suffix]);
		expect(next.subarray(next.length - outside.length).equals(outside)).toBe(
			true,
		);
		expect(next.includes(Buffer.from("/stale-private-path/**"))).toBe(false);
		expect(next.includes(Buffer.from("/provider-accounts/**"))).toBe(true);
	});

	test("places sensitive exclusions before a conflicting user negation", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		writeFileSync(
			IGNORE_PATH,
			"!/provider-accounts/**\n// keep user rules byte-exact\n",
			"utf8",
		);

		ensureSensitiveSyncIgnore(TEST_ROOT);
		const contents = readFileSync(IGNORE_PATH, "utf8");

		expect(contents.indexOf("\n/provider-accounts/**\n")).toBeLessThan(
			contents.indexOf("!/provider-accounts/**"),
		);
	});

	test("keeps an LF escape directive and its leading preamble before managed patterns", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const prefix = Buffer.from(
			"// keep this leading comment\n\n#escape=\\\n",
			"utf8",
		);
		const suffix = Buffer.from(
			"!/provider-accounts/**\n/custom/\\{literal\\}\n",
			"utf8",
		);
		writeFileSync(IGNORE_PATH, Buffer.concat([prefix, suffix]));

		ensureSensitiveSyncIgnore(TEST_ROOT);
		const first = readFileSync(IGNORE_PATH);
		const contents = first.toString("utf8");

		expect(first.subarray(0, prefix.length).equals(prefix)).toBe(true);
		expect(first.subarray(first.length - suffix.length).equals(suffix)).toBe(
			true,
		);
		expect(contents.indexOf("#escape=\\")).toBeLessThan(
			contents.indexOf(SENSITIVE_SYNC_IGNORE_BEGIN),
		);
		expect(contents.indexOf("\n/provider-accounts/**\n")).toBeLessThan(
			contents.indexOf("!/provider-accounts/**"),
		);
		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(false);
		expect(readFileSync(IGNORE_PATH).equals(first)).toBe(true);
	});

	test("keeps a CRLF pipe escape directive before managed and user patterns", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const prefix = Buffer.from(
			"\r\n// keep this Windows preamble\r\n#escape=|\r\n",
			"utf8",
		);
		const suffix = Buffer.from(
			"|{literal|}\r\n!/provider-accounts/**\r\n",
			"utf8",
		);
		writeFileSync(IGNORE_PATH, Buffer.concat([prefix, suffix]));

		ensureSensitiveSyncIgnore(TEST_ROOT);
		const first = readFileSync(IGNORE_PATH);
		const contents = first.toString("utf8");

		expect(first.subarray(0, prefix.length).equals(prefix)).toBe(true);
		expect(first.subarray(first.length - suffix.length).equals(suffix)).toBe(
			true,
		);
		expect(contents.indexOf("#escape=|")).toBeLessThan(
			contents.indexOf(SENSITIVE_SYNC_IGNORE_BEGIN),
		);
		expect(contents.indexOf(SENSITIVE_SYNC_IGNORE_END)).toBeLessThan(
			contents.indexOf("|{literal|}"),
		);
		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(false);
		expect(readFileSync(IGNORE_PATH).equals(first)).toBe(true);
	});

	test("is byte-for-byte idempotent", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		writeFileSync(IGNORE_PATH, "// user rule\n/custom/**\n", "utf8");

		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(true);
		const first = readFileSync(IGNORE_PATH);
		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(false);
		expect(readFileSync(IGNORE_PATH).equals(first)).toBe(true);
	});

	test("refuses a malformed managed block without changing the file", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const malformed = Buffer.from(
			`// user rule\n${SENSITIVE_SYNC_IGNORE_BEGIN}\n/orphaned/**\n`,
			"utf8",
		);
		writeFileSync(IGNORE_PATH, malformed);

		expect(() => ensureSensitiveSyncIgnore(TEST_ROOT)).toThrow(
			"malformed managed block",
		);
		expect(existsSync(IGNORE_PATH)).toBe(true);
		expect(readFileSync(IGNORE_PATH).equals(malformed)).toBe(true);
	});
});

describe("assertSensitiveSyncIgnoreReady", () => {
	test("refuses syncable legacy credential storage after ignore installation fails", () => {
		expect(() =>
			assertSensitiveSyncIgnoreReady({
				ignoreReady: false,
			}),
		).toThrow("managed sync ignore");
	});

	test("refuses startup even with private credentials because other local data is sensitive", () => {
		expect(() =>
			assertSensitiveSyncIgnoreReady({
				ignoreReady: false,
			}),
		).toThrow("managed sync ignore");
	});
});
