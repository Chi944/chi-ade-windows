import { beforeEach, describe, expect, it, mock } from "bun:test";

// In-memory stand-ins for electron safeStorage and the local sqlite settings row.
// safeStorage is unavailable in a headless test runner, so we mock it; the toggle
// lets us exercise the graceful "encryption unavailable" path too.
let encryptionAvailable = true;
let decryptionFails = false;
let settingsRow: { providerApiKeys?: Record<string, string> } | null = null;

mock.module("electron", () => ({
	safeStorage: {
		isEncryptionAvailable: () => encryptionAvailable,
		// Reversible, deterministic stand-in for OS-backed encryption.
		encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
		decryptString: (buf: Buffer) => {
			if (decryptionFails) throw new Error("damaged ciphertext");
			return buf.toString("utf8").replace(/^enc:/, "");
		},
	},
}));

mock.module("./local-db", () => ({
	localDb: {
		select: () => ({
			from: () => ({ get: () => settingsRow }),
		}),
		insert: () => ({
			values: (values: { providerApiKeys?: Record<string, string> }) => ({
				onConflictDoUpdate: (args: {
					set: { providerApiKeys?: Record<string, string> };
				}) => ({
					run: () => {
						settingsRow = {
							...(settingsRow ?? {}),
							providerApiKeys: args.set.providerApiKeys,
						};
						void values;
					},
				}),
			}),
		}),
	},
}));

const {
	setProviderKey,
	clearProviderKey,
	hasProviderKey,
	getProviderKey,
	getProviderKeyStatus,
	setProviderModelProfile,
	clearProviderModelProfile,
	getProviderRuntimeEnvironment,
	setSubscriptionProfileEnvironmentResolver,
} = await import("./provider-keys");

