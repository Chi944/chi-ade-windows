import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";
import { APP_STATE_PATH } from "../app-environment";
import { getAppStateRevision, getDeviceId } from ".";
import type { AppState } from "./schemas";
import { parseAppStateJson } from "./validation";

const DEBOUNCE_MS = 250;
const STABILITY_MS = 500;
const STABILITY_POLL_MS = 100;
const DEFAULT_EVENT_CACHE_CAPACITY = 32;
const DEFAULT_EVENT_CACHE_TTL_MS = 5 * 60_000;

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.flatMap((key) => {
			const entry = record[key];
			return entry === undefined
				? []
				: [`${JSON.stringify(key)}:${canonicalJson(entry)}`];
		})
		.join(",")}}`;
}

export interface PeerAppStateEventMetadata {
	eventId: string;
	baseRevision: number;
	writerDeviceId: string;
	lastWrittenAt: number;
	canonicalWorkspaceIds: string[];
}

export interface CachedPeerAppStateEvent extends PeerAppStateEventMetadata {
	state: AppState;
}

interface CachedEntry {
	metadata: PeerAppStateEventMetadata;
	raw: string;
	expiresAt: number;
	snapshotIdentity?: string;
}

export class ValidatedPeerEventCache {
	private readonly entries = new Map<string, CachedEntry>();
	private readonly eventIdsBySnapshotIdentity = new Map<string, string>();
	private readonly localDeviceId: string | (() => string);
	private readonly capacity: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: {
		localDeviceId: string | (() => string);
		capacity?: number;
		ttlMs?: number;
		now?: () => number;
	}) {
		this.localDeviceId = options.localDeviceId;
		this.capacity = Math.max(
			1,
			options.capacity ?? DEFAULT_EVENT_CACHE_CAPACITY,
		);
		this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_EVENT_CACHE_TTL_MS);
		this.now = options.now ?? Date.now;
	}

	private getLocalDeviceId(): string {
		return typeof this.localDeviceId === "function"
			? this.localDeviceId()
			: this.localDeviceId;
	}

	private purgeExpired(): void {
		const now = this.now();
		for (const [eventId, entry] of this.entries) {
			if (entry.expiresAt <= now) this.deleteEntry(eventId);
		}
	}

	private deleteEntry(eventId: string): void {
		const entry = this.entries.get(eventId);
		if (
			entry?.snapshotIdentity &&
			this.eventIdsBySnapshotIdentity.get(entry.snapshotIdentity) === eventId
		) {
			this.eventIdsBySnapshotIdentity.delete(entry.snapshotIdentity);
		}
		this.entries.delete(eventId);
	}

	private store(
		eventId: string,
		state: AppState,
		baseRevision: number,
		snapshotIdentity?: string,
	): PeerAppStateEventMetadata {
		const normalized = parseAppStateJson(JSON.stringify(state), {
			deviceId: this.getLocalDeviceId(),
		});
		const metadata: PeerAppStateEventMetadata = {
			eventId,
			baseRevision,
			writerDeviceId: normalized.sync.deviceId,
			lastWrittenAt: normalized.sync.lastWrittenAt,
			canonicalWorkspaceIds: [
				...new Set([
					...Object.keys(normalized.sync.perWorkspaceWrittenAt),
					...Object.keys(normalized.sync.workspaceTombstones),
				]),
			].sort(),
		};
		this.deleteEntry(eventId);
		this.entries.set(eventId, {
			metadata,
			raw: JSON.stringify(normalized),
			expiresAt: this.now() + this.ttlMs,
			...(snapshotIdentity ? { snapshotIdentity } : {}),
		});
		if (snapshotIdentity) {
			this.eventIdsBySnapshotIdentity.set(snapshotIdentity, eventId);
		}
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (typeof oldest !== "string") break;
			this.deleteEntry(oldest);
		}
		return { ...metadata };
	}

	put(
		eventId: string,
		state: AppState,
		baseRevision: number,
	): PeerAppStateEventMetadata {
		this.purgeExpired();
		return this.store(eventId, state, baseRevision);
	}

	putUniqueSnapshot(
		snapshotIdentity: string,
		eventIdFactory: () => string,
		state: AppState,
		baseRevision: number,
	): { inserted: boolean; metadata: PeerAppStateEventMetadata } {
		this.purgeExpired();
		const existingEventId =
			this.eventIdsBySnapshotIdentity.get(snapshotIdentity);
		if (existingEventId) {
			const existing = this.entries.get(existingEventId);
			if (existing) {
				return { inserted: false, metadata: { ...existing.metadata } };
			}
			this.eventIdsBySnapshotIdentity.delete(snapshotIdentity);
		}
		return {
			inserted: true,
			metadata: this.store(
				eventIdFactory(),
				state,
				baseRevision,
				snapshotIdentity,
			),
		};
	}

	listMetadata(): PeerAppStateEventMetadata[] {
		this.purgeExpired();
		return [...this.entries.values()].map(({ metadata }) => ({
			...metadata,
			canonicalWorkspaceIds: [...metadata.canonicalWorkspaceIds],
		}));
	}

	get(eventId: string): CachedPeerAppStateEvent | null {
		this.purgeExpired();
		const entry = this.entries.get(eventId);
		if (!entry) return null;
		try {
			return {
				...entry.metadata,
				canonicalWorkspaceIds: [...entry.metadata.canonicalWorkspaceIds],
				state: parseAppStateJson(entry.raw, {
					deviceId: this.getLocalDeviceId(),
				}),
			};
		} catch {
			this.deleteEntry(eventId);
			return null;
		}
	}

	get size(): number {
		this.purgeExpired();
		return this.entries.size;
	}
}

export function parsePeerAppStateJson(
	raw: string,
	localDeviceId: string,
): AppState {
	return parseAppStateJson(raw, { deviceId: localDeviceId });
}

type DirectoryEventListener = (
	eventType: string,
	filename: string | Buffer | null,
) => void;

export interface AppStateWatcherDependencies {
	targetPath: string;
	localDeviceId: () => string | null;
	getBaseRevision: () => number;
	readCandidateFile?: (path: string) => Promise<string | null>;
	readCurrentFile?: () => Promise<string | null>;
	readStableFile: () => Promise<string | null>;
	watchDirectory: (
		path: string,
		listener: DirectoryEventListener,
	) => { close: () => void };
	eventCache: ValidatedPeerEventCache;
	eventIdFactory?: () => string;
	debounceMs?: number;
}

export class AppStateWatcherController extends EventEmitter {
	private readonly dependencies: AppStateWatcherDependencies;
	private started = false;
	private watcher: { close: () => void } | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending: Promise<void> = Promise.resolve();

	declare emit: (
		event: "peer-update",
		payload: PeerAppStateEventMetadata,
	) => boolean;
	declare on: (
		event: "peer-update",
		listener: (payload: PeerAppStateEventMetadata) => void,
	) => this;
	declare off: (
		event: "peer-update",
		listener: (payload: PeerAppStateEventMetadata) => void,
	) => this;

	constructor(dependencies: AppStateWatcherDependencies) {
		super();
		this.dependencies = dependencies;
	}

	private queueRead(
		read: () => Promise<string | null>,
		options: { failClosed?: boolean } = {},
	): Promise<void> {
		const captured = read().then(
			(raw) => ({ status: "captured" as const, raw }),
			(error: unknown) => ({ status: "failed" as const, error }),
		);
		const operation = this.pending.then(async () => {
			const result = await captured;
			if (result.status === "failed") throw result.error;
			if (result.raw === null) {
				if (options.failClosed) {
					throw new Error("App-state capture candidate was unavailable.");
				}
				return;
			}
			this.ingestRaw(result.raw, options.failClosed ?? false);
		});
		this.pending = operation.catch(() => undefined);
		return operation;
	}

	private enqueueStableIngest(): void {
		void this.queueRead(this.dependencies.readStableFile).catch(() => {
			console.warn("[app-state-watcher] Peer snapshot ingestion failed.");
		});
	}

	private scheduleIngest(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.enqueueStableIngest();
		}, this.dependencies.debounceMs ?? DEBOUNCE_MS);
	}

	private ingestRaw(raw: string, failClosed: boolean): void {
		const localDeviceId = this.dependencies.localDeviceId();
		if (!localDeviceId) {
			if (failClosed) {
				throw new Error("Local device identity is unavailable during capture.");
			}
			return;
		}
		let parsed: AppState;
		try {
			parsed = parsePeerAppStateJson(raw, localDeviceId);
		} catch {
			if (failClosed) {
				throw new Error(
					"App-state capture candidate was not a valid snapshot.",
				);
			}
			console.warn(
				"[app-state-watcher] Ignored an invalid peer app-state snapshot.",
			);
			return;
		}
		if (!parsed.sync.deviceId || parsed.sync.deviceId === localDeviceId) return;
		parsed.tabsState = sanitizeSubscriptionProfilesForPersistence({
			state: parsed.tabsState,
		});
		const snapshotIdentity = createHash("sha256")
			.update(canonicalJson(parsed))
			.digest("hex");
		const { inserted, metadata } =
			this.dependencies.eventCache.putUniqueSnapshot(
				snapshotIdentity,
				() => this.dependencies.eventIdFactory?.() ?? randomUUID(),
				parsed,
				this.dependencies.getBaseRevision(),
			);
		if (!inserted) return;
		this.emit("peer-update", metadata);
	}

	async captureBeforeOverwrite(candidatePath?: string): Promise<void> {
		const read = candidatePath
			? () => {
					if (!this.dependencies.readCandidateFile) {
						throw new Error("App-state candidate reader is unavailable.");
					}
					return this.dependencies.readCandidateFile(candidatePath);
				}
			: (this.dependencies.readCurrentFile ?? this.dependencies.readStableFile);
		const raw = await read();
		if (raw === null) {
			throw new Error("App-state capture candidate was unavailable.");
		}
		this.ingestRaw(raw, true);
	}

	private captureCurrentFileBestEffort(): void {
		void this.queueRead(
			this.dependencies.readCurrentFile ?? this.dependencies.readStableFile,
		).catch(() => {
			console.warn("[app-state-watcher] Peer snapshot capture failed.");
		});
	}

	private async ingestStartupFile(): Promise<void> {
		await this.queueRead(this.dependencies.readStableFile);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const targetName = basename(this.dependencies.targetPath);
		this.watcher = this.dependencies.watchDirectory(
			dirname(this.dependencies.targetPath),
			(eventType, filename) => {
				if (eventType !== "change" && eventType !== "rename") return;
				const changedName =
					typeof filename === "string"
						? filename
						: Buffer.isBuffer(filename)
							? filename.toString()
							: null;
				if (changedName !== null && basename(changedName) !== targetName)
					return;
				this.captureCurrentFileBestEffort();
				this.scheduleIngest();
			},
		);
		await this.ingestStartupFile();
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
			this.enqueueStableIngest();
		}
		await this.pending;
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.watcher?.close();
		this.watcher = null;
		this.started = false;
	}
}

async function readStableAppStateFile(): Promise<string | null> {
	let lastSize = -1;
	let lastMtimeMs = -1;
	let stableSince = 0;
	const startedAt = Date.now();
	while (Date.now() - startedAt < STABILITY_MS * 10) {
		try {
			const value = await stat(APP_STATE_PATH);
			if (value.size === lastSize && value.mtimeMs === lastMtimeMs) {
				if (stableSince === 0) stableSince = Date.now();
				if (Date.now() - stableSince >= STABILITY_MS) {
					return await readFile(APP_STATE_PATH, "utf8");
				}
			} else {
				lastSize = value.size;
				lastMtimeMs = value.mtimeMs;
				stableSince = 0;
			}
		} catch {
			// Atomic replacement may temporarily remove the named file.
		}
		await new Promise((resolve) => setTimeout(resolve, STABILITY_POLL_MS));
	}
	console.warn("[app-state-watcher] File never stabilized; skipping read.");
	return null;
}

async function readCurrentAppStateFile(): Promise<string | null> {
	try {
		return await readFile(APP_STATE_PATH, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

async function readCandidateAppStateFile(path: string): Promise<string | null> {
	return await readFile(path, "utf8");
}

function currentDeviceId(): string | null {
	try {
		return getDeviceId();
	} catch {
		return null;
	}
}

export const peerAppStateEventCache = new ValidatedPeerEventCache({
	localDeviceId: () => currentDeviceId() ?? "uninitialized-local-device",
});

export const appStateWatcher = new AppStateWatcherController({
	targetPath: APP_STATE_PATH,
	localDeviceId: currentDeviceId,
	getBaseRevision: getAppStateRevision,
	readCandidateFile: readCandidateAppStateFile,
	readCurrentFile: readCurrentAppStateFile,
	readStableFile: readStableAppStateFile,
	watchDirectory: (path, listener) =>
		watch(path, { persistent: true }, listener),
	eventCache: peerAppStateEventCache,
});

export async function startAppStateWatcher(): Promise<void> {
	try {
		await appStateWatcher.start();
		console.log("[app-state-watcher] Watching app-state parent directory.");
	} catch {
		console.error("[app-state-watcher] Failed to start watcher.");
	}
}
