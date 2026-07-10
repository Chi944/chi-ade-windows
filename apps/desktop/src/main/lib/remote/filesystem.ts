import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DirectoryEntry } from "shared/file-tree-types";
import { treeKillWithEscalation } from "../tree-kill";
import {
	buildSshArgs,
	buildSshProcessEnv,
	resolveSystemSshExecutable,
	type SshProfileInput,
	sshTarget,
	validateRemotePath,
} from "./ssh";

const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;
const WRITE_LIMIT = 2 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const EDITOR_TIMEOUT_MS = 60 * 1000;
const METADATA_TIMEOUT_MS = 20 * 1000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_UPLOAD_FILES = 100;

const DIRECTORY_SCRIPT = `root=$1
[ -d "$root" ] && [ -r "$root" ] && [ -x "$root" ] || { printf "Remote directory not found or unreadable\\n" >&2; exit 2; }
for p in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  if [ -L "$p" ]; then t=l; elif [ -d "$p" ]; then t=d; else t=f; fi
  name=\${p##*/}
  printf "%s\\000%s\\000" "$t" "$name"
done`;
const FILE_METADATA_SCRIPT = `file=$1
if [ -L "$file" ]; then printf "l\\0000\\000"
elif [ -d "$file" ]; then printf "d\\0000\\000"
elif [ -f "$file" ]; then size=$(wc -c < "$file") || exit 1; printf "f\\000%s\\000" "$size"
else printf "m\\0000\\000"
fi`;
const COMMIT_EDITOR_SAVE_SCRIPT = `target=$1
incoming=$2
expected=$3
lock="\${target}.ade-save-lock"
mkdir "$lock" 2>/dev/null || { printf "ADE_CONFLICT: another save is active\\n" >&2; exit 73; }
cleanup() { rmdir "$lock" 2>/dev/null || true; }
trap cleanup EXIT
trap "exit 78" HUP INT TERM
[ -f "$target" ] && [ ! -L "$target" ] || { printf "ADE_CONFLICT: target is no longer a regular file\\n" >&2; exit 74; }
if command -v sha256sum >/dev/null 2>&1; then set -- $(sha256sum "$target"); current=$1
elif command -v shasum >/dev/null 2>&1; then set -- $(shasum -a 256 "$target"); current=$1
elif command -v openssl >/dev/null 2>&1; then current=$(openssl dgst -sha256 "$target"); current=\${current##* }
else printf "No SHA-256 utility is available on the SSH host\\n" >&2; exit 75
fi
[ "$current" = "$expected" ] || { printf "ADE_CONFLICT: file changed on the SSH host\\n" >&2; exit 76; }
mode=$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || true)
mv "$incoming" "$target" || exit 77
[ -z "$mode" ] || chmod "$mode" "$target"`;

export interface RemoteFilesystemContext {
	profile: SshProfileInput;
	remoteRoot: string;
}

interface ProcessResult {
	stdout: Buffer;
	stderr: Buffer;
}

export class RemoteFileConflictError extends Error {
	constructor(message = "The remote file changed since it was opened") {
		super(message);
		this.name = "RemoteFileConflictError";
	}
}

class RemoteFileTooLargeError extends Error {}
class UnsupportedRemoteFileTypeError extends Error {}

export function resolveSystemSftpExecutable(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "win32") {
		const windowsRoot = env.WINDIR || env.SystemRoot || "C:\\Windows";
		return path.win32.join(windowsRoot, "System32", "OpenSSH", "sftp.exe");
	}
	return "/usr/bin/sftp";
}

export function buildSftpArgs(profile: SshProfileInput): string[] {
	const args = ["-b", "-", "-F", "none", "-P", String(profile.port)];
	if (profile.identityFile) args.push("-i", profile.identityFile);
	args.push(
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=7",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ForwardX11=no",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"PermitLocalCommand=no",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"ConnectionAttempts=1",
		sshTarget(profile),
	);
	return args;
}

export function normalizeRemoteRelativePath(value: string): string {
	if (value.length > 2_048 || /^[\\/]/.test(value) || /[\0\r\n]/.test(value)) {
		throw new Error(
			"Remote path must be root-relative and contain no controls",
		);
	}
	const segments = value.split("/");
	if (segments.some((segment) => segment === "..")) {
		throw new Error("Remote path cannot leave the workspace root");
	}
	return segments.filter((segment) => segment && segment !== ".").join("/");
}

