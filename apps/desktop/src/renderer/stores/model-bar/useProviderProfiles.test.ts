import { describe, expect, it } from "bun:test";
import {
	addProviderModelId,
	MAX_PROVIDER_MODELS,
	migrateProviderProfilesState,
	normalizeProviderModelProfile,
	removeProviderModelId,
	selectProviderModelId,
} from "./useProviderProfiles";

describe("provider model profiles", () => {
	it("migrates the legacy single-model shape", () => {
		const migrated = migrateProviderProfilesState({
			profiles: {
				huggingface: { modelId: "Qwen/Qwen3-Coder" },
				ollama: { modelId: "qwen3-coder:30b" },
			},
		});

		expect(migrated.profiles?.huggingface).toEqual({
			modelIds: ["Qwen/Qwen3-Coder"],
			selectedModelId: "Qwen/Qwen3-Coder",
		});
		expect(migrated.profiles?.ollama).toEqual({
			modelIds: ["qwen3-coder:30b"],
			selectedModelId: "qwen3-coder:30b",
		});
	});

	it("adds, selects, and exactly deduplicates model IDs", () => {
		let profile = normalizeProviderModelProfile(null);
		profile = addProviderModelId(profile, " Qwen/Qwen3-Coder ");
		profile = addProviderModelId(profile, "Qwen/Qwen3-Coder");
		profile = addProviderModelId(profile, "qwen/Qwen3-Coder");

		expect(profile).toEqual({
			modelIds: ["Qwen/Qwen3-Coder", "qwen/Qwen3-Coder"],
			selectedModelId: "qwen/Qwen3-Coder",
		});
		expect(selectProviderModelId(profile, "Qwen/Qwen3-Coder")).toEqual({
			...profile,
			selectedModelId: "Qwen/Qwen3-Coder",
		});
	});

	it("rejects unsafe IDs and caps each provider list", () => {
		let profile = normalizeProviderModelProfile(null);
		profile = addProviderModelId(profile, "model && calc.exe");
		expect(profile.modelIds).toEqual([]);

		for (let index = 0; index <= MAX_PROVIDER_MODELS; index++) {
			profile = addProviderModelId(profile, `model-${index}`);
		}
		expect(profile.modelIds).toHaveLength(MAX_PROVIDER_MODELS);
		expect(profile.modelIds).not.toContain(`model-${MAX_PROVIDER_MODELS}`);
	});

	it("selects a safe fallback when the active model is removed", () => {
		const profile = {
			modelIds: ["first", "second"],
			selectedModelId: "second",
		};

		expect(removeProviderModelId(profile, "second")).toEqual({
			modelIds: ["first"],
			selectedModelId: "first",
		});
	});
});
