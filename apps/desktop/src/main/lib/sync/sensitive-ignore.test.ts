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

function parseSyncthingEscapeRune(lines: string[]): string {
	let escapeRune = "\\";
	let sawDirective = false;
	let sawPattern = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("#escape")) {
			if (sawDirective || sawPattern) {
				throw new Error("invalid #escape placement");
			}
			const directive = line.slice("#escape".length).trim();
			if (!directive.startsWith("=")) {
				throw new Error("invalid #escape directive");
			}
			const runes = [...directive.slice(1).trim()];
			if (runes.length !== 1) {
				throw new Error("invalid #escape rune");
			}
			[escapeRune] = runes;
			sawDirective = true;
			continue;
		}
		if (line === "" || line.startsWith("//")) continue;
		sawPattern = true;
	}
	return escapeRune;
}

function applySyncthingEscapeRune(pattern: string, escapeRune: string): string {
	if (escapeRune === "\\") return pattern;
	const runes = [...pattern];
	let escaped = "";
	for (let index = 0; index < runes.length; index += 1) {
		if (runes[index] !== escapeRune) {
			escaped += runes[index];
			continue;
		}
		if (runes[index + 1] === escapeRune) {
			escaped += `\\${escapeRune}`;
			index += 1;
		} else {
			escaped += "\\";
		}
	}
	return escaped;
}

function managedPatternMatches(contents: string, path: string): boolean {
	const lines = contents.split(/\r?\n/);
	const escapeRune = parseSyncthingEscapeRune(lines);
	const begin = lines.findIndex(
		(line) => line.trim() === SENSITIVE_SYNC_IGNORE_BEGIN,
	);
	const end = lines.findIndex(
		(line) => line.trim() === SENSITIVE_SYNC_IGNORE_END,
	);
	if (begin === -1 || end <= begin) {
		throw new Error("managed block missing");
	}
	const candidate = path.startsWith("/") ? path.slice(1) : path;
	return lines.slice(begin + 1, end).some((rawPattern) => {
		const pattern = rawPattern.trim();
		if (!pattern.startsWith("/")) return false;
		const compiled = applySyncthingEscapeRune(pattern.slice(1), escapeRune);
		return new Bun.Glob(compiled).match(candidate);
	});
}

