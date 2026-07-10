import type { OpenCodeModelProvider } from "@superset/shared/agent-command";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface ProviderModelProfile {
	modelId: string;
}

interface ProviderProfilesState {
	profiles: Record<OpenCodeModelProvider, ProviderModelProfile>;
	setModelId: (provider: OpenCodeModelProvider, modelId: string) => void;
}

export const useProviderProfiles = create<ProviderProfilesState>()(
	devtools(
		persist(
			(set) => ({
				profiles: {
					huggingface: { modelId: "" },
					ollama: { modelId: "" },
				},
				setModelId: (provider, modelId) =>
					set((state) => ({
						profiles: {
							...state.profiles,
							[provider]: { ...state.profiles[provider], modelId },
						},
					})),
			}),
			{
				name: "provider-model-profiles",
				version: 2,
			},
		),
		{ name: "ProviderProfilesStore" },
	),
);
