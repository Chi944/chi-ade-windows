import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SUBSCRIPTION_PROFILE_PROVIDERS = ["claude", "codex"] as const;
export type SubscriptionProfileProvider =
	(typeof SUBSCRIPTION_PROFILE_PROVIDERS)[number];

export interface SubscriptionProfile {
	id: string;
	provider: SubscriptionProfileProvider;
	label: string;
	createdAt: number;
}

export type SubscriptionProfileEnvironmentResolution =
	| {
			source: "system";
			environment: Record<string, string>;
	  }
	| {
			source: "profile";
			profileId: string;
			environment: Record<string, string>;
	  };

interface SubscriptionProfilesFile {
	version: 1;
	profiles: SubscriptionProfile[];
	selected: Partial<Record<SubscriptionProfileProvider, string>>;
	bindings: Record<
		string,
		{
			provider: SubscriptionProfileProvider;
			profileId: string | null;
			workspaceId?: string;
			createdAt: number;
		}
	>;
}

export type SubscriptionProfilesView = Pick<
	SubscriptionProfilesFile,
	"version" | "profiles" | "selected"
>;

const EMPTY_STATE: SubscriptionProfilesFile = {
	version: 1,
	profiles: [],
	selected: {},
	bindings: {},
};
const PROFILE_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const UNBOUND_HOME_PATTERN = /^unbound-[0-9a-f]{32}$/;
const MAX_BINDINGS = 5000;
let accountsRootOverride: string | null = null;
let userDataPathResolver: (() => string) | null = null;

export function setSubscriptionProfilesUserDataPathResolver(
	resolver: (() => string) | null,
): void {
	userDataPathResolver = resolver;
}

/** @internal Test seam; never exposed through renderer RPC. */
export function setSubscriptionProfilesRootForTests(root: string | null): void {
	accountsRootOverride = root;
}

function accountsRoot(): string {
	if (accountsRootOverride) return accountsRootOverride;
	if (!userDataPathResolver) {
		throw new Error("Subscription profile storage is not initialized");
	}
	return join(userDataPathResolver(), "provider-accounts");
}

function metadataPath(): string {
	return join(accountsRoot(), "profiles.json");
}

function ensureAccountsRoot(): string {
	const root = resolve(accountsRoot());
	if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
	if (lstatSync(root).isSymbolicLink()) {
		throw new Error("Refusing to use a linked account storage directory");
	}
	return realpathSync(root);
}

function ensureProviderRoot(provider: SubscriptionProfileProvider): string {
	const root = ensureAccountsRoot();
	const providerRoot = join(root, provider);
	if (!existsSync(providerRoot)) mkdirSync(providerRoot, { mode: 0o700 });
	if (lstatSync(providerRoot).isSymbolicLink()) {
		throw new Error("Refusing to use a linked provider account directory");
	}
	const realProviderRoot = realpathSync(providerRoot);
	const providerRelative = relative(root, realProviderRoot);
	if (
		providerRelative !== provider ||
		providerRelative.startsWith(`..${sep}`) ||
		isAbsolute(providerRelative)
	) {
		throw new Error("Provider account path is outside ADE's data directory");
	}
	return realProviderRoot;
}

function ensureProfileHome(
	profile: Pick<SubscriptionProfile, "id" | "provider">,
): string {
	const providerRoot = ensureProviderRoot(profile.provider);
	const profileHome = join(providerRoot, profile.id);
	if (!existsSync(profileHome)) mkdirSync(profileHome, { mode: 0o700 });
	if (lstatSync(profileHome).isSymbolicLink()) {
		throw new Error("Refusing to use a linked account profile directory");
	}
	const realProfileHome = realpathSync(profileHome);
	const profileRelative = relative(providerRoot, realProfileHome);
	if (
		profileRelative !== profile.id ||
		profileRelative.startsWith(`..${sep}`) ||
		isAbsolute(profileRelative)
	) {
		throw new Error("Account profile path is outside ADE's data directory");
	}
	return realProfileHome;
}

function unboundHomeName(scope: string): string {
	const suffix = createHash("sha256").update(scope).digest("hex").slice(0, 32);
	return `unbound-${suffix}`;
}

