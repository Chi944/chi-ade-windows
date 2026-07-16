import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parsePersonalUpdateManifest } from "../../shared/personal-update";
import { MAX_COMPLETED_INSTALLER_BYTES } from "./diagnostics/update-storage-health";
import {
	downloadPersonalUpdate,
	nodePersonalUpdateFileSystem,
	openVerifiedPersonalUpdate,
	type PersonalUpdateFetch,
	type PersonalUpdateFileSystem,
} from "./personal-update-downloader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(
		join(await realpath(tmpdir()), "ade-update-test-"),
	);
	temporaryDirectories.push(directory);
	return directory;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function manifestFor(
	bytes: Uint8Array,
	options: { size?: number; digest?: string; buildNumber?: number } = {},
) {
	return parsePersonalUpdateManifest({
		schemaVersion: 1,
		version: "0.6.0",
		buildNumber: options.buildNumber ?? 123_456,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		publishedAt: "2026-07-16T01:02:03.000Z",
		releaseNotesUrl:
			"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
		assets: {
			"win32-x64": {
				name: "ADE-Windows-x64.exe",
				url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
				size: options.size ?? bytes.byteLength,
				sha256: options.digest ?? sha256(bytes),
			},
			"darwin-arm64": {
				name: "ADE-macOS-Apple-Silicon.dmg",
				url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg",
				size: 1,
				sha256: "b".repeat(64),
			},
			"darwin-x64": {
				name: "ADE-macOS-Intel.dmg",
				url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg",
				size: 1,
				sha256: "c".repeat(64),
			},
		},
	});
}

function responseFromChunks(
	chunks: Uint8Array[],
	options: { status?: number; contentLength?: number } = {},
): Response {
	const status = options.status ?? 200;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const headers = new Headers();
	if (options.contentLength !== undefined) {
		headers.set("content-length", String(options.contentLength));
	}
	return new Response(stream, { status, headers });
}