export function validateRemoteEntryName(value: string): string {
	if (
		!value ||
		value.length > 255 ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error("Invalid remote file name");
	}
	return value;
}

export function joinRemotePath(root: string, relativePath: string): string {
	if (!validateRemotePath(root))
		throw new Error("Invalid remote workspace root");
	const relative = normalizeRemoteRelativePath(relativePath);
	if (!relative) return root;
	return root === "/"
		? `/${relative}`
		: `${root.replace(/\/$/, "")}/${relative}`;
}

function quoteRemoteShell(value: string): string {
	if (/[\0\r\n]/.test(value)) throw new Error("Invalid remote shell value");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteRemoteScript(value: string): string {
	if (value.includes("\0")) throw new Error("Invalid remote script");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remotePathShellExpression(value: string): string {
	if (
		(!value.startsWith("/") && value !== "~" && !value.startsWith("~/")) ||
		/[\0\r\n]/.test(value)
	)
		throw new Error("Invalid remote workspace path");
	if (value === "~") return '"$HOME"';
	if (value.startsWith("~/")) {
		return `"$HOME"/${quoteRemoteShell(value.slice(2))}`;
	}
	return quoteRemoteShell(value);
}

function sftpRootPath(remoteRoot: string): string {
	if (!validateRemotePath(remoteRoot))
		throw new Error("Invalid remote workspace root");
	if (remoteRoot === "~") return ".";
	if (remoteRoot.startsWith("~/")) return `./${remoteRoot.slice(2)}`;
	return remoteRoot;
}

function encodeSftpOperand(value: string, local = false): string {
	if (/[\0\r\n]/.test(value)) throw new Error("Invalid SFTP path");
	const normalized = local ? value.replaceAll("\\", "/") : value;
	return `"${normalized.replace(/([\\"*?[\]])/g, "\\$1")}"`;
}

function remoteOperand(relativePath: string): string {
	const relative = normalizeRemoteRelativePath(relativePath);
	if (!relative) return ".";
	return `./${relative}`;
}

export function buildSftpBatch(remoteRoot: string, commands: string[]): string {
	return [
		`@cd ${encodeSftpOperand(sftpRootPath(remoteRoot))}`,
		...commands,
		"@bye",
		"",
	].join("\n");
}

async function runProcess(input: {
	executable: string;
	args: string[];
	stdin?: string;
	env: Record<string, string>;
	timeoutMs: number;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
}): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(input.executable, input.args, {
			env: input.env,
			windowsHide: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let terminalError: Error | null = null;
		let finished = false;
		const stop = (error: Error) => {
			if (terminalError) return;
			terminalError = error;
			if (child.pid) {
				void treeKillWithEscalation({ pid: child.pid });
			} else {
				child.kill();
			}
		};
		const timer = setTimeout(
			() =>
				stop(
					new Error(`Remote operation timed out after ${input.timeoutMs} ms`),
				),
			input.timeoutMs,
		);
		timer.unref();

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > (input.maxStdoutBytes ?? MAX_STDOUT_BYTES)) {
				stop(new Error("Remote operation returned too much data"));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > (input.maxStderrBytes ?? MAX_STDERR_BYTES)) {
				stop(new Error("Remote operation returned too much error output"));
				return;
			}
			stderr.push(chunk);
		});
		child.once("error", (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			const result = {
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			};
			if (terminalError) {
				reject(terminalError);
				return;
			}
			if (code !== 0) {
				const detail = result.stderr.toString("utf8").trim().slice(0, 4_000);
				reject(
					new Error(detail || `Remote operation exited with code ${code}`),
				);
				return;
			}
			resolve(result);
		});

		if (input.stdin !== undefined) child.stdin.end(input.stdin);
		else child.stdin.end();
	});
}

async function runSftpBatch(
	context: RemoteFilesystemContext,
	commands: string[],
	timeoutMs = TRANSFER_TIMEOUT_MS,
): Promise<ProcessResult> {
	return runProcess({
		executable: resolveSystemSftpExecutable(),
		args: buildSftpArgs(context.profile),
		stdin: buildSftpBatch(context.remoteRoot, commands),
		env: buildSshProcessEnv(),
		timeoutMs,
	});
}

async function runRemoteScript(
	context: RemoteFilesystemContext,
	script: string,
	argument: string,
): Promise<Buffer> {
	const remoteCommand = `sh -c ${quoteRemoteScript(script)} ade-remote ${remotePathShellExpression(argument)}`;
	const result = await runProcess({
		executable: resolveSystemSshExecutable(),
		args: [
			...buildSshArgs(context.profile, {
				batch: true,
				deterministic: true,
				agentForwarding: false,
				keepAlive: true,
			}),
			remoteCommand,
		],
		env: buildSshProcessEnv(),
		timeoutMs: METADATA_TIMEOUT_MS,
	});
	return result.stdout;
}

