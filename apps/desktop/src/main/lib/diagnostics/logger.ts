import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import {
	type DiagnosticRedactionOptions,
	redactDiagnosticText,
	redactDiagnosticValue,
} from "./redaction";

export const DIAGNOSTICS_LOG_MAX_BYTES = 1024 * 1024;
export const DIAGNOSTICS_LOG_MAX_FILES = 3;
export const DIAGNOSTICS_LOG_FILE_NAME = "ade.jsonl";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MIN_LOG_SIZE = 256;
const MAX_EVENT_LENGTH = 4096;

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
	timestamp: string;
	level: DiagnosticLogLevel;
	event: string;
	details?: unknown;
}

export interface DiagnosticsLogger {
	debug(event: string, details?: unknown): void;
	info(event: string, details?: unknown): void;
	warn(event: string, details?: unknown): void;
	error(event: string, details?: unknown): void;
}

interface DiagnosticsConsole {
	debug(...values: unknown[]): void;
	info(...values: unknown[]): void;
	warn(...values: unknown[]): void;
	error(...values: unknown[]): void;
}

export interface CreateDiagnosticsLoggerOptions
	extends DiagnosticRedactionOptions {
	directory: string;
	maxBytes?: number;
	maxFiles?: number;
	now?: () => Date;
	mirrorToConsole?: boolean;
	console?: DiagnosticsConsole;
}

export interface InitializeDiagnosticsLoggerOptions
	extends Omit<CreateDiagnosticsLoggerOptions, "directory"> {
	privateRoot?: string;
	directory?: string;
}

export interface ReadRecentDiagnosticEntriesOptions
	extends DiagnosticRedactionOptions {
	directory: string;
	limit?: number;
}

export function resolveDiagnosticsDirectory(privateRoot: string): string {
	return join(privateRoot, "diagnostics");
}

export function resolveDiagnosticsLogDirectory(privateRoot: string): string {
	return join(resolveDiagnosticsDirectory(privateRoot), "logs");
}

