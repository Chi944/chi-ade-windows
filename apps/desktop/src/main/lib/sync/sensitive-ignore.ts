import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SENSITIVE_SYNC_IGNORE_BEGIN =
	"# >>> ADE managed sensitive paths >>>";
export const SENSITIVE_SYNC_IGNORE_END =
	"# <<< ADE managed sensitive paths <<<";

const MANAGED_BLOCK = Buffer.from(
	[
		SENSITIVE_SYNC_IGNORE_BEGIN,
		"// Device identity must remain local",
		"/device-id",
		"// Legacy provider credentials must never synchronize",
		"/provider-accounts/**",
		"// Local diagnostics, recovery, crash data, and logs",
		"/diagnostics/**",
		"/recovery/**",
		"/crash-dumps/**",
		"/logs/**",
		"// App-state recovery artifacts and atomic write temporaries",
		"/app-state.quarantine.*.json",
		"/.app-state.json.*.tmp",
		"/.app-state.json.*.displaced",
		"// Terminal host identity and runtime state are device-local",
		"/terminal-host.*",
		"/service.log",
		"// Verified update staging and partial downloads",
		"/updates/**",
		"*.part",
		SENSITIVE_SYNC_IGNORE_END,
	].join("\n"),
	"utf8",
);
const BEGIN_BYTES = Buffer.from(SENSITIVE_SYNC_IGNORE_BEGIN, "utf8");
const END_BYTES = Buffer.from(SENSITIVE_SYNC_IGNORE_END, "utf8");
const ESCAPE_DIRECTIVE_PREFIX = "#escape";

interface LeadingEscapeDirective {
	escapeRune: string;
	preambleEnd: number;
}

export interface SensitiveSyncIgnoreResult {
	path: string;
	changed: boolean;
}

export function assertSensitiveSyncIgnoreReady({
	ignoreReady,
}: {
	ignoreReady: boolean;
}): void {
	if (ignoreReady) return;
	throw new Error(
		"Application startup requires the managed sync ignore to protect device-local data",
	);
}

