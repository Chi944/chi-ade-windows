import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Bring-your-own-key status + management for external model providers.
 *
 * The model-runtimes that proxy through OpenRouter (Kimi, MiniMax, GLM) need an
 * OpenRouter API key. The key itself lives in the main process; the renderer
 * only ever learns whether one is configured — never the value.
 */
export type ProviderKey = "openrouter" | "huggingface";
export interface ProviderKeysHandle {
	/** Whether an OpenRouter key is stored. `undefined` until known. */
	openrouterConfigured: boolean | undefined;
	huggingfaceConfigured: boolean | undefined;
	isLoading: boolean;
	refetch: () => void;
	setKey: (provider: ProviderKey, key: string) => Promise<void>;
	clearKey: (provider: ProviderKey) => Promise<void>;
	saveModelProfile: (
		provider: "huggingface" | "ollama",
		modelId: string,
	) => Promise<void>;
	isSaving: boolean;
	isClearing: boolean;
}

export function useProviderKeys(): ProviderKeysHandle {
	const statusQuery = electronTrpc.settings.providerKeys.status.useQuery();
	const setMutation = electronTrpc.settings.providerKeys.set.useMutation({
		onSuccess: () => statusQuery.refetch(),
	});
	const clearMutation = electronTrpc.settings.providerKeys.clear.useMutation({
		onSuccess: () => statusQuery.refetch(),
	});
	const profileMutation =
		electronTrpc.settings.providerKeys.setModelProfile.useMutation();

	return {
		openrouterConfigured: statusQuery.data?.openrouter,
		huggingfaceConfigured: statusQuery.data?.huggingface,
		isLoading: statusQuery.isLoading,
		refetch: () => {
			statusQuery.refetch();
		},
		setKey: async (provider, key) => {
			await setMutation.mutateAsync({ provider, key });
		},
		clearKey: async (provider) => {
			await clearMutation.mutateAsync({ provider });
		},
		saveModelProfile: async (provider, modelId) => {
			await profileMutation.mutateAsync({ provider, modelId });
		},
		isSaving: setMutation.isPending,
		isClearing: clearMutation.isPending,
	};
}