function removeUnboundHomeDirectory(
	providerRoot: string,
	directoryName: string,
): boolean {
	if (!UNBOUND_HOME_PATTERN.test(directoryName)) {
		throw new Error("Invalid unbound account directory");
	}
	const target = join(providerRoot, directoryName);
	if (!existsSync(target)) return false;

	const targetStat = lstatSync(target);
	if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
		// Removing a link or file never traverses into its target.
		rmSync(target, { force: true });
		return true;
	}

	const realTarget = realpathSync(target);
	const targetRelative = relative(providerRoot, realTarget);
	if (
		targetRelative !== directoryName ||
		targetRelative.startsWith(`..${sep}`) ||
		isAbsolute(targetRelative)
	) {
		throw new Error("Unbound account path is outside ADE's data directory");
	}

	const quarantinePath = join(
		providerRoot,
		`.removing-${directoryName}-${randomUUID()}`,
	);
	renameSync(target, quarantinePath);
	try {
		rmSync(quarantinePath, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	} catch (error) {
		if (existsSync(quarantinePath)) renameSync(quarantinePath, target);
		throw error;
	}
	return true;
}

function removeUnboundHomeDirectoryBestEffort(
	providerRoot: string,
	directoryName: string,
): boolean {
	try {
		return removeUnboundHomeDirectory(providerRoot, directoryName);
	} catch (error) {
		console.warn(
			"[subscription-profiles] Could not prune an unbound account home:",
			error,
		);
		return false;
	}
}

function removeUnboundHomeBestEffort(
	provider: SubscriptionProfileProvider,
	scope: string,
): boolean {
	try {
		const providerRoot = ensureProviderRoot(provider);
		return removeUnboundHomeDirectoryBestEffort(
			providerRoot,
			unboundHomeName(scope),
		);
	} catch (error) {
		console.warn(
			"[subscription-profiles] Could not resolve an unbound account home:",
			error,
		);
		return false;
	}
}

function environmentForHome(
	provider: SubscriptionProfileProvider,
	home: string,
): Record<string, string> {
	return provider === "codex"
		? { CODEX_HOME: home }
		: { CLAUDE_CONFIG_DIR: home };
}

function isProvider(value: unknown): value is SubscriptionProfileProvider {
	return (
		typeof value === "string" &&
		SUBSCRIPTION_PROFILE_PROVIDERS.includes(
			value as SubscriptionProfileProvider,
		)
	);
}