async function allFiles(directory: string): Promise<string[]> {
	try {
		return await readdir(directory, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function downloadOptions(
	directory: string,
	manifest: ReturnType<typeof manifestFor>,
	fetch: PersonalUpdateFetch,
) {
	return {
		manifest,
		platform: "win32",
		arch: "x64",
		updatesDirectory: directory,
		fetch,
		getCurrentManifest: () => manifest,
	};
}

describe("downloadPersonalUpdate", () => {
	test("rejects a linked update root without touching its target", async () => {
		const container = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const updatesDirectory = join(container, "updates");
		const sentinel = join(outside, "keep.txt");
		await writeFile(sentinel, "outside");
		await symlink(
			outside,
			updatesDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);
		const fetchUpdate = mock(async () => responseFromChunks([bytes]));

		await expect(
			downloadPersonalUpdate(
				downloadOptions(updatesDirectory, manifest, fetchUpdate),
			),
		).rejects.toThrow(/non-link directory/i);
		expect(fetchUpdate).not.toHaveBeenCalled();
		expect(await readFile(sentinel, "utf8")).toBe("outside");
	});

	test("rejects a linked version directory without touching its target", async () => {
		const updatesDirectory = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const sentinel = join(outside, "keep.txt");
		await writeFile(sentinel, "outside");
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);
		await symlink(
			outside,
			join(updatesDirectory, manifest.version),
			process.platform === "win32" ? "junction" : "dir",
		);
		const fetchUpdate = mock(async () => responseFromChunks([bytes]));

		await expect(
			downloadPersonalUpdate(
				downloadOptions(updatesDirectory, manifest, fetchUpdate),
			),
		).rejects.toThrow(/non-link directory/i);
		expect(fetchUpdate).not.toHaveBeenCalled();
		expect(await readFile(sentinel, "utf8")).toBe("outside");
	});

	test("rejects an oversized selected asset before filesystem writes or fetch", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes, {
			size: MAX_COMPLETED_INSTALLER_BYTES + 1,
		});
		const fetchUpdate = mock(async () => {
			throw new Error("fetch must not run");
		});
		const mkdirUpdateDirectory = mock(async () => {
			throw new Error("filesystem write must not run");
		});

		await expect(
			downloadPersonalUpdate({
				...downloadOptions(directory, manifest, fetchUpdate),
				files: {
					...nodePersonalUpdateFileSystem,
					mkdir: mkdirUpdateDirectory,
				},
			}),
		).rejects.toThrow("Selected update installer exceeds the storage limit");
		expect(fetchUpdate).not.toHaveBeenCalled();
		expect(mkdirUpdateDirectory).not.toHaveBeenCalled();
	});

	test("rejects HTTP failures and removes partial files", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);

		await expect(
			downloadPersonalUpdate(
				downloadOptions(
					directory,
					manifest,
					mock(async () => new Response("no", { status: 503 })),
				),
			),
		).rejects.toThrow("HTTP 503");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("rejects a successful response without a body", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);

		await expect(
			downloadPersonalUpdate(
				downloadOptions(
					directory,
					manifest,
					mock(async () => new Response(null, { status: 200 })),
				),
			),
		).rejects.toThrow("response body");
	});

	test("rejects a mismatched Content-Length before streaming", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);

		await expect(
			downloadPersonalUpdate(
				downloadOptions(
					directory,
					manifest,
					mock(async () =>
						responseFromChunks([bytes], {
							contentLength: bytes.byteLength + 1,
						}),
					),
				),
			),
		).rejects.toThrow("Content-Length");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("caps streamed bytes at the manifest size", async () => {
		const directory = await temporaryDirectory();
		const expected = new TextEncoder().encode("abc");
		const overflow = new TextEncoder().encode("abcd");
		const manifest = manifestFor(expected);

		await expect(
			downloadPersonalUpdate(
				downloadOptions(
					directory,
					manifest,
					mock(async () => responseFromChunks([overflow])),
				),
			),
		).rejects.toThrow("exceeds manifest size");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("reports exact progress from streamed bytes", async () => {
		const directory = await temporaryDirectory();
		const first = new Uint8Array([1, 2]);
		const second = new Uint8Array([3, 4, 5]);
		const bytes = new Uint8Array([...first, ...second]);
		const manifest = manifestFor(bytes);
		const progress: number[] = [];

		await downloadPersonalUpdate({
			...downloadOptions(
				directory,
				manifest,
				mock(async () =>
					responseFromChunks([first, second], {
						contentLength: bytes.byteLength,
					}),
				),
			),
			onProgress: (value) => progress.push(value),
		});

		expect(progress).toEqual([0, 40, 100]);
	});

	test("rejects a digest mismatch and removes the partial file", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes, { digest: "d".repeat(64) });

		await expect(
			downloadPersonalUpdate(
				downloadOptions(
					directory,
					manifest,
					mock(async () => responseFromChunks([bytes])),
				),
			),
		).rejects.toThrow("SHA-256");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("rejects a short stream and removes the partial file", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("abc");
		const manifest = manifestFor(bytes, { size: bytes.byteLength + 1 });

		await expect(
			downloadPersonalUpdate(
				downloadOptions(
					directory,
					manifest,
					mock(async () => responseFromChunks([bytes])),
				),
			),
		).rejects.toThrow("size mismatch");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("cleans up an aborted download", async () => {
		const directory = await temporaryDirectory();
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const manifest = manifestFor(bytes);
		const controller = new AbortController();

		await expect(
			downloadPersonalUpdate({
				...downloadOptions(
					directory,
					manifest,
					mock(async () =>
						responseFromChunks([bytes.subarray(0, 2), bytes.subarray(2)]),
					),
				),
				signal: controller.signal,
				onProgress: (progress) => {
					if (progress === 50) controller.abort();
				},
			}),
		).rejects.toThrow("aborted");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});

	test("fsyncs, closes, and atomically renames only a verified part", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);
		const operations: string[] = [];
		const files: PersonalUpdateFileSystem = {
			...nodePersonalUpdateFileSystem,
			openExclusive: async (...args) => {
				const handle = await nodePersonalUpdateFileSystem.openExclusive(
					...args,
				);
				return {
					write: (chunk) => handle.write(chunk),
					sync: async () => {
						operations.push("sync");
						await handle.sync();
					},
					close: async () => {
						operations.push("close");
						await handle.close();
					},
				};
			},
			rename: async (from, to) => {
				operations.push(`rename:${basename(from)}:${basename(to)}`);
				await nodePersonalUpdateFileSystem.rename(from, to);
			},
		};

		const verified = await downloadPersonalUpdate({
			...downloadOptions(
				directory,
				manifest,
				mock(async () => responseFromChunks([bytes])),
			),
			files,
		});

		expect(await readFile(verified.path)).toEqual(Buffer.from(bytes));
		expect(verified.reused).toBe(false);
		expect(operations.slice(0, 2)).toEqual(["sync", "close"]);
		expect(operations[2]).toMatch(/^rename:.*\.part:ADE-Windows-x64\.exe$/);
		expect(
			(await allFiles(directory)).filter((name) => !name.endsWith("/")),
		).toEqual(["0.6.0", join("0.6.0", "ADE-Windows-x64.exe")]);
	});

	test("rechecks and reuses an existing verified installer", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);
		const first = await downloadPersonalUpdate(
			downloadOptions(
				directory,
				manifest,
				mock(async () => responseFromChunks([bytes])),
			),
		);
		const fetch = mock(async () => {
			throw new Error("fetch must not run");
		});

		const second = await downloadPersonalUpdate(
			downloadOptions(directory, manifest, fetch),
		);

		expect(second.path).toBe(first.path);
		expect(second.reused).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("keeps only the two newest completed installer versions globally", async () => {
		const directory = await temporaryDirectory();
		for (const version of ["0.4.0", "0.5.0"]) {
			const versionDirectory = join(directory, version);
			await mkdir(versionDirectory, { recursive: true });
			await writeFile(join(versionDirectory, "ADE-Windows-x64.exe"), version);
		}
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);

		await downloadPersonalUpdate(
			downloadOptions(
				directory,
				manifest,
				mock(async () => responseFromChunks([bytes])),
			),
		);

		const completed = (await allFiles(directory)).filter((name) =>
			name.endsWith("ADE-Windows-x64.exe"),
		);
		expect(completed.sort()).toEqual([
			join("0.5.0", "ADE-Windows-x64.exe"),
			join("0.6.0", "ADE-Windows-x64.exe"),
		]);
	});

	test("removes a changed existing installer and downloads it again", async () => {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);
		const first = await downloadPersonalUpdate(
			downloadOptions(
				directory,
				manifest,
				mock(async () => responseFromChunks([bytes])),
			),
		);
		await writeFile(first.path, "tampered");
		const fetch = mock(async () => responseFromChunks([bytes]));

		const second = await downloadPersonalUpdate(
			downloadOptions(directory, manifest, fetch),
		);

		expect(second.reused).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await readFile(second.path)).toEqual(Buffer.from(bytes));
	});

	test("rejects when the active manifest changes during the download", async () => {
		const directory = await temporaryDirectory();
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const manifest = manifestFor(bytes);
		let activeManifest = manifest;

		await expect(
			downloadPersonalUpdate({
				...downloadOptions(
					directory,
					manifest,
					mock(async () =>
						responseFromChunks([bytes.subarray(0, 2), bytes.subarray(2)]),
					),
				),
				getCurrentManifest: () => activeManifest,
				onProgress: (progress) => {
					if (progress === 50) {
						activeManifest = manifestFor(bytes, { buildNumber: 123_457 });
					}
				},
			}),
		).rejects.toThrow("manifest changed");
		expect(
			(await allFiles(directory)).some((name) => name.endsWith(".part")),
		).toBe(false);
	});
});

