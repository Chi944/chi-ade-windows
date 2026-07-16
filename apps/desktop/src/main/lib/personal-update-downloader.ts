import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
	type PersonalUpdateAsset,
	type PersonalUpdateManifest,
	selectPersonalUpdateAsset,
} from "../../shared/personal-update";
import {
	MAX_COMPLETED_INSTALLER_BYTES,
	pruneCompletedInstallerVersions,
} from "./diagnostics/update-storage-health";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface PersonalUpdateWriteHandle {
	write(chunk: Uint8Array): Promise<number>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface PersonalUpdateFileSystem {
	mkdir(path: string): Promise<void>;
	openExclusive(path: string): Promise<PersonalUpdateWriteHandle>;
	lstat(path: string): Promise<{
		isDirectory: boolean;
		isFile: boolean;
		isSymbolicLink: boolean;
		size: number;
	}>;
	readChunks(path: string): AsyncIterable<Uint8Array>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
}

export const nodePersonalUpdateFileSystem: PersonalUpdateFileSystem = {
	mkdir: async (path) => {
		await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
	},
	openExclusive: async (path) => {
		const handle = await open(path, "wx", FILE_MODE);
		return {
			write: async (chunk) => {
				const result = await handle.write(chunk);
				return result.bytesWritten;
			},
			sync: () => handle.sync(),
			close: () => handle.close(),
		};
	},
	lstat: async (path) => {
		const metadata = await lstat(path);
		return {
			isDirectory: metadata.isDirectory(),
			isFile: metadata.isFile(),
			isSymbolicLink: metadata.isSymbolicLink(),
			size: metadata.size,
		};
	},
	readChunks: (path) => createReadStream(path),
	rename,
	unlink,
	readdir,
};

export interface VerifiedPersonalUpdate {
	readonly path: string;
	readonly version: string;
	readonly buildNumber: number;
	readonly commitSha: string;
	readonly manifestFingerprint: string;
	readonly asset: PersonalUpdateAsset;
	readonly reused: boolean;
}

export type PersonalUpdateFetch = (
	input: Parameters<typeof globalThis.fetch>[0],
	init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

export interface DownloadPersonalUpdateOptions {
	manifest: PersonalUpdateManifest;
	platform?: string;
	arch?: string;
	updatesDirectory: string;
	fetch?: PersonalUpdateFetch;
	files?: PersonalUpdateFileSystem;
	getCurrentManifest: () => PersonalUpdateManifest | undefined;
	onProgress?: (percent: number) => void;
	signal?: AbortSignal;
	pruneCompletedInstallers?: (
		updatesDirectory: string,
		keepVersion: string,
	) => Promise<void>;
}

export interface OpenVerifiedPersonalUpdateOptions {
	verified: VerifiedPersonalUpdate;
	getCurrentManifest: () => PersonalUpdateManifest | undefined;
	confirm: (details: {
		version: string;
		buildNumber: number;
		name: string;
	}) => Promise<boolean>;
	createSnapshot: () => Promise<void>;
	openPath: (path: string) => Promise<string>;
	files?: PersonalUpdateFileSystem;
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function ensureNonLinkDirectoryPath(
	files: PersonalUpdateFileSystem,
	directory: string,
	label: string,
): Promise<string> {
	if (!directory || directory.includes("\0") || !isAbsolute(directory)) {
		throw new Error(`${label} must be a valid absolute path`);
	}
	const absolute = resolve(directory);
	const root = parse(absolute).root;
	const relativePath = relative(root, absolute);
	const segments = relativePath ? relativePath.split(sep) : [];
	if (
		!segments.length ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`${label} must be below its filesystem root`);
	}

	let cursor = root;
	for (const segment of segments) {
		cursor = join(cursor, segment);
		let metadata: Awaited<ReturnType<PersonalUpdateFileSystem["lstat"]>>;
		try {
			metadata = await files.lstat(cursor);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			await files.mkdir(cursor);
			metadata = await files.lstat(cursor);
		}
		if (metadata.isSymbolicLink || !metadata.isDirectory) {
			throw new Error(`${label} must be a non-link directory`);
		}
	}
	return absolute;
}

async function safeUnlink(
	files: PersonalUpdateFileSystem,
	path: string,
): Promise<void> {
	try {
		await files.unlink(path);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
}

function manifestFingerprint(manifest: PersonalUpdateManifest): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function assertCurrentManifest(
	expectedFingerprint: string,
	getCurrentManifest: () => PersonalUpdateManifest | undefined,
): PersonalUpdateManifest {
	const current = getCurrentManifest();
	if (!current || manifestFingerprint(current) !== expectedFingerprint) {
		throw new Error("Personal update manifest changed during the operation");
	}
	return current;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException("Personal update download aborted", "AbortError");
	}
}

async function hashFile(
	files: PersonalUpdateFileSystem,
	path: string,
): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of files.readChunks(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

async function isVerifiedFile(
	files: PersonalUpdateFileSystem,
	path: string,
	asset: PersonalUpdateAsset,
): Promise<boolean> {
	try {
		const metadata = await files.lstat(path);
		if (
			metadata.isSymbolicLink ||
			!metadata.isFile ||
			metadata.size !== asset.size
		) {
			return false;
		}
		return (await hashFile(files, path)) === asset.sha256;
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

async function writeAll(
	handle: PersonalUpdateWriteHandle,
	chunk: Uint8Array,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const written = await handle.write(chunk.subarray(offset));
		if (!Number.isSafeInteger(written) || written <= 0) {
			throw new Error("Update file write made no progress");
		}
		offset += written;
	}
}

function assertContentLength(response: Response, expectedSize: number): void {
	const raw = response.headers.get("content-length");
	if (raw === null) return;
	if (!/^[0-9]+$/.test(raw)) {
		throw new Error("Update Content-Length is invalid");
	}
	const actual = Number(raw);
	if (!Number.isSafeInteger(actual) || actual !== expectedSize) {
		throw new Error(
			`Update Content-Length mismatch: expected ${expectedSize}, received ${raw}`,
		);
	}
}

async function cleanupVersionDirectory(
	files: PersonalUpdateFileSystem,
	directory: string,
	keepName?: string,
): Promise<void> {
	let names: string[];
	try {
		names = await files.readdir(directory);
	} catch (error) {
		if (isMissingFile(error)) return;
		throw error;
	}
	for (const name of names) {
		if (name === keepName) continue;
		await safeUnlink(files, join(directory, name));
	}
}

function verifiedResult(
	manifest: PersonalUpdateManifest,
	asset: PersonalUpdateAsset,
	path: string,
	fingerprint: string,
	reused: boolean,
): VerifiedPersonalUpdate {
	return Object.freeze({
		path,
		version: manifest.version,
		buildNumber: manifest.buildNumber,
		commitSha: manifest.commitSha,
		manifestFingerprint: fingerprint,
		asset,
		reused,
	});
}

export async function downloadPersonalUpdate(
	options: DownloadPersonalUpdateOptions,
): Promise<VerifiedPersonalUpdate> {
	const files = options.files ?? nodePersonalUpdateFileSystem;
	const fetchUpdate = options.fetch ?? globalThis.fetch;
	const asset = selectPersonalUpdateAsset(
		options.manifest,
		options.platform,
		options.arch,
	);
	if (asset.size > MAX_COMPLETED_INSTALLER_BYTES) {
		throw new Error("Selected update installer exceeds the storage limit");
	}
	const fingerprint = manifestFingerprint(options.manifest);
	assertCurrentManifest(fingerprint, options.getCurrentManifest);
	throwIfAborted(options.signal);

	const updatesDirectory = await ensureNonLinkDirectoryPath(
		files,
		options.updatesDirectory,
		"Update storage root",
	);
	const versionDirectory = await ensureNonLinkDirectoryPath(
		files,
		join(updatesDirectory, options.manifest.version),
		"Update version directory",
	);
	const targetPath = join(versionDirectory, asset.name);
	const partPath = join(
		versionDirectory,
		`${asset.name}.build-${options.manifest.buildNumber}.part`,
	);
	await cleanupVersionDirectory(files, versionDirectory, asset.name);

	if (await isVerifiedFile(files, targetPath, asset)) {
		assertCurrentManifest(fingerprint, options.getCurrentManifest);
		await (options.pruneCompletedInstallers ?? pruneCompletedInstallerVersions)(
			updatesDirectory,
			options.manifest.version,
		);
		return verifiedResult(
			options.manifest,
			asset,
			targetPath,
			fingerprint,
			true,
		);
	}
	await safeUnlink(files, targetPath);

	let handle: PersonalUpdateWriteHandle | undefined;
	let handleClosed = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await fetchUpdate(asset.url, {
			signal: options.signal,
			redirect: "follow",
		});
		if (!response.ok) {
			throw new Error(`Update download failed with HTTP ${response.status}`);
		}
		if (!response.body) {
			throw new Error("Update response body is missing");
		}
		assertContentLength(response, asset.size);
		throwIfAborted(options.signal);

		await safeUnlink(files, partPath);
		handle = await files.openExclusive(partPath);
		reader = response.body.getReader();
		const hash = createHash("sha256");
		let transferred = 0;
		options.onProgress?.(0);

		while (true) {
			throwIfAborted(options.signal);
			const { done, value } = await reader.read();
			if (done) break;
			if (transferred + value.byteLength > asset.size) {
				throw new Error("Update stream exceeds manifest size");
			}
			await writeAll(handle, value);
			hash.update(value);
			transferred += value.byteLength;
			options.onProgress?.((transferred / asset.size) * 100);
			throwIfAborted(options.signal);
		}

		if (transferred !== asset.size) {
			throw new Error(
				`Update size mismatch: expected ${asset.size}, received ${transferred}`,
			);
		}
		const digest = hash.digest("hex");
		if (digest !== asset.sha256) {
			throw new Error("Update SHA-256 digest does not match the manifest");
		}

		await handle.sync();
		await handle.close();
		handleClosed = true;
		assertCurrentManifest(fingerprint, options.getCurrentManifest);
		await files.rename(partPath, targetPath);
		await cleanupVersionDirectory(files, versionDirectory, asset.name);
		await (options.pruneCompletedInstallers ?? pruneCompletedInstallerVersions)(
			updatesDirectory,
			options.manifest.version,
		);
		return verifiedResult(
			options.manifest,
			asset,
			targetPath,
			fingerprint,
			false,
		);
	} catch (error) {
		try {
			await reader?.cancel(error);
		} catch {
			// The source may already have failed or closed.
		}
		throw error;
	} finally {
		if (handle && !handleClosed) {
			try {
				await handle.close();
			} catch {
				// Preserve the primary download error; unlink below is the cleanup gate.
			}
		}
		await safeUnlink(files, partPath);
	}
}

async function assertVerifiedInstaller(
	verified: VerifiedPersonalUpdate,
	files: PersonalUpdateFileSystem,
): Promise<void> {
	if (!(await isVerifiedFile(files, verified.path, verified.asset))) {
		await safeUnlink(files, verified.path);
		throw new Error("The verified installer no longer matches its manifest");
	}
}

export async function openVerifiedPersonalUpdate(
	options: OpenVerifiedPersonalUpdateOptions,
): Promise<"cancelled" | "opened"> {
	const files = options.files ?? nodePersonalUpdateFileSystem;
	try {
		assertCurrentManifest(
			options.verified.manifestFingerprint,
			options.getCurrentManifest,
		);
	} catch (error) {
		await safeUnlink(files, options.verified.path);
		throw error;
	}
	await assertVerifiedInstaller(options.verified, files);

	const confirmed = await options.confirm({
		version: options.verified.version,
		buildNumber: options.verified.buildNumber,
		name: options.verified.asset.name,
	});
	if (!confirmed) return "cancelled";

	assertCurrentManifest(
		options.verified.manifestFingerprint,
		options.getCurrentManifest,
	);
	await options.createSnapshot();
	assertCurrentManifest(
		options.verified.manifestFingerprint,
		options.getCurrentManifest,
	);
	await assertVerifiedInstaller(options.verified, files);
	const openError = await options.openPath(options.verified.path);
	if (openError) {
		throw new Error(`Failed to open verified installer: ${openError}`);
	}
	return "opened";
}