function readState(): SubscriptionProfilesFile {
	let raw: string;
	try {
		raw = readFileSync(metadataPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...EMPTY_STATE, profiles: [], selected: {}, bindings: {} };
		}
		throw new Error("Could not read ADE account profile metadata", {
			cause: error,
		});
	}

	let value: Record<string, unknown>;
	try {
		value = JSON.parse(raw) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			"ADE account profile metadata is damaged; profiles were not changed",
			{ cause: error },
		);
	}
	if (value.version !== 1 || !Array.isArray(value.profiles)) {
		throw new Error("ADE account profile metadata has an unsupported format");
	}

	const profiles = value.profiles.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(
				"ADE account profile metadata contains an invalid profile",
			);
		}
		const record = entry as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			!PROFILE_ID_PATTERN.test(record.id) ||
			!isProvider(record.provider) ||
			typeof record.label !== "string" ||
			typeof record.createdAt !== "number" ||
			!Number.isFinite(record.createdAt)
		) {
			throw new Error(
				"ADE account profile metadata contains an invalid profile",
			);
		}
		return {
			id: record.id,
			provider: record.provider,
			label: record.label.slice(0, 80),
			createdAt: record.createdAt,
		} satisfies SubscriptionProfile;
	});
	if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
		throw new Error("ADE account profile metadata contains duplicate profiles");
	}

	const selectedRecord =
		value.selected && typeof value.selected === "object"
			? (value.selected as Record<string, unknown>)
			: {};
	const selected: SubscriptionProfilesFile["selected"] = {};
	for (const provider of SUBSCRIPTION_PROFILE_PROVIDERS) {
		const id = selectedRecord[provider];
		if (id === undefined) continue;
		if (
			typeof id !== "string" ||
			!profiles.some(
				(profile) => profile.id === id && profile.provider === provider,
			)
		) {
			throw new Error("ADE account profile selection is invalid");
		}
		selected[provider] = id;
	}
	const rawBindings =
		value.bindings &&
		typeof value.bindings === "object" &&
		!Array.isArray(value.bindings)
			? (value.bindings as Record<string, unknown>)
			: {};
	const bindings: SubscriptionProfilesFile["bindings"] = {};
	const bindingEntries = Object.entries(rawBindings);
	if (bindingEntries.length > MAX_BINDINGS) {
		throw new Error("ADE account profile metadata contains too many bindings");
	}
	for (const [paneId, rawBinding] of bindingEntries) {
		if (
			!paneId ||
			paneId.length > 200 ||
			!rawBinding ||
			typeof rawBinding !== "object"
		) {
			throw new Error(
				"ADE account profile metadata contains an invalid binding",
			);
		}
		const binding = rawBinding as Record<string, unknown>;
		if (
			!isProvider(binding.provider) ||
			(binding.profileId !== null && typeof binding.profileId !== "string") ||
			(binding.workspaceId !== undefined &&
				(typeof binding.workspaceId !== "string" ||
					!binding.workspaceId ||
					binding.workspaceId.length > 200)) ||
			typeof binding.createdAt !== "number" ||
			!Number.isFinite(binding.createdAt)
		) {
			throw new Error(
				"ADE account profile metadata contains an invalid binding",
			);
		}
		if (
			typeof binding.profileId === "string" &&
			!profiles.some(
				(profile) =>
					profile.id === binding.profileId &&
					profile.provider === binding.provider,
			)
		) {
			throw new Error(
				"ADE account profile binding references a missing profile",
			);
		}
		bindings[paneId] = {
			provider: binding.provider,
			profileId:
				typeof binding.profileId === "string" ? binding.profileId : null,
			...(typeof binding.workspaceId === "string"
				? { workspaceId: binding.workspaceId }
				: {}),
			createdAt: binding.createdAt,
		};
	}
	return { version: 1, profiles, selected, bindings };
}