export function ensureSensitiveSyncIgnore(
	adeHomeDir: string,
): SensitiveSyncIgnoreResult {
	mkdirSync(adeHomeDir, { recursive: true, mode: 0o700 });
	const ignorePath = join(adeHomeDir, ".stignore");
	let original = Buffer.alloc(0);
	if (existsSync(ignorePath)) {
		const stat = lstatSync(ignorePath);
		if (stat.isSymbolicLink()) {
			throw new Error("Refusing to update a linked sync-ignore file");
		}
		if (!stat.isFile()) {
			throw new Error("Sync-ignore path is not a regular file");
		}
		original = readFileSync(ignorePath);
	}

	const next = withManagedBlock(original);
	if (next.equals(original)) {
		return { path: ignorePath, changed: false };
	}

	const temporaryPath = join(
		adeHomeDir,
		`.stignore-${process.pid}-${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporaryPath, next, { mode: 0o600, flag: "wx" });
		renameSync(temporaryPath, ignorePath);
		try {
			chmodSync(ignorePath, 0o600);
		} catch {
			// Windows does not provide POSIX modes.
		}
	} finally {
		rmSync(temporaryPath, { force: true });
	}

	return { path: ignorePath, changed: true };
}

function withManagedBlock(original: Buffer): Buffer {
	const begin = original.indexOf(BEGIN_BYTES);
	const endStart = original.indexOf(END_BYTES);
	if (
		(begin === -1) !== (endStart === -1) ||
		(begin !== -1 && endStart < begin)
	) {
		throw new Error("Sync-ignore contains a malformed managed block");
	}

	if (begin !== -1 && endStart !== -1) {
		const end = endStart + END_BYTES.length;
		if (
			original.indexOf(BEGIN_BYTES, begin + BEGIN_BYTES.length) !== -1 ||
			original.indexOf(END_BYTES, end) !== -1
		) {
			throw new Error("Sync-ignore contains a malformed managed block");
		}
		const prefix = original.subarray(0, begin);
		const outside = Buffer.concat([prefix, original.subarray(end)]);
		const directive = findLeadingEscapeDirective(outside);
		const prefixDirective = findLeadingEscapeDirective(prefix);
		const blockIsAlreadyPlaced = directive
			? prefixDirective?.preambleEnd === prefix.length
			: begin === 0;
		if (blockIsAlreadyPlaced) {
			assertManagedBlockSupportsEscapeRune(directive?.escapeRune);
			return Buffer.concat([prefix, MANAGED_BLOCK, original.subarray(end)]);
		}
		return prependManagedBlock(outside);
	}

	return prependManagedBlock(original);
}

function prependManagedBlock(outside: Buffer): Buffer {
	const directive = findLeadingEscapeDirective(outside);
	if (directive) {
		assertManagedBlockSupportsEscapeRune(directive.escapeRune);
		const prefix = outside.subarray(0, directive.preambleEnd);
		const suffix = outside.subarray(directive.preambleEnd);
		const prefixEndsWithNewline =
			prefix[prefix.length - 1] === 0x0a || prefix[prefix.length - 1] === 0x0d;
		const suffixBeginsWithNewline = suffix[0] === 0x0a || suffix[0] === 0x0d;
		return Buffer.concat([
			prefix,
			prefixEndsWithNewline ? Buffer.alloc(0) : Buffer.from("\n"),
			MANAGED_BLOCK,
			suffixBeginsWithNewline ? Buffer.alloc(0) : Buffer.from("\n"),
			suffix,
		]);
	}

	const beginsWithNewline = outside[0] === 0x0a || outside[0] === 0x0d;
	return Buffer.concat([
		MANAGED_BLOCK,
		beginsWithNewline ? Buffer.alloc(0) : Buffer.from("\n"),
		outside,
	]);
}

function assertManagedBlockSupportsEscapeRune(escapeRune?: string): void {
	if (!escapeRune || escapeRune === "\\") return;
	if (MANAGED_BLOCK.includes(Buffer.from(escapeRune, "utf8"))) {
		throw new Error(
			"Sync-ignore escape rune collides with the managed sensitive patterns",
		);
	}
}

function parseEscapeDirective(line: string): string {
	const directive = line.slice(ESCAPE_DIRECTIVE_PREFIX.length).trim();
	if (!directive.startsWith("=")) {
		throw new Error("Sync-ignore contains an invalid #escape directive");
	}
	const runes = [...directive.slice(1).trim()];
	if (runes.length !== 1) {
		throw new Error(
			"Sync-ignore #escape directive must contain exactly one rune",
		);
	}
	return runes[0];
}

function findLeadingEscapeDirective(
	contents: Buffer,
): LeadingEscapeDirective | null {
	let lineStart = 0;
	let preambleEnd = 0;
	let escapeRune: string | null = null;
	let sawPattern = false;
	while (lineStart < contents.length) {
		const newline = contents.indexOf(0x0a, lineStart);
		const lineEnd = newline === -1 ? contents.length : newline;
		const nextLineStart = newline === -1 ? lineEnd : newline + 1;
		const line = contents.subarray(lineStart, lineEnd).toString("utf8").trim();

		if (line.startsWith(ESCAPE_DIRECTIVE_PREFIX)) {
			if (escapeRune !== null || sawPattern) {
				throw new Error(
					"Sync-ignore #escape directive must appear once before all patterns",
				);
			}
			escapeRune = parseEscapeDirective(line);
			preambleEnd = nextLineStart;
			lineStart = nextLineStart;
			continue;
		}
		if (!sawPattern && (line.length === 0 || line.startsWith("//"))) {
			preambleEnd = nextLineStart;
		} else if (line.length !== 0 && !line.startsWith("//")) {
			sawPattern = true;
		}

		lineStart = nextLineStart;
	}

	return escapeRune === null ? null : { escapeRune, preambleEnd };
}
