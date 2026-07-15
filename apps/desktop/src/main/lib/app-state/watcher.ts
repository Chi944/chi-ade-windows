import { randomUUID } from "node:crypto";
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
}

export class ValidatedPeerEventCache {
	private readonly entries = new Map<string, CachedEntry>();
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
			if (entry.expiresAt <= now) this.entries.delete(eventId);
		}
	}

	put(
		eventId: string,
		state: AppState,
		baseRevision: number,
	): PeerAppStateEventMetadata {
		this.purgeExpired();
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
		this.entries.delete(eventId);
		this.entries.set(eventId, {
			metadata,
			raw: JSON.stringify(normalized),
			expiresAt: this.now() + this.ttlMs,
		});
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (typeof oldest !== "string") break;
			this.entries.delete(oldest);
		}
		return { ...metadata };
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
			this.entries.delete(eventId);
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

	private enqueueIngest(): void {
		this.pending = this.pending
			.then(() => this.ingestCurrentFile())
			.catch(() => {
				console.warn("[app-state-watcher] Peer snapshot ingestion failed.");
			});
	}

	private scheduleIngest(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.enqueueIngest();
		}, this.dependencies.debounceMs ?? DEBOUNCE_MS);
	}

	private async ingestCurrentFile(): Promise<void> {
		const localDeviceId = this.dependencies.localDeviceId();
		if (!localDeviceId) return;
		const raw = await this.dependencies.readStableFile();
		if (raw === null) return;
		let parsed: AppState;
		try {
			parsed = parsePeerAppStateJson(raw, localDeviceId);
		} catch {
			console.warn(
				"[app-state-watcher] Ignored an invalid peer app-state snapshot.",
			);
			return;
		}
		if (!parsed.sync.deviceId || parsed.sync.deviceId === localDeviceId) return;
		parsed.tabsState = sanitizeSubscriptionProfilesForPersistence({
			state: parsed.tabsState,
		});
		const metadata = this.dependencies.eventCache.put(
			this.dependencies.eventIdFactory?.() ?? randomUUID(),
			parsed,
			this.dependencies.getBaseRevision(),
		);
		this.emit("peer-update", metadata);
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
				this.scheduleIngest();
			},
		);
		await this.ingestCurrentFile();
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
			this.enqueueIngest();
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
