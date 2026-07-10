import {
	isValidOpenCodeModelId,
	type OpenCodeModelProvider,
	type SubscriptionProvider,
} from "@superset/shared/agent-command";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProviderKeys } from "renderer/stores/model-bar/useProviderKeys";
import { useProviderProfiles } from "renderer/stores/model-bar/useProviderProfiles";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
const HUGGING_FACE_TOKENS_URL = "https://huggingface.co/settings/tokens";

export type ProviderKeyDialogMode = "launch" | "manage";
export type ProviderHubProvider = "openrouter" | "huggingface" | "ollama";

interface ProviderKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: ProviderKeyDialogMode;
	initialProvider?: ProviderHubProvider;
	modelLabel?: string;
	onLaunchOpenRouter?: () => Promise<void> | void;
	onLaunchModel?: (input: {
		provider: OpenCodeModelProvider;
		modelId: string;
	}) => Promise<void> | void;
	onConnectSubscription?: (provider: SubscriptionProvider) => void;
}

/**
 * Provider Hub for subscription-owned CLIs and bring-your-own model endpoints.
 * API tokens are write-only from the renderer; queries return presence only.
 */
export function ProviderKeyDialog({
	open,
	onOpenChange,
	mode,
	initialProvider,
	modelLabel,
	onLaunchOpenRouter,
	onLaunchModel,
	onConnectSubscription,
}: ProviderKeyDialogProps) {
	const {
		openrouterConfigured,
		huggingfaceConfigured,
		setKey,
		clearKey,
		saveModelProfile,
		isSaving,
		isClearing,
	} = useProviderKeys();
	const profiles = useProviderProfiles((state) => state.profiles);
	const setModelId = useProviderProfiles((state) => state.setModelId);
	const connectionStatus =
		electronTrpc.settings.subscriptionConnections.status.useQuery(undefined, {
			enabled: open,
		});
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const [openRouterKey, setOpenRouterKey] = useState("");
	const [huggingFaceToken, setHuggingFaceToken] = useState("");
	const [modelDrafts, setModelDrafts] = useState<
		Record<OpenCodeModelProvider, string>
	>({ huggingface: "", ollama: "" });
	const [busyProvider, setBusyProvider] = useState<ProviderHubProvider | null>(
		null,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: clear secrets on every open
	useEffect(() => {
		if (!open) return;
		setOpenRouterKey("");
		setHuggingFaceToken("");
		setModelDrafts({
			huggingface: profiles.huggingface.modelId,
			ollama: profiles.ollama.modelId,
		});
		void connectionStatus.refetch();
	}, [open]);

	const isLaunch = mode === "launch";
	const openExternal = (url: string) => openUrl.mutate(url);

	const saveOpenRouter = async () => {
		const nextKey = openRouterKey.trim();
		if (!nextKey) return;
		setBusyProvider("openrouter");
		try {
			if (nextKey) await setKey("openrouter", nextKey);
			setOpenRouterKey("");
			if (isLaunch && initialProvider === "openrouter") {
				onOpenChange(false);
				await onLaunchOpenRouter?.();
			} else {
				toast.success("OpenRouter key saved");
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save the key",
			);
		} finally {
			setBusyProvider(null);
		}
	};

	const removeKey = async (provider: "openrouter" | "huggingface") => {
		try {
			await clearKey(provider);
			toast.success(
				provider === "openrouter"
					? "OpenRouter key removed"
					: "Hugging Face token removed",
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not remove the key",
			);
		}
	};

	const saveModelProvider = async (
		provider: OpenCodeModelProvider,
		launch: boolean,
	) => {
		const modelId = modelDrafts[provider].trim();
		if (!isValidOpenCodeModelId(modelId)) return;
		if (
			provider === "huggingface" &&
			!huggingFaceToken.trim() &&
			!huggingfaceConfigured
		) {
			toast.error("Add a Hugging Face token first");
			return;
		}

		setBusyProvider(provider);
		try {
			if (provider === "huggingface" && huggingFaceToken.trim()) {
				await setKey("huggingface", huggingFaceToken.trim());
				setHuggingFaceToken("");
			}
			await saveModelProfile(provider, modelId);
			setModelId(provider, modelId);
			if (launch) {
				await onLaunchModel?.({
					provider,
					modelId,
				});
				onOpenChange(false);
			} else {
				toast.success(
					`${provider === "huggingface" ? "Hugging Face" : "Ollama"} profile saved`,
				);
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save the profile",
			);
		} finally {
			setBusyProvider(null);
		}
	};

	const connectSubscription = (provider: SubscriptionProvider) => {
		onOpenChange(false);
		onConnectSubscription?.(provider);
	};

	const launchTarget = isLaunch
		? `${modelLabel ?? "This model"} needs ${
				initialProvider === "openrouter"
					? "OpenRouter"
					: initialProvider === "huggingface"
						? "a Hugging Face profile"
						: "an Ollama profile"
			}.`
		: "Connect subscriptions and choose cloud or local model providers.";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-[680px]">
				<DialogHeader>
					<DialogTitle>Provider Hub</DialogTitle>
					<DialogDescription>{launchTarget}</DialogDescription>
				</DialogHeader>

				<div className="space-y-5 py-1">
					<section className="space-y-2">
						<div>
							<h3 className="text-sm font-medium">Subscriptions</h3>
							<p className="text-xs text-muted-foreground">
								ADE opens the official login flow. It never receives your
								account credentials.
							</p>
						</div>
						<div className="grid gap-2 sm:grid-cols-2">
							{(["claude", "codex"] as const).map((provider) => {
								const state = connectionStatus.data?.[provider];
								const label = provider === "claude" ? "Claude" : "Codex";
								const status = !state
									? "Checking…"
									: !state.installed
										? "CLI not installed"
										: state.authenticated
											? "Connected"
											: "Not connected";
								return (
									<div
										key={provider}
										className="rounded-lg border bg-muted/20 p-3"
									>
										<div className="flex items-center justify-between gap-3">
											<div>
												<p className="text-sm font-medium">{label}</p>
												<p className="text-xs text-muted-foreground">
													{status}
												</p>
											</div>
											<Button
												variant="outline"
												size="sm"
												disabled={!state}
												onClick={() => connectSubscription(provider)}
											>
												{!state?.installed
													? "Install"
													: state.authenticated
														? "Reconnect"
														: "Connect"}
											</Button>
										</div>
									</div>
								);
							})}
						</div>
						<button
							type="button"
							className="text-xs text-muted-foreground underline underline-offset-2"
							onClick={() => connectionStatus.refetch()}
						>
							Refresh connection status
						</button>
					</section>

					<section className="space-y-2">
						<div>
							<h3 className="text-sm font-medium">Model providers</h3>
							<p className="text-xs text-muted-foreground">
								Tokens stay encrypted with Windows secure storage. Model IDs do
								not download weights unless you explicitly manage Ollama outside
								ADE. Custom-model sessions use workspace-write isolation and ask
								before elevated actions.
							</p>
						</div>

						<div className="space-y-2 rounded-lg border p-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="text-sm font-medium">OpenRouter</p>
									<p className="text-xs text-muted-foreground">
										Kimi, MiniMax, and GLM through Claude Code.
									</p>
								</div>
								<span className="text-xs text-muted-foreground">
									{openrouterConfigured ? "Configured" : "Not configured"}
								</span>
							</div>
							<Label htmlFor="openrouter-key">API key</Label>
							<Input
								id="openrouter-key"
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={openRouterKey}
								onChange={(event) => setOpenRouterKey(event.target.value)}
								placeholder="sk-or-…"
							/>
							<div className="flex items-center justify-between gap-2">
								<button
									type="button"
									className="text-xs text-muted-foreground underline underline-offset-2"
									onClick={() => openExternal(OPENROUTER_KEYS_URL)}
								>
									Get an OpenRouter key
								</button>
								<div className="flex gap-2">
									{openrouterConfigured && !isLaunch && (
										<Button
											variant="ghost"
											size="sm"
											disabled={isClearing}
											onClick={() => removeKey("openrouter")}
										>
											Remove
										</Button>
									)}
									<Button
										size="sm"
										disabled={
											!openRouterKey.trim() ||
											isSaving ||
											busyProvider === "openrouter"
										}
										onClick={saveOpenRouter}
									>
										{isLaunch && initialProvider === "openrouter"
											? "Save & launch"
											: "Save"}
									</Button>
								</div>
							</div>
						</div>

						{(["huggingface", "ollama"] as const).map((provider) => {
							const label =
								provider === "huggingface" ? "Hugging Face" : "Ollama";
							const launch = isLaunch && initialProvider === provider;
							return (
								<div key={provider} className="space-y-2 rounded-lg border p-3">
									<div className="flex items-start justify-between gap-3">
										<div>
											<p className="text-sm font-medium">{label}</p>
											<p className="text-xs text-muted-foreground">
												{provider === "huggingface"
													? "Remote Inference Providers; no model download."
													: "Use a model already served by local Ollama."}
											</p>
										</div>
										{provider === "huggingface" && (
											<span className="text-xs text-muted-foreground">
												{huggingfaceConfigured
													? "Token configured"
													: "Token required"}
											</span>
										)}
									</div>

									{provider === "huggingface" && (
										<>
											<Label htmlFor="huggingface-token">Access token</Label>
											<Input
												id="huggingface-token"
												type="password"
												autoComplete="off"
												spellCheck={false}
												value={huggingFaceToken}
												onChange={(event) =>
													setHuggingFaceToken(event.target.value)
												}
												placeholder="hf_…"
											/>
										</>
									)}

									<div className="space-y-1.5">
										<Label htmlFor={`${provider}-model`}>Model ID</Label>
										<Input
											id={`${provider}-model`}
											value={modelDrafts[provider]}
											onChange={(event) =>
												setModelDrafts((current) => ({
													...current,
													[provider]: event.target.value,
												}))
											}
											placeholder={
												provider === "huggingface"
													? "org/model"
													: "qwen3-coder:30b"
											}
										/>
									</div>

									<div className="flex items-center justify-between gap-2">
										{provider === "huggingface" ? (
											<button
												type="button"
												className="text-xs text-muted-foreground underline underline-offset-2"
												onClick={() => openExternal(HUGGING_FACE_TOKENS_URL)}
											>
												Get a Hugging Face token
											</button>
										) : (
											<span className="text-xs text-muted-foreground">
												Endpoint: 127.0.0.1:11434
											</span>
										)}
										<div className="flex gap-2">
											{provider === "huggingface" &&
												huggingfaceConfigured &&
												!launch && (
													<Button
														variant="ghost"
														size="sm"
														disabled={isClearing}
														onClick={() => removeKey("huggingface")}
													>
														Remove token
													</Button>
												)}
											<Button
												size="sm"
												disabled={
													!isValidOpenCodeModelId(modelDrafts[provider]) ||
													busyProvider === provider
												}
												onClick={() => saveModelProvider(provider, launch)}
											>
												{launch ? "Save & launch" : "Save profile"}
											</Button>
										</div>
									</div>
								</div>
							);
						})}
					</section>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
