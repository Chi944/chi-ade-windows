import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Bring-your-own-key status + management for external model providers.
 *
 * The model-runtimes that proxy through OpenRouter (Kimi, MiniMax, GLM) need an
 * OpenRouter API key. The key itself lives in the main process; the renderer
 * only ever learns whether one is configured — never the value.
 */
export type ProviderKey = "openrouter";

export interface ProviderKeysHandle {
	/** Whether an OpenRouter key is stored. `undefined` until known. */
	openrouterConfigured: boolean | undefined;
	isLoading: boolean;
	refetch: () => void;
	setKey: (key: string) => Promise<void>;
	clearKey: () => Promise<void>;
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

	return {
		openrouterConfigured: statusQuery.data?.openrouter,
		isLoading: statusQuery.isLoading,
		refetch: () => {
			statusQuery.refetch();
		},
		setKey: async (key: string) => {
			await setMutation.mutateAsync({ provider: "openrouter", key });
		},
		clearKey: async () => {
			await clearMutation.mutateAsync({ provider: "openrouter" });
		},
		isSaving: setMutation.isPending,
		isClearing: clearMutation.isPending,
	};
}