function expectManagedRecoverySemantics(contents: string): void {
	expect(
		managedPatternMatches(
			contents,
			"/app-state.quarantine.1700000000000.id.json",
		),
	).toBe(true);
	expect(managedPatternMatches(contents, "/.app-state.json.123.id.tmp")).toBe(
		true,
	);
	expect(
		managedPatternMatches(contents, "/.app-state.json.123.id.displaced"),
	).toBe(true);
	expect(
		managedPatternMatches(
			contents,
			"/nested/app-state.quarantine.1700000000000.id.json",
		),
	).toBe(false);
	expect(
		managedPatternMatches(contents, "/nested/.app-state.json.123.id.tmp"),
	).toBe(false);
	expect(
		managedPatternMatches(contents, "/nested/.app-state.json.123.id.displaced"),
	).toBe(false);
	expect(managedPatternMatches(contents, "/app-state.json")).toBe(false);
}

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
		expect(contents).toContain("/app-state.quarantine.*.json");
		expect(contents).toContain("/.app-state.json.*.tmp");
		expect(contents).toContain("/.app-state.json.*.displaced");
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

	test("anchors app-state recovery artifacts while leaving the durable state syncable", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		writeFileSync(
			IGNORE_PATH,
			"!/app-state.quarantine.*.json\n!/.app-state.json.*.tmp\n",
			"utf8",
		);

		ensureSensitiveSyncIgnore(TEST_ROOT);
		const contents = readFileSync(IGNORE_PATH, "utf8");

		expect(contents.indexOf("/app-state.quarantine.*.json")).toBeLessThan(
			contents.indexOf("!/app-state.quarantine.*.json"),
		);
		expect(contents.indexOf("/.app-state.json.*.tmp")).toBeLessThan(
			contents.indexOf("!/.app-state.json.*.tmp"),
		);
		expectManagedRecoverySemantics(contents);
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

	test("keeps an indented CRLF pipe escape preamble before managed and user patterns", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const prefix = Buffer.from(
			" \t\r\n  // keep this Windows preamble\r\n\t#escape \t= \t| \t\r\n  // keep after directive\r\n",
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
		expect(contents.indexOf("#escape \t= \t| ")).toBeLessThan(
			contents.indexOf(SENSITIVE_SYNC_IGNORE_BEGIN),
		);
		expect(contents.indexOf(SENSITIVE_SYNC_IGNORE_END)).toBeLessThan(
			contents.indexOf("|{literal|}"),
		);
		expectManagedRecoverySemantics(contents);
		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(false);
		expect(readFileSync(IGNORE_PATH).equals(first)).toBe(true);
	});

	test("keeps a one-rune Unicode escape directive without changing managed wildcard semantics", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const prefix = Buffer.from(
			"\t// Unicode escape preamble\n \t\n  #escape = 界  \n",
			"utf8",
		);
		const suffix = Buffer.from(
			"界{literal界}\n!/app-state.quarantine.*.json\n",
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
		expect(contents.indexOf("#escape = 界")).toBeLessThan(
			contents.indexOf(SENSITIVE_SYNC_IGNORE_BEGIN),
		);
		expectManagedRecoverySemantics(contents);
		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(false);
		expect(readFileSync(IGNORE_PATH).equals(first)).toBe(true);
	});

	test("repairs a legacy managed block placed before a raw escape preamble", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		ensureSensitiveSyncIgnore(TEST_ROOT);
		const generated = readFileSync(IGNORE_PATH);
		const managedEnd =
			generated.indexOf(Buffer.from(SENSITIVE_SYNC_IGNORE_END, "utf8")) +
			Buffer.byteLength(SENSITIVE_SYNC_IGNORE_END, "utf8");
		const legacyManagedBlock = generated.subarray(0, managedEnd);
		const rawPreamble = Buffer.from(
			"\r\n \t\r\n  // preserve this Windows preamble\r\n\t#escape = 界 \t\r\n  // preserve after directive\r\n",
			"utf8",
		);
		const userPatterns = Buffer.from(
			"界{literal界}\r\n!/app-state.quarantine.*.json\r\n/custom/**\r\n",
			"utf8",
		);
		writeFileSync(
			IGNORE_PATH,
			Buffer.concat([legacyManagedBlock, rawPreamble, userPatterns]),
		);

		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(true);
		const repaired = readFileSync(IGNORE_PATH);
		const contents = repaired.toString("utf8");

		expect(repaired.subarray(0, rawPreamble.length).equals(rawPreamble)).toBe(
			true,
		);
		expect(
			repaired
				.subarray(repaired.length - userPatterns.length)
				.equals(userPatterns),
		).toBe(true);
		expect(contents.indexOf("#escape = 界")).toBeLessThan(
			contents.indexOf(SENSITIVE_SYNC_IGNORE_BEGIN),
		);
		expectManagedRecoverySemantics(contents);
		expect(ensureSensitiveSyncIgnore(TEST_ROOT).changed).toBe(false);
		expect(readFileSync(IGNORE_PATH).equals(repaired)).toBe(true);
	});

	test("fails closed when the escape rune collides with managed wildcards", () => {
		mkdirSync(TEST_ROOT, { recursive: true });
		const original = Buffer.from(
			"  // valid preamble\r\n#escape = *\r\n/custom/**\r\n",
			"utf8",
		);
		writeFileSync(IGNORE_PATH, original);

		expect(() => ensureSensitiveSyncIgnore(TEST_ROOT)).toThrow(
			/escape|wildcard|managed/i,
		);
		expect(readFileSync(IGNORE_PATH).equals(original)).toBe(true);
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