function writeState(state: SubscriptionProfilesFile): void {
	const root = ensureAccountsRoot();
	const temporaryPath = join(
		root,
		`.profiles-${process.pid}-${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, metadataPath());
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

export function listSubscriptionProfiles(): SubscriptionProfilesView {
	const { version, profiles, selected } = readState();
	return { version, profiles, selected };
}

export function createSubscriptionProfile(
	provider: SubscriptionProfileProvider,
	label: string,
): SubscriptionProfile {
	const trimmedLabel = label.trim();
	if (!trimmedLabel) throw new Error("Account label is required");
	const state = readState();
	const profile: SubscriptionProfile = {
		id: randomUUID(),
		provider,
		label: trimmedLabel.slice(0, 80),
		createdAt: Date.now(),
	};
	const providerRoot = ensureProviderRoot(provider);
	const profileHome = join(providerRoot, profile.id);
	mkdirSync(profileHome, { mode: 0o700 });
	try {
		state.profiles.push(profile);
		state.selected[provider] = profile.id;
		writeState(state);
	} catch (error) {
		rmSync(profileHome, { recursive: true, force: true, maxRetries: 3 });
		throw error;
	}
	return profile;
}

export function selectSubscriptionProfile(
	provider: SubscriptionProfileProvider,
	id: string | null,
): void {
	const state = readState();
	if (id === null) {
		delete state.selected[provider];
		writeState(state);
		return;
	}
	if (
		!state.profiles.some(
			(profile) => profile.id === id && profile.provider === provider,
		)
	) {
		throw new Error("Account profile not found");
	}
	state.selected[provider] = id;
	writeState(state);
}

export function removeSubscriptionProfile(
	provider: SubscriptionProfileProvider,
	id: string,
): void {
	const originalState = readState();
	const profile = originalState.profiles.find(
		(item) => item.id === id && item.provider === provider,
	);
	if (!profile) throw new Error("Account profile not found");
	const nextState: SubscriptionProfilesFile = {
		version: 1,
		profiles: originalState.profiles.filter((item) => item.id !== id),
		selected: { ...originalState.selected },
		bindings: Object.fromEntries(
			Object.entries(originalState.bindings).filter(
				([, binding]) => binding.profileId !== id,
			),
		),
	};
	if (nextState.selected[provider] === id) {
		const fallback = nextState.profiles.find(
			(item) => item.provider === provider,
		);
		if (fallback) nextState.selected[provider] = fallback.id;
		else delete nextState.selected[provider];
	}

	const root = ensureAccountsRoot();
	const target = resolve(getSubscriptionProfileHome(profile));
	const targetRelative = relative(root, target);
	if (
		targetRelative.startsWith(`..${sep}`) ||
		targetRelative === ".." ||
		isAbsolute(targetRelative)
	) {
		throw new Error("Account profile path is outside ADE's data directory");
	}

	let quarantinePath: string | null = null;
	if (existsSync(target)) {
		if (lstatSync(target).isSymbolicLink()) {
			throw new Error("Refusing to remove a linked account profile directory");
		}
		const realRoot = realpathSync(root);
		const realTarget = realpathSync(target);
		const realRelative = relative(realRoot, realTarget);
		if (
			realRelative.startsWith(`..${sep}`) ||
			realRelative === ".." ||
			isAbsolute(realRelative)
		) {
			throw new Error("Account profile path is outside ADE's data directory");
		}
		quarantinePath = join(root, `.removing-${profile.id}-${randomUUID()}`);
		renameSync(target, quarantinePath);
	}

	try {
		writeState(nextState);
		if (quarantinePath) {
			rmSync(quarantinePath, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 100,
			});
		}
	} catch (error) {
		try {
			writeState(originalState);
			if (quarantinePath && existsSync(quarantinePath)) {
				renameSync(quarantinePath, target);
			}
		} catch (rollbackError) {
			console.error("[subscription-profiles] Rollback failed:", rollbackError);
		}
		throw error;
	}
}

export function getSelectedSubscriptionProfile(
	provider: SubscriptionProfileProvider,
): SubscriptionProfile | null {
	const state = readState();
	const id = state.selected[provider];
	return (
		state.profiles.find(
			(profile) => profile.id === id && profile.provider === provider,
		) ?? null
	);
}

export function getSubscriptionProfileHome(
	profile: Pick<SubscriptionProfile, "id" | "provider">,
): string {
	if (!PROFILE_ID_PATTERN.test(profile.id) || !isProvider(profile.provider)) {
		throw new Error("Invalid account profile");
	}
	return join(accountsRoot(), profile.provider, profile.id);
}

export function getSubscriptionProfileEnvironment(
	provider: SubscriptionProfileProvider,
): SubscriptionProfileEnvironmentResolution {
	const profile = getSelectedSubscriptionProfile(provider);
	if (!profile) return { source: "system", environment: {} };
	return {
		source: "profile",
		profileId: profile.id,
		environment: environmentForHome(provider, ensureProfileHome(profile)),
	};
}

export function getSubscriptionProfileEnvironmentForPane(
	provider: SubscriptionProfileProvider,
	paneId: string,
	workspaceId?: string,
): SubscriptionProfileEnvironmentResolution {
	if (!paneId || paneId.length > 200)
		throw new Error("Invalid terminal pane ID");
	if (workspaceId !== undefined && (!workspaceId || workspaceId.length > 200)) {
		throw new Error("Invalid workspace ID");
	}
	const state = readState();
	let binding = state.bindings[paneId];
	if (
		binding &&
		binding.provider === provider &&
		workspaceId &&
		!binding.workspaceId
	) {
		binding = { ...binding, workspaceId };
		state.bindings[paneId] = binding;
		writeState(state);
	} else if (
		!binding ||
		binding.provider !== provider ||
		Boolean(
			workspaceId && binding.workspaceId && binding.workspaceId !== workspaceId,
		)
	) {
		const replacedBinding = binding;
		if (
			!replacedBinding &&
			Object.keys(state.bindings).length >= MAX_BINDINGS
		) {
			throw new Error(
				"Too many remembered terminal sessions; close an old pane or tab before starting another",
			);
		}
		binding = {
			provider,
			profileId: state.selected[provider] ?? null,
			...(workspaceId ? { workspaceId } : {}),
			createdAt: Date.now(),
		};
		state.bindings[paneId] = binding;
		writeState(state);
		if (replacedBinding && !replacedBinding.profileId) {
			removeUnboundHomeBestEffort(replacedBinding.provider, `pane:${paneId}`);
		}
	}
	if (!binding.profileId) {
		return { source: "system", environment: {} };
	}
	const profile = state.profiles.find(
		(item) => item.id === binding.profileId && item.provider === provider,
	);
	if (!profile) throw new Error("Bound account profile not found");
	return {
		source: "profile",
		profileId: profile.id,
		environment: environmentForHome(provider, ensureProfileHome(profile)),
	};
}

/**
 * Forgets a permanently closed terminal pane. Reopenable tabs deliberately do
 * not call this until their bounded undo entry is evicted.
 */
export function releaseSubscriptionProfilePane(paneId: string): boolean {
	if (!paneId || paneId.length > 200) {
		throw new Error("Invalid terminal pane ID");
	}
	const state = readState();
	const binding = state.bindings[paneId];
	if (!binding) return false;
	delete state.bindings[paneId];
	writeState(state);
	if (!binding.profileId) {
		removeUnboundHomeBestEffort(binding.provider, `pane:${paneId}`);
	}
	return true;
}

/** Releases every remembered pane belonging to a permanently removed workspace. */
export function releaseSubscriptionProfileWorkspace(
	workspaceId: string,
): number {
	if (!workspaceId || workspaceId.length > 200) {
		throw new Error("Invalid workspace ID");
	}
	const state = readState();
	const matches = Object.entries(state.bindings).filter(
		([, binding]) => binding.workspaceId === workspaceId,
	);
	if (matches.length === 0) return 0;
	for (const [paneId] of matches) delete state.bindings[paneId];
	writeState(state);
	for (const [paneId, binding] of matches) {
		if (!binding.profileId) {
			removeUnboundHomeBestEffort(binding.provider, `pane:${paneId}`);
		}
	}
	return matches.length;
}

/**
 * Removes legacy profileless CLI homes that no longer have a pane binding.
 * System accounts now use each CLI's native home, but old cache/history remains
 * bounded while the former status-only home is retained conservatively.
 */
export function pruneOrphanedSubscriptionHomes(): number {
	// A missing metadata file may indicate recovery/data loss, not a clean first
	// run. Never infer that existing homes are orphaned without a trusted index.
	if (!existsSync(metadataPath())) return 0;
	const state = readState();
	const allowedByProvider = new Map<SubscriptionProfileProvider, Set<string>>(
		SUBSCRIPTION_PROFILE_PROVIDERS.map((provider) => [
			provider,
			new Set([unboundHomeName("no-selected-profile")]),
		]),
	);
	for (const [paneId, binding] of Object.entries(state.bindings)) {
		if (!binding.profileId) {
			allowedByProvider
				.get(binding.provider)
				?.add(unboundHomeName(`pane:${paneId}`));
		}
	}

	let removed = 0;
	const root = ensureAccountsRoot();
	for (const provider of SUBSCRIPTION_PROFILE_PROVIDERS) {
		const providerPath = join(root, provider);
		if (!existsSync(providerPath)) continue;
		const providerRoot = ensureProviderRoot(provider);
		const allowed = allowedByProvider.get(provider);
		for (const entry of readdirSync(providerRoot, { withFileTypes: true })) {
			if (
				UNBOUND_HOME_PATTERN.test(entry.name) &&
				!allowed?.has(entry.name) &&
				removeUnboundHomeDirectoryBestEffort(providerRoot, entry.name)
			) {
				removed += 1;
			}
		}
	}
	return removed;
}