async function commitRemoteEditorSave(
	context: RemoteFilesystemContext,
	input: {
		relativePath: string;
		temporaryRelativePath: string;
		expectedRevision: string;
	},
): Promise<void> {
	const remoteCommand = buildRemoteEditorCommitCommand(
		context.remoteRoot,
		input,
	);
	try {
		await runProcess({
			executable: resolveSystemSshExecutable(),
			args: [
				...buildSshArgs(context.profile, {
					batch: true,
					deterministic: true,
					agentForwarding: false,
					keepAlive: true,
				}),
				remoteCommand,
			],
			env: buildSshProcessEnv(),
			timeoutMs: EDITOR_TIMEOUT_MS,
		});
	} catch (error) {
		if (/ADE_CONFLICT/i.test(String(error))) {
			throw new RemoteFileConflictError();
		}
		throw error;
	}
}

export function buildRemoteEditorCommitCommand(
	remoteRoot: string,
	input: {
		relativePath: string;
		temporaryRelativePath: string;
		expectedRevision: string;
	},
): string {
	if (!/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
		throw new Error("Invalid remote file revision");
	}
	const target = joinRemotePath(remoteRoot, input.relativePath);
	const incoming = joinRemotePath(remoteRoot, input.temporaryRelativePath);
	return [
		"sh -c",
		quoteRemoteScript(COMMIT_EDITOR_SAVE_SCRIPT),
		"ade-save",
		remotePathShellExpression(target),
		remotePathShellExpression(incoming),
		quoteRemoteShell(input.expectedRevision),
	].join(" ");
}

export function parseDirectoryRecords(
	buffer: Buffer,
): Array<{ type: "d" | "f" | "l"; name: string }> {
	const fields = buffer.toString("utf8").split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 2 !== 0)
		throw new Error("Invalid remote directory response");
	if (fields.length / 2 > MAX_DIRECTORY_ENTRIES) {
		throw new Error("Remote directory contains too many entries");
	}
	const entries: Array<{ type: "d" | "f" | "l"; name: string }> = [];
	for (let index = 0; index < fields.length; index += 2) {
		const type = fields[index];
		const name = fields[index + 1];
		if ((type !== "d" && type !== "f" && type !== "l") || !name) {
			throw new Error("Invalid remote directory entry");
		}
		if (name === "." || name === ".." || /[\0\r\n]/.test(name)) continue;
		entries.push({ type, name });
	}
	return entries;
}

export function parseRemoteFileMetadata(buffer: Buffer): {
	type: "d" | "f" | "l" | "missing";
	size: number;
} {
	const fields = buffer.toString("utf8").split("\0");
	const type = fields[0];
	const size = Number(fields[1]);
	if (
		(type !== "d" && type !== "f" && type !== "l" && type !== "m") ||
		!Number.isSafeInteger(size) ||
		size < 0
	) {
		throw new Error("Invalid remote file metadata response");
	}
	return { type: type === "m" ? "missing" : type, size };
}

async function readRemoteFileMetadata(
	context: RemoteFilesystemContext,
	relativePath: string,
) {
	return parseRemoteFileMetadata(
		await runRemoteScript(
			context,
			FILE_METADATA_SCRIPT,
			joinRemotePath(context.remoteRoot, relativePath),
		),
	);
}

