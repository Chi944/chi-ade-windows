import {
	isValidOpenCodeModelId,
	type OpenCodeModelProvider,
} from "@superset/shared/agent-command";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface ProviderModelProfile {
	modelIds: string[];
	selectedModelId: string;
}

export const MAX_PROVIDER_MODELS = 20;

const EMPTY_PROFILE: ProviderModelProfile = {
	modelIds: [],
	selectedModelId: "",
};

function dedupeValidModelIds(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const modelIds: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const modelId = value.trim();
		if (!isValidOpenCodeModelId(modelId) || modelIds.includes(modelId))
			continue;
		modelIds.push(modelId);
		if (modelIds.length === MAX_PROVIDER_MODELS) break;
	}
	return modelIds;
}

export function normalizeProviderModelProfile(
	value: unknown,
): ProviderModelProfile {
	if (!value || typeof value !== "object") return { ...EMPTY_PROFILE };
	const record = value as Record<string, unknown>;
	const legacyModelId =
		typeof record.modelId === "string" ? record.modelId.trim() : "";
	const modelIds = dedupeValidModelIds([
		...(Array.isArray(record.modelIds) ? record.modelIds : []),
		legacyModelId,
	]);
	const requestedSelection =
		typeof record.selectedModelId === "string"
			? record.selectedModelId.trim()
			: legacyModelId;
	return {
		modelIds,
		selectedModelId: modelIds.includes(requestedSelection)
			? requestedSelection
			: (modelIds[0] ?? ""),
	};
}

export function addProviderModelId(
	profile: ProviderModelProfile,
	value: string,
): ProviderModelProfile {
	const modelId = value.trim();
	if (!isValidOpenCodeModelId(modelId)) return profile;
	if (profile.modelIds.includes(modelId)) {
		return { ...profile, selectedModelId: modelId };
	}
	if (profile.modelIds.length >= MAX_PROVIDER_MODELS) return profile;
	return {
		modelIds: [...profile.modelIds, modelId],
		selectedModelId: modelId,
	};
}

export function removeProviderModelId(
	profile: ProviderModelProfile,
	modelId: string,
): ProviderModelProfile {
	const modelIds = profile.modelIds.filter((value) => value !== modelId);
	return {
		modelIds,
		selectedModelId:
			profile.selectedModelId === modelId
				? (modelIds[0] ?? "")
				: profile.selectedModelId,
	};
}

export function selectProviderModelId(
	profile: ProviderModelProfile,
	modelId: string,
): ProviderModelProfile {
	return profile.modelIds.includes(modelId)
		? { ...profile, selectedModelId: modelId }
		: profile;
}

interface PersistedProviderProfilesState {
	profiles?: Partial<Record<OpenCodeModelProvider, unknown>>;
}

export function migrateProviderProfilesState(
	persisted: unknown,
): PersistedProviderProfilesState {
	const state =
		persisted && typeof persisted === "object"
			? (persisted as PersistedProviderProfilesState)
			: {};
	return {
		...state,
		profiles: {
			huggingface: normalizeProviderModelProfile(state.profiles?.huggingface),
			ollama: normalizeProviderModelProfile(state.profiles?.ollama),
		},
	};
}

interface ProviderProfilesState {
	profiles: Record<OpenCodeModelProvider, ProviderModelProfile>;
	addModelId: (provider: OpenCodeModelProvider, modelId: string) => void;
	removeModelId: (provider: OpenCodeModelProvider, modelId: string) => void;
	selectModelId: (provider: OpenCodeModelProvider, modelId: string) => void;
}

export const useProviderProfiles = create<ProviderProfilesState>()(
	devtools(
		persist(
			(set) => ({
				profiles: {
					huggingface: { ...EMPTY_PROFILE },
					ollama: { ...EMPTY_PROFILE },
				},
				addModelId: (provider, modelId) =>
					set((state) => ({
						profiles: {
							...state.profiles,
							[provider]: addProviderModelId(state.profiles[provider], modelId),
						},
					})),
				removeModelId: (provider, modelId) =>
					set((state) => ({
						profiles: {
							...state.profiles,
							[provider]: removeProviderModelId(
								state.profiles[provider],
								modelId,
							),
						},
					})),
				selectModelId: (provider, modelId) =>
					set((state) => ({
						profiles: {
							...state.profiles,
							[provider]: selectProviderModelId(
								state.profiles[provider],
								modelId,
							),
						},
					})),
			}),
			{
				name: "provider-model-profiles",
				version: 3,
				migrate: (persisted) => migrateProviderProfilesState(persisted),
			},
		),
		{ name: "ProviderProfilesStore" },
	),
);
