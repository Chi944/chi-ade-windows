import { settings } from "@superset/local-db";
import { safeStorage } from "electron";
import { localDb } from "./local-db";

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

export const PROVIDER_IDS = ["openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

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

/** Presence-only status for every known provider (safe to return to the renderer). */
export function getProviderKeyStatus(): Record<ProviderId, boolean> {
	const map = readKeyMap();
	return Object.fromEntries(
		PROVIDER_IDS.map((id) => [id, Boolean(map[id])]),
	) as Record<ProviderId, boolean>;
}
