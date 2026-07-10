import { settings } from "@superset/local-db";
import {
	isValidOpenCodeModelId,
	OPEN_CODE_MODEL_PROVIDERS,
	type OpenCodeModelProvider,
} from "@superset/shared/agent-command";
import { safeStorage } from "electron";
import { localDb } from "./local-db";

let subscriptionProfileEnvironmentResolver: (
	provider: "claude" | "codex",
	paneId?: string,
	workspaceId?: string,
) => Record<string, string> = () => ({});

export function setSubscriptionProfileEnvironmentResolver(
	resolver:
		| ((
				provider: "claude" | "codex",
				paneId?: string,
				workspaceId?: string,
		  ) => Record<string, string>)
		| null,
): void {
	subscriptionProfileEnvironmentResolver = resolver ?? (() => ({}));
}

/**
 * Local-first, single-user storage for provider API keys.
 *
 * Keys are encrypted with electron's safeStorage (OS keychain-backed) and the
 * resulting blob is persisted, base64-encoded, in the local sqlite settings row
 * (settings.providerApiKeys, keyed by provider id). Plaintext keys never touch
 * disk and are only ever decrypted in the main process — never returned to the
 * renderer. Injected into agent terminals via OPENROUTER_API_KEY (see
 * buildTerminalEnv), so the OpenRouter-routed runtimes (kimi/minimax/glm) work
 * without relying on the user's shell rc.
 */

export const PROVIDER_IDS = ["openrouter", "huggingface"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const MODEL_PROVIDER_IDS = OPEN_CODE_MODEL_PROVIDERS;
export type ModelProviderId = OpenCodeModelProvider;
const MODEL_PROFILE_PREFIX = "model:";

function readKeyMap(): Record<string, string> {
	const row = localDb.select().from(settings).get();
	return (row?.providerApiKeys ?? {}) as Record<string, string>;
}

function writeKeyMap(map: Record<string, string>): void {
	localDb
		.insert(settings)
		.values({ id: 1, providerApiKeys: map })
		.onConflictDoUpdate({
			target: settings.id,
			set: { providerApiKeys: map },
		})
		.run();
}

/** Encrypt and persist a provider key. Throws if the key is blank or storage is unavailable. */
export function setProviderKey(provider: ProviderId, key: string): void {
	const trimmed = key.trim();
	if (!trimmed) {
		throw new Error("Provider API key must not be empty");
	}
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("Secure storage is not available on this system");
	}

	const encrypted = safeStorage.encryptString(trimmed).toString("base64");
	const map = readKeyMap();
	map[provider] = encrypted;
	writeKeyMap(map);
}

/** Remove a stored provider key, if present. */
export function clearProviderKey(provider: ProviderId): void {
	const map = readKeyMap();
	if (provider in map) {
		delete map[provider];
		writeKeyMap(map);
	}
}

/** Whether a key is stored for the provider (does not decrypt). */
export function hasProviderKey(provider: ProviderId): boolean {
	return Boolean(readKeyMap()[provider]);
}

/**
 * Decrypt and return the stored provider key, or null if none is stored or
 * decryption is unavailable/fails. Main-process only — never send this to the renderer.
 */
export function getProviderKey(provider: ProviderId): string | null {
	const blob = readKeyMap()[provider];
	if (!blob) return null;
	if (!safeStorage.isEncryptionAvailable()) return null;

	try {
		return safeStorage.decryptString(Buffer.from(blob, "base64"));
	} catch {
		return null;
	}
}

/** Decryptability status for every known provider (safe to return to renderer). */
export function getProviderKeyStatus(): Record<ProviderId, boolean> {
	return Object.fromEntries(
		PROVIDER_IDS.map((id) => [id, Boolean(getProviderKey(id)?.trim())]),
	) as Record<ProviderId, boolean>;
}

function getStoredValue(id: string): string | null {
	const blob = readKeyMap()[id];
	if (!blob || !safeStorage.isEncryptionAvailable()) return null;
	try {
		return safeStorage.decryptString(Buffer.from(blob, "base64"));
	} catch {
		return null;
	}
}

/** Persist a validated model ID in the existing encrypted provider map. */
export function setProviderModelProfile(
	provider: ModelProviderId,
	modelId: string,
): void {
	const trimmed = modelId.trim();
	if (!isValidOpenCodeModelId(trimmed)) {
		throw new Error("Invalid provider model ID");
	}
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("Secure storage is not available on this system");
	}
	const map = readKeyMap();
	map[`${MODEL_PROFILE_PREFIX}${provider}`] = safeStorage
		.encryptString(trimmed)
		.toString("base64");
	writeKeyMap(map);
}

export function clearProviderModelProfile(provider: ModelProviderId): void {
	const map = readKeyMap();
	const id = `${MODEL_PROFILE_PREFIX}${provider}`;
	if (id in map) {
		delete map[id];
		writeKeyMap(map);
	}
}

function getProviderModelProfiles(): Partial<Record<ModelProviderId, string>> {
	return Object.fromEntries(
		MODEL_PROVIDER_IDS.flatMap((provider) => {
			const value = getStoredValue(`${MODEL_PROFILE_PREFIX}${provider}`);
			return value && isValidOpenCodeModelId(value)
				? ([[provider, value]] as const)
				: [];
		}),
	);
}

/**
 * Main-process-only environment for provider sessions. Secrets are decrypted
 * here and never included in a tRPC response. Ollama needs no credential.
 */
export function getProviderRuntimeEnvironment({
	runtime,
	paneId,
	workspaceId,
}: {
	runtime?: string | null;
	workspaceId: string;
	paneId?: string;
}): Record<string, string> {
	const result: Record<string, string> = {};
	const effectiveRuntime = runtime;
	if (effectiveRuntime === "claude" || effectiveRuntime === "codex") {
		Object.assign(
			result,
			subscriptionProfileEnvironmentResolver(
				effectiveRuntime,
				paneId,
				workspaceId,
			),
		);
	}
	if (
		effectiveRuntime === "kimi" ||
		effectiveRuntime === "minimax" ||
		effectiveRuntime === "glm"
	) {
		const openRouterKey = getProviderKey("openrouter");
		if (openRouterKey) result.OPENROUTER_API_KEY = openRouterKey;
		return result;
	}

	if (effectiveRuntime !== "huggingface" && effectiveRuntime !== "ollama") {
		return result;
	}

	// Read the encrypted profile here as an integrity check. The selected model
	// itself is passed as a validated CLI argument by buildProviderModelCommand.
	getProviderModelProfiles();

	if (effectiveRuntime === "huggingface") {
		const huggingFaceToken = getProviderKey("huggingface");
		if (huggingFaceToken) result.HF_TOKEN = huggingFaceToken;
	}

	return result;
}