export function resolveDiagnosticsCrashDirectory(privateRoot: string): string {
	return join(resolveDiagnosticsDirectory(privateRoot), "crashes");
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Create one path segment at a time so an existing link is never traversed. */
export function ensurePrivateDiagnosticsDirectory(directory: string): string {
	const absolute = resolve(directory);
	const root = parse(absolute).root;
	const segments = relative(root, absolute).split(sep).filter(Boolean);
	let cursor = root;

	for (const segment of segments) {
		cursor = join(cursor, segment);
		try {
			const entry = lstatSync(cursor);
			if (entry.isSymbolicLink()) {
				throw new Error(
					"Refusing to traverse a symbolic link in the diagnostics path",
				);
			}
			if (!entry.isDirectory()) {
				throw new Error("Diagnostics path contains a non-directory entry");
			}
		} catch (error) {
			if (!isMissing(error)) throw error;
			mkdirSync(cursor, { mode: PRIVATE_DIRECTORY_MODE });
			const created = lstatSync(cursor);
			if (created.isSymbolicLink() || !created.isDirectory()) {
				throw new Error("Diagnostics directory creation was not safe");
			}
		}
	}

	try {
		chmodSync(absolute, PRIVATE_DIRECTORY_MODE);
	} catch {
		// Windows does not implement POSIX modes. The OS-local namespace remains
		// protected by its user profile ACL and link checks above.
	}
	return absolute;
}

function rotatedLogPath(directory: string, index: number): string {
	return index === 0
		? join(directory, DIAGNOSTICS_LOG_FILE_NAME)
		: join(directory, `ade.${index}.jsonl`);
}

function assertSafeLogFile(path: string): void {
	if (!existsSync(path)) return;
	const entry = lstatSync(path);
	if (entry.isSymbolicLink()) {
		throw new Error("Refusing to use a symbolic link as a diagnostics log");
	}
	if (!entry.isFile()) {
		throw new Error("Diagnostics log path is not a regular file");
	}
}

function rotateLogs(directory: string, maxFiles: number): void {
	if (maxFiles === 1) {
		const current = rotatedLogPath(directory, 0);
		assertSafeLogFile(current);
		rmSync(current, { force: true });
		return;
	}

	for (let index = maxFiles - 1; index >= 1; index -= 1) {
		const source = rotatedLogPath(directory, index - 1);
		const destination = rotatedLogPath(directory, index);
		assertSafeLogFile(source);
		assertSafeLogFile(destination);
		if (!existsSync(source)) continue;
		rmSync(destination, { force: true });
		renameSync(source, destination);
	}
}

function pruneExcessRotatedLogs(directory: string, maxFiles: number): void {
	for (const name of readdirSync(directory)) {
		const match = /^ade\.(\d+)\.jsonl$/.exec(name);
		if (!match) continue;
		const index = Number(match[1]);
		const isRetainedRotation =
			Number.isSafeInteger(index) &&
			index >= 1 &&
			index < maxFiles &&
			name === `ade.${index}.jsonl`;
		if (isRetainedRotation) continue;
		const path = join(directory, name);
		assertSafeLogFile(path);
		rmSync(path, { force: true });
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function serializeBoundedEntry(
	entry: DiagnosticLogEntry,
	maxBytes: number,
): string {
	let line = `${JSON.stringify(entry)}\n`;
	const originalBytes = byteLength(line);
	if (originalBytes <= maxBytes) return line;

	const bounded: DiagnosticLogEntry = {
		...entry,
		event:
			entry.event.length > MAX_EVENT_LENGTH
				? `${entry.event.slice(0, MAX_EVENT_LENGTH)}…`
				: entry.event,
		details: { truncated: true, originalBytes },
	};
	line = `${JSON.stringify(bounded)}\n`;
	if (byteLength(line) <= maxBytes) return line;

	// Tiny injected test limits may still be smaller than the structured entry.
	// Retain valid JSON and the truncation marker while discarding the event tail.
	bounded.event = bounded.event.slice(0, Math.max(0, maxBytes - 192));
	line = `${JSON.stringify(bounded)}\n`;
	if (byteLength(line) > maxBytes) {
		throw new Error(
			"Diagnostics log limit is too small for a structured entry",
		);
	}
	return line;
}

function normalizeOptions(options: CreateDiagnosticsLoggerOptions) {
	const maxBytes = options.maxBytes ?? DIAGNOSTICS_LOG_MAX_BYTES;
	const maxFiles = options.maxFiles ?? DIAGNOSTICS_LOG_MAX_FILES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_LOG_SIZE) {
		throw new Error(`Diagnostics maxBytes must be at least ${MIN_LOG_SIZE}`);
	}
	if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
		throw new Error("Diagnostics maxFiles must be a positive safe integer");
	}
	return { maxBytes, maxFiles };
}

export function createDiagnosticsLogger(
	options: CreateDiagnosticsLoggerOptions,
): DiagnosticsLogger {
	const directory = ensurePrivateDiagnosticsDirectory(options.directory);
	const { maxBytes, maxFiles } = normalizeOptions(options);
	pruneExcessRotatedLogs(directory, maxFiles);
	const now = options.now ?? (() => new Date());
	const mirrorToConsole =
		options.mirrorToConsole ?? process.env.NODE_ENV === "development";
	const consoleSink = options.console ?? console;
	const redactionOptions: DiagnosticRedactionOptions = {
		homePaths: options.homePaths,
	};

	function write(
		level: DiagnosticLogLevel,
		event: string,
		details?: unknown,
	): void {
		const entry: DiagnosticLogEntry = {
			timestamp: now().toISOString(),
			level,
			event: redactDiagnosticText(event, redactionOptions),
			...(details === undefined
				? {}
				: { details: redactDiagnosticValue(details, redactionOptions) }),
		};

		try {
			const line = serializeBoundedEntry(entry, maxBytes);
			const logPath = rotatedLogPath(directory, 0);
			assertSafeLogFile(logPath);
			const currentSize = existsSync(logPath) ? statSync(logPath).size : 0;
			if (currentSize > 0 && currentSize + byteLength(line) > maxBytes) {
				rotateLogs(directory, maxFiles);
			}
			assertSafeLogFile(logPath);
			appendFileSync(logPath, line, {
				encoding: "utf8",
				mode: PRIVATE_FILE_MODE,
			});
			try {
				chmodSync(logPath, PRIVATE_FILE_MODE);
			} catch {
				// Best effort on Windows; profile ACLs remain in force.
			}
		} catch (error) {
			if (mirrorToConsole) {
				consoleSink.error("[ADE diagnostics] local log write failed", {
					name: error instanceof Error ? error.name : "Error",
					message:
						error instanceof Error
							? redactDiagnosticText(error.message, redactionOptions)
							: "Unknown diagnostics write failure",
				});
			}
		}

		if (mirrorToConsole) {
			consoleSink[level]("[ADE diagnostics]", entry);
		}
	}

	return {
		debug: (event, details) => write("debug", event, details),
		info: (event, details) => write("info", event, details),
		warn: (event, details) => write("warn", event, details),
		error: (event, details) => write("error", event, details),
	};
}

const noOpLogger: DiagnosticsLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

let activeLogger: DiagnosticsLogger = noOpLogger;

export function initializeDiagnosticsLogger(
	options: InitializeDiagnosticsLoggerOptions,
): DiagnosticsLogger {
	if (Boolean(options.privateRoot) === Boolean(options.directory)) {
		throw new Error(
			"Provide exactly one diagnostics privateRoot or log directory",
		);
	}
	const directory = options.directory
		? options.directory
		: resolveDiagnosticsLogDirectory(options.privateRoot as string);
	activeLogger = createDiagnosticsLogger({ ...options, directory });
	return activeLogger;
}

export function getDiagnosticsLogger(): DiagnosticsLogger {
	return activeLogger;
}

export function logAppStateRecovery(details: unknown): void {
	activeLogger.warn("app-state.recovery", details);
}

export function logUpdateFailure(error: unknown, context?: unknown): void {
	activeLogger.error("update.failure", { error, context });
}

export function logHealthOperation(
	operation: string,
	outcome: "started" | "succeeded" | "warning" | "failed" | "cancelled",
	details?: unknown,
): void {
	const level =
		outcome === "failed" ? "error" : outcome === "warning" ? "warn" : "info";
	activeLogger[level](`health.${operation}.${outcome}`, details);
}

export function logProcessFailure(
	kind: "uncaught-exception" | "unhandled-rejection" | "bootstrap-import",
	error: unknown,
): void {
	activeLogger.error(`process.${kind}`, { error });
}

function parseRotationIndex(name: string): number | null {
	if (name === DIAGNOSTICS_LOG_FILE_NAME) return 0;
	const match = /^ade\.(\d+)\.jsonl$/.exec(name);
	return match ? Number(match[1]) : null;
}

function isDiagnosticEntry(value: unknown): value is DiagnosticLogEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<DiagnosticLogEntry>;
	return (
		typeof entry.timestamp === "string" &&
		["debug", "info", "warn", "error"].includes(entry.level ?? "") &&
		typeof entry.event === "string"
	);
}

export async function readRecentDiagnosticEntries({
	directory,
	limit = 100,
	homePaths,
}: ReadRecentDiagnosticEntriesOptions): Promise<DiagnosticLogEntry[]> {
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new Error(
			"Diagnostics entry limit must be a non-negative safe integer",
		);
	}
	if (limit === 0 || !existsSync(directory)) return [];
	ensurePrivateDiagnosticsDirectory(directory);

	const files = readdirSync(directory)
		.map((name) => ({ name, index: parseRotationIndex(name) }))
		.filter(
			(entry): entry is { name: string; index: number } => entry.index !== null,
		)
		.sort((left, right) => right.index - left.index);
	const entries: DiagnosticLogEntry[] = [];
	for (const file of files) {
		const path = join(directory, file.name);
		assertSafeLogFile(path);
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			if (!line) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (!isDiagnosticEntry(parsed)) continue;
				entries.push(
					redactDiagnosticValue(parsed, { homePaths }) as DiagnosticLogEntry,
				);
			} catch {
				// A torn final line must not prevent the Health page from opening.
			}
		}
	}
	return entries.slice(-limit);
}