export async function readRemoteDirectory(
	context: RemoteFilesystemContext,
	relativePath: string,
	includeHidden: boolean,
): Promise<DirectoryEntry[]> {
	const relative = normalizeRemoteRelativePath(relativePath);
	const absolute = joinRemotePath(context.remoteRoot, relative);
	return parseDirectoryRecords(
		await runRemoteScript(context, DIRECTORY_SCRIPT, absolute),
	)
		.filter((entry) => includeHidden || !entry.name.startsWith("."))
		.map((entry) => {
			const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
			return {
				id: childRelative,
				name: entry.name,
				path: joinRemotePath(context.remoteRoot, childRelative),
				relativePath: childRelative,
				isDirectory: entry.type === "d",
			};
		})
		.sort((left, right) => {
			if (left.isDirectory !== right.isDirectory)
				return left.isDirectory ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
}

async function withTemporaryDirectory<T>(
	callback: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "ade-sftp-"));
	try {
		return await callback(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

async function downloadRemoteBuffer(
	context: RemoteFilesystemContext,
	relativePath: string,
	maxBytes: number,
): Promise<Buffer> {
	const relative = normalizeRemoteRelativePath(relativePath);
	if (!relative) throw new Error("A remote file path is required");
	const metadata = await readRemoteFileMetadata(context, relative);
	if (metadata.type === "missing") throw new Error("Remote file not found");
	if (metadata.type !== "f") {
		throw new UnsupportedRemoteFileTypeError(
			metadata.type === "l"
				? "Remote symlink previews are not supported"
				: "Remote path is not a regular file",
		);
	}
	if (metadata.size > maxBytes) throw new RemoteFileTooLargeError();
	return withTemporaryDirectory(async (directory) => {
		const destination = path.join(directory, "payload");
		await runSftpBatch(
			context,
			[
				`@get ${encodeSftpOperand(remoteOperand(relative))} ${encodeSftpOperand(destination, true)}`,
			],
			EDITOR_TIMEOUT_MS,
		);
		return fs.readFile(destination);
	});
}

function revisionFor(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8 * 1024).includes(0);
}

function decodeUtf8(buffer: Buffer): string | null {
	if (looksBinary(buffer)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return null;
	}
}

export async function readRemoteFile(
	context: RemoteFilesystemContext,
	relativePath: string,
): Promise<
	| { ok: true; content: string; revision: string }
	| { ok: false; reason: "too-large" | "binary" | "not-found" }
> {
	try {
		const buffer = await downloadRemoteBuffer(
			context,
			relativePath,
			TEXT_PREVIEW_LIMIT,
		);
		const content = decodeUtf8(buffer);
		if (content === null) return { ok: false, reason: "binary" };
		return {
			ok: true,
			content,
			revision: revisionFor(buffer),
		};
	} catch (error) {
		if (error instanceof RemoteFileTooLargeError) {
			return { ok: false, reason: "too-large" };
		}
		if (error instanceof UnsupportedRemoteFileTypeError) {
			return { ok: false, reason: "binary" };
		}
		if (/not found|no such file/i.test(String(error))) {
			return { ok: false, reason: "not-found" };
		}
		throw error;
	}
}

function imageMimeType(relativePath: string): string | null {
	switch (path.posix.extname(relativePath).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".svg":
			return "image/svg+xml";
		default:
			return null;
	}
}

export async function readRemoteImage(
	context: RemoteFilesystemContext,
	relativePath: string,
): Promise<
	| { ok: true; dataUrl: string; byteLength: number }
	| { ok: false; reason: "too-large" | "not-image" | "not-found" }
> {
	const mime = imageMimeType(relativePath);
	if (!mime) return { ok: false, reason: "not-image" };
	try {
		const buffer = await downloadRemoteBuffer(
			context,
			relativePath,
			IMAGE_PREVIEW_LIMIT,
		);
		return {
			ok: true,
			dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
			byteLength: buffer.length,
		};
	} catch (error) {
		if (error instanceof RemoteFileTooLargeError) {
			return { ok: false, reason: "too-large" };
		}
		if (error instanceof UnsupportedRemoteFileTypeError) {
			return { ok: false, reason: "not-image" };
		}
		if (/not found|no such file/i.test(String(error))) {
			return { ok: false, reason: "not-found" };
		}
		throw error;
	}
}

export async function writeRemoteFile(
	context: RemoteFilesystemContext,
	input: { relativePath: string; content: string; expectedRevision?: string },
): Promise<{ revision: string }> {
	const relative = normalizeRemoteRelativePath(input.relativePath);
	if (!relative) throw new Error("A remote file path is required");
	const content = Buffer.from(input.content, "utf8");
	if (content.length > WRITE_LIMIT)
		throw new Error("Remote file is too large to save");
	if (
		input.expectedRevision &&
		!/^[a-f0-9]{64}$/.test(input.expectedRevision)
	) {
		throw new Error("Invalid remote file revision");
	}
	const parent =
		path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
	const temporaryRelative = parent
		? `${parent}/.ade-upload-${randomUUID()}`
		: `.ade-upload-${randomUUID()}`;
	return withTemporaryDirectory(async (directory) => {
		const source = path.join(directory, "payload");
		await fs.writeFile(source, content, { flag: "wx" });
		try {
			await runSftpBatch(
				context,
				[
					`@put -f ${encodeSftpOperand(source, true)} ${encodeSftpOperand(remoteOperand(temporaryRelative))}`,
					...(input.expectedRevision
						? []
						: [
								`@rename ${encodeSftpOperand(remoteOperand(temporaryRelative))} ${encodeSftpOperand(remoteOperand(relative))}`,
							]),
				],
				EDITOR_TIMEOUT_MS,
			);
			if (input.expectedRevision) {
				await commitRemoteEditorSave(context, {
					relativePath: relative,
					temporaryRelativePath: temporaryRelative,
					expectedRevision: input.expectedRevision,
				});
			}
		} catch (error) {
			await runSftpBatch(
				context,
				[`@rm ${encodeSftpOperand(remoteOperand(temporaryRelative))}`],
				EDITOR_TIMEOUT_MS,
			).catch(() => undefined);
			throw error;
		}
		return { revision: revisionFor(content) };
	});
}

async function assertRemoteNameAvailable(
	context: RemoteFilesystemContext,
	parentRelativePath: string,
	name: string,
): Promise<void> {
	const entries = await readRemoteDirectory(context, parentRelativePath, true);
	if (entries.some((entry) => entry.name === name)) {
		throw new Error("A remote item with that name already exists");
	}
}

export async function createRemoteFile(
	context: RemoteFilesystemContext,
	parentRelativePath: string,
	name: string,
): Promise<{ relativePath: string }> {
	const parent = normalizeRemoteRelativePath(parentRelativePath);
	const safeName = validateRemoteEntryName(name);
	await assertRemoteNameAvailable(context, parent, safeName);
	const relativePath = parent ? `${parent}/${safeName}` : safeName;
	await writeRemoteFile(context, { relativePath, content: "" });
	return { relativePath };
}

export async function createRemoteDirectory(
	context: RemoteFilesystemContext,
	parentRelativePath: string,
	name: string,
): Promise<{ relativePath: string }> {
	const parent = normalizeRemoteRelativePath(parentRelativePath);
	const safeName = validateRemoteEntryName(name);
	await assertRemoteNameAvailable(context, parent, safeName);
	const relativePath = parent ? `${parent}/${safeName}` : safeName;
	await runSftpBatch(context, [
		`@mkdir ${encodeSftpOperand(remoteOperand(relativePath))}`,
	]);
	return { relativePath };
}

export async function renameRemoteEntry(
	context: RemoteFilesystemContext,
	relativePath: string,
	newName: string,
): Promise<{ relativePath: string }> {
	const source = normalizeRemoteRelativePath(relativePath);
	if (!source) throw new Error("The remote root cannot be renamed");
	const parent =
		path.posix.dirname(source) === "." ? "" : path.posix.dirname(source);
	const safeName = validateRemoteEntryName(newName);
	await assertRemoteNameAvailable(context, parent, safeName);
	const destination = parent ? `${parent}/${safeName}` : safeName;
	await runSftpBatch(context, [
		`@rename ${encodeSftpOperand(remoteOperand(source))} ${encodeSftpOperand(remoteOperand(destination))}`,
	]);
	return { relativePath: destination };
}

async function findRemoteEntry(
	context: RemoteFilesystemContext,
	relativePath: string,
): Promise<DirectoryEntry> {
	const relative = normalizeRemoteRelativePath(relativePath);
	if (!relative) throw new Error("The remote root cannot be changed");
	const parent =
		path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
	const name = path.posix.basename(relative);
	const entry = (await readRemoteDirectory(context, parent, true)).find(
		(item) => item.name === name,
	);
	if (!entry) throw new Error("Remote item not found");
	return entry;
}

export async function removeRemoteEntry(
	context: RemoteFilesystemContext,
	relativePath: string,
): Promise<{ removed: true }> {
	const entry = await findRemoteEntry(context, relativePath);
	await runSftpBatch(context, [
		`@${entry.isDirectory ? "rmdir" : "rm"} ${encodeSftpOperand(remoteOperand(entry.relativePath))}`,
	]);
	return { removed: true };
}

export async function uploadLocalPaths(
	context: RemoteFilesystemContext,
	destinationRelativePath: string,
	localPaths: string[],
): Promise<{
	uploaded: Array<{
		localPath: string;
		relativePath: string;
		remotePath: string;
	}>;
}> {
	if (localPaths.length === 0 || localPaths.length > MAX_UPLOAD_FILES) {
		throw new Error(`Choose between 1 and ${MAX_UPLOAD_FILES} files`);
	}
	const destination = normalizeRemoteRelativePath(destinationRelativePath);
	const uploaded: Array<{
		localPath: string;
		relativePath: string;
		remotePath: string;
	}> = [];
	const uploadCommands: string[] = [];
	const commitCommands: string[] = [];
	const temporaryPaths: string[] = [];
	const seenNames = new Set<string>();
	const existingNames = new Set(
		(await readRemoteDirectory(context, destination, true)).map(
			(entry) => entry.name,
		),
	);
	for (const localPath of localPaths) {
		if (!path.isAbsolute(localPath))
			throw new Error("Upload paths must be absolute");
		const stat = await fs.lstat(localPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error("Remote uploads currently accept regular files only");
		}
		const name = validateRemoteEntryName(path.basename(localPath));
		if (seenNames.has(name)) throw new Error(`Duplicate upload name: ${name}`);
		if (existingNames.has(name)) {
			throw new Error(`A remote item named ${name} already exists`);
		}
		seenNames.add(name);
		const relativePath = destination ? `${destination}/${name}` : name;
		const temporaryPath = destination
			? `${destination}/.ade-upload-${randomUUID()}`
			: `.ade-upload-${randomUUID()}`;
		temporaryPaths.push(temporaryPath);
		uploadCommands.push(
			`@put -f ${encodeSftpOperand(localPath, true)} ${encodeSftpOperand(remoteOperand(temporaryPath))}`,
		);
		commitCommands.push(
			`@rename ${encodeSftpOperand(remoteOperand(temporaryPath))} ${encodeSftpOperand(remoteOperand(relativePath))}`,
		);
		uploaded.push({
			localPath,
			relativePath,
			remotePath: joinRemotePath(context.remoteRoot, relativePath),
		});
	}
	try {
		await runSftpBatch(context, uploadCommands);
		await runSftpBatch(context, commitCommands);
	} catch (error) {
		for (const temporaryPath of temporaryPaths) {
			await runSftpBatch(context, [
				`@rm ${encodeSftpOperand(remoteOperand(temporaryPath))}`,
			]).catch(() => undefined);
		}
		throw error;
	}
	return { uploaded };
}

async function pathExists(localPath: string): Promise<boolean> {
	try {
		await fs.access(localPath);
		return true;
	} catch {
		return false;
	}
}

export async function downloadRemoteEntry(
	context: RemoteFilesystemContext,
	relativePath: string,
	destinationPath: string,
): Promise<{ path: string; isDirectory: boolean }> {
	if (!path.isAbsolute(destinationPath)) {
		throw new Error("Download destination must be absolute");
	}
	const entry = await findRemoteEntry(context, relativePath);
	const metadata = await readRemoteFileMetadata(context, entry.relativePath);
	if (metadata.type === "l") {
		throw new Error("Remote symlink downloads are not supported");
	}
	if (metadata.type === "missing") throw new Error("Remote item not found");
	if (entry.isDirectory && (await pathExists(destinationPath))) {
		throw new Error(
			"A folder with that name already exists at the destination",
		);
	}
	const partPath = path.join(
		path.dirname(destinationPath),
		`.${path.basename(destinationPath)}.ade-part-${randomUUID()}`,
	);
	const backupPath = path.join(
		path.dirname(destinationPath),
		`.${path.basename(destinationPath)}.ade-backup-${randomUUID()}`,
	);
	let backupCreated = false;
	try {
		await runSftpBatch(context, [
			`@get ${entry.isDirectory ? "-r " : ""}${encodeSftpOperand(remoteOperand(entry.relativePath))} ${encodeSftpOperand(partPath, true)}`,
		]);
		if (!entry.isDirectory && (await pathExists(destinationPath))) {
			await fs.rename(destinationPath, backupPath);
			backupCreated = true;
		}
		try {
			await fs.rename(partPath, destinationPath);
		} catch (error) {
			if (backupCreated) {
				await fs.rename(backupPath, destinationPath).catch(() => undefined);
				backupCreated = false;
			}
			throw error;
		}
		if (backupCreated) {
			await fs.rm(backupPath, { force: true });
			backupCreated = false;
		}
		return { path: destinationPath, isDirectory: entry.isDirectory };
	} finally {
		await fs.rm(partPath, { recursive: true, force: true });
		if (backupCreated) {
			if (await pathExists(destinationPath)) {
				await fs.rm(backupPath, { force: true }).catch(() => undefined);
			} else {
				await fs.rename(backupPath, destinationPath).catch(() => undefined);
			}
		}
	}
}