describe("openVerifiedPersonalUpdate", () => {
	async function downloadedUpdate() {
		const directory = await temporaryDirectory();
		const bytes = new TextEncoder().encode("installer");
		const manifest = manifestFor(bytes);
		const verified = await downloadPersonalUpdate(
			downloadOptions(
				directory,
				manifest,
				mock(async () => responseFromChunks([bytes])),
			),
		);
		return { manifest, verified };
	}

	test("does nothing when the second installer confirmation is declined", async () => {
		const { manifest, verified } = await downloadedUpdate();
		const createSnapshot = mock(async () => {});
		const openPath = mock(async () => "");

		const result = await openVerifiedPersonalUpdate({
			verified,
			getCurrentManifest: () => manifest,
			confirm: mock(async () => false),
			createSnapshot,
			openPath,
		});

		expect(result).toBe("cancelled");
		expect(createSnapshot).not.toHaveBeenCalled();
		expect(openPath).not.toHaveBeenCalled();
	});

	test("reverifies, snapshots, and then opens after confirmation", async () => {
		const { manifest, verified } = await downloadedUpdate();
		const order: string[] = [];

		const result = await openVerifiedPersonalUpdate({
			verified,
			getCurrentManifest: () => manifest,
			confirm: mock(async (details) => {
				expect(details.version).toBe("0.6.0");
				expect(details.name).toBe("ADE-Windows-x64.exe");
				order.push("confirm");
				return true;
			}),
			createSnapshot: mock(async () => {
				order.push("snapshot");
			}),
			openPath: mock(async (path) => {
				expect(path).toBe(verified.path);
				order.push("open");
				return "";
			}),
		});

		expect(result).toBe("opened");
		expect(order).toEqual(["confirm", "snapshot", "open"]);
	});

	test("does not open a personal installer when its recovery snapshot fails", async () => {
		const { manifest, verified } = await downloadedUpdate();
		const openPath = mock(async () => "");

		await expect(
			openVerifiedPersonalUpdate({
				verified,
				getCurrentManifest: () => manifest,
				confirm: mock(async () => true),
				createSnapshot: mock(async () => {
					throw new Error("snapshot unavailable");
				}),
				openPath,
			}),
		).rejects.toThrow("snapshot unavailable");
		expect(openPath).not.toHaveBeenCalled();
	});

	test("refuses a tampered verified installer before confirmation", async () => {
		const { manifest, verified } = await downloadedUpdate();
		await writeFile(verified.path, "tampered");
		const confirm = mock(async () => true);

		await expect(
			openVerifiedPersonalUpdate({
				verified,
				getCurrentManifest: () => manifest,
				confirm,
				createSnapshot: mock(async () => {}),
				openPath: mock(async () => ""),
			}),
		).rejects.toThrow("verified installer");
		expect(confirm).not.toHaveBeenCalled();
	});

	test("refuses to open after the active manifest changes", async () => {
		const { verified } = await downloadedUpdate();
		const nextManifest = manifestFor(new TextEncoder().encode("installer"), {
			buildNumber: 123_457,
		});

		await expect(
			openVerifiedPersonalUpdate({
				verified,
				getCurrentManifest: () => nextManifest,
				confirm: mock(async () => true),
				createSnapshot: mock(async () => {}),
				openPath: mock(async () => ""),
			}),
		).rejects.toThrow("manifest changed");
	});
});