describe("provider-keys", () => {
	beforeEach(() => {
		encryptionAvailable = true;
		decryptionFails = false;
		settingsRow = null;
		setSubscriptionProfileEnvironmentResolver(null);
		clearProviderModelProfile("huggingface");
		clearProviderModelProfile("ollama");
	});

	it("round-trips a stored key through encryption", () => {
		expect(hasProviderKey("openrouter")).toBe(false);
		expect(getProviderKey("openrouter")).toBeNull();

		setProviderKey("openrouter", "sk-or-test-123");

		expect(hasProviderKey("openrouter")).toBe(true);
		expect(getProviderKey("openrouter")).toBe("sk-or-test-123");
		expect(getProviderKeyStatus()).toEqual({
			openrouter: true,
			huggingface: false,
		});

		// Persisted value must be the encrypted blob, never plaintext.
		expect(settingsRow?.providerApiKeys?.openrouter).not.toContain(
			"sk-or-test-123",
		);
	});

	it("trims surrounding whitespace before storing", () => {
		setProviderKey("openrouter", "  sk-or-trim  ");
		expect(getProviderKey("openrouter")).toBe("sk-or-trim");
	});

	it("rejects a blank key", () => {
		expect(() => setProviderKey("openrouter", "   ")).toThrow();
		expect(hasProviderKey("openrouter")).toBe(false);
	});

	it("clears a stored key", () => {
		setProviderKey("openrouter", "sk-or-clear");
		expect(hasProviderKey("openrouter")).toBe(true);

		clearProviderKey("openrouter");

		expect(hasProviderKey("openrouter")).toBe(false);
		expect(getProviderKey("openrouter")).toBeNull();
		expect(getProviderKeyStatus()).toEqual({
			openrouter: false,
			huggingface: false,
		});
	});

	it("degrades gracefully when secure storage is unavailable", () => {
		encryptionAvailable = false;
		expect(() => setProviderKey("openrouter", "sk-or-x")).toThrow();

		// A previously stored blob cannot be decrypted without safeStorage.
		encryptionAvailable = true;
		setProviderKey("openrouter", "sk-or-y");
		encryptionAvailable = false;
		expect(getProviderKey("openrouter")).toBeNull();
		expect(getProviderKeyStatus().openrouter).toBe(false);
	});

	it("reports damaged ciphertext as not configured", () => {
		setProviderKey("openrouter", "sk-or-damaged");
		decryptionFails = true;
		expect(getProviderKey("openrouter")).toBeNull();
		expect(getProviderKeyStatus().openrouter).toBe(false);
	});

	it("keeps the Hugging Face token encrypted and only exposes it in main-process env", () => {
		setProviderKey("huggingface", "hf_secret_token");
		setProviderModelProfile("huggingface", "Qwen/Qwen3-Coder");

		const runtimeEnv = getProviderRuntimeEnvironment({
			runtime: "huggingface",
			workspaceId: "workspace-hf",
		});
		expect(runtimeEnv.environment.HF_TOKEN).toBe("hf_secret_token");
		expect(runtimeEnv.subscriptionSource).toBeNull();
		expect(settingsRow?.providerApiKeys?.huggingface).not.toContain(
			"hf_secret_token",
		);
		expect(settingsRow?.providerApiKeys?.["model:huggingface"]).not.toContain(
			"Qwen/Qwen3-Coder",
		);
		expect(getProviderKeyStatus()).toEqual({
			openrouter: false,
			huggingface: true,
		});
	});

	it("stores an Ollama profile without injecting unrelated environment", () => {
		setProviderModelProfile("ollama", "qwen3-coder:30b");
		const runtimeEnv = getProviderRuntimeEnvironment({
			runtime: "ollama",
			workspaceId: "workspace-ollama",
		});

		expect(runtimeEnv).toEqual({
			environment: {},
			subscriptionSource: null,
		});
		expect(settingsRow?.providerApiKeys?.["model:ollama"]).not.toContain(
			"qwen3-coder:30b",
		);
	});

	it("clears an encrypted model profile when its final saved model is removed", () => {
		setProviderModelProfile("ollama", "qwen3-coder:30b");
		expect(settingsRow?.providerApiKeys?.["model:ollama"]).toBeTruthy();

		clearProviderModelProfile("ollama");

		expect(settingsRow?.providerApiKeys?.["model:ollama"]).toBeUndefined();
	});

	it("rejects unsafe model IDs before they reach a shell or config", () => {
		expect(() =>
			setProviderModelProfile("ollama", "qwen && calc.exe"),
		).toThrow();
	});

	it("does not expose provider secrets to unrelated terminals", () => {
		setProviderKey("openrouter", "sk-or-secret");
		setProviderKey("huggingface", "hf_secret");
		setProviderModelProfile("huggingface", "Qwen/Qwen3-Coder");

		expect(
			getProviderRuntimeEnvironment({
				runtime: "claude",
				workspaceId: "workspace-claude",
			}),
		).toEqual({ environment: {}, subscriptionSource: "system" });
		expect(
			getProviderRuntimeEnvironment({
				runtime: "kimi",
				workspaceId: "workspace-kimi",
			}),
		).toEqual({
			environment: { OPENROUTER_API_KEY: "sk-or-secret" },
			subscriptionSource: null,
		});
	});

	it("scopes provider secrets to the explicit runtime", () => {
		setProviderKey("huggingface", "hf_secret");
		setProviderModelProfile("huggingface", "Qwen/Qwen3-Coder");

		expect(
			getProviderRuntimeEnvironment({
				runtime: "claude",
				workspaceId: "workspace-claude",
			}),
		).toEqual({ environment: {}, subscriptionSource: "system" });
		expect(
			getProviderRuntimeEnvironment({
				runtime: "huggingface",
				workspaceId: "workspace-claude",
			}),
		).toEqual({
			environment: { HF_TOKEN: "hf_secret" },
			subscriptionSource: null,
		});
	});

	it("reports named subscription profiles explicitly", () => {
		setSubscriptionProfileEnvironmentResolver((provider) => {
			const environment: Record<string, string> =
				provider === "codex"
					? { CODEX_HOME: "C:\\ADE\\codex-profile" }
					: { CLAUDE_CONFIG_DIR: "C:\\ADE\\claude-profile" };
			return {
				source: "profile",
				profileId: "profile-id",
				environment,
			};
		});

		expect(
			getProviderRuntimeEnvironment({
				runtime: "codex",
				workspaceId: "workspace-codex",
			}),
		).toEqual({
			environment: { CODEX_HOME: "C:\\ADE\\codex-profile" },
			subscriptionSource: "profile",
		});
	});
});
