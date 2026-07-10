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
import { CheckIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProviderKeys } from "renderer/stores/model-bar/useProviderKeys";
import {
	MAX_PROVIDER_MODELS,
	useProviderProfiles,
} from "renderer/stores/model-bar/useProviderProfiles";
import { ProviderIcon } from "./ProviderIcon";

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
		clearModelProfile,
		isSaving,
		isClearing,
	} = useProviderKeys();
	const profiles = useProviderProfiles((state) => state.profiles);
	const addModelId = useProviderProfiles((state) => state.addModelId);
	const removeModelId = useProviderProfiles((state) => state.removeModelId);
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
			huggingface: "",
			ollama: "",
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
		modelId: string,
		launch: boolean,
	): Promise<boolean> => {
		const trimmedModelId = modelId.trim();
		if (!isValidOpenCodeModelId(trimmedModelId)) return false;
		if (
			launch &&
			provider === "huggingface" &&
			!huggingFaceToken.trim() &&
			!huggingfaceConfigured
		) {
			toast.error("Add a Hugging Face token first");
			return false;
		}

		setBusyProvider(provider);
		try {
			if (provider === "huggingface" && huggingFaceToken.trim()) {
				await setKey("huggingface", huggingFaceToken.trim());
				setHuggingFaceToken("");
			}
			await saveModelProfile(provider, trimmedModelId);
			addModelId(provider, trimmedModelId);
			if (launch) {
				await onLaunchModel?.({
					provider,
					modelId: trimmedModelId,
				});
				onOpenChange(false);
			} else {
				toast.success("Default model updated");
			}
			return true;
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save the profile",
			);
			return false;
		} finally {
			setBusyProvider(null);
		}
	};

	const addProviderModel = async (
		provider: OpenCodeModelProvider,
		launch: boolean,
	) => {
		const modelId = modelDrafts[provider].trim();
		if (!isValidOpenCodeModelId(modelId)) return;
		const profile = profiles[provider];
		if (
			!profile.modelIds.includes(modelId) &&
			profile.modelIds.length >= MAX_PROVIDER_MODELS
		) {
			toast.error(
				`You can save up to ${MAX_PROVIDER_MODELS} models per provider`,
			);
			return;
		}

		const saved = await saveModelProvider(provider, modelId, launch);
		if (saved) {
			setModelDrafts((current) => ({ ...current, [provider]: "" }));
		}
	};

	const removeProviderModel = async (
		provider: OpenCodeModelProvider,
		modelId: string,
	) => {
		const profile = profiles[provider];
		const fallbackModelId = profile.modelIds.find((value) => value !== modelId);
		setBusyProvider(provider);
		try {
			if (profile.selectedModelId === modelId) {
				if (fallbackModelId) {
					await saveModelProfile(provider, fallbackModelId);
				} else {
					await clearModelProfile(provider);
				}
			}
			removeModelId(provider, modelId);
			toast.success("Model removed");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not remove the model",
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
		: "Connect subscriptions and add the cloud or local models you choose.";

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
							const profile = profiles[provider];
							return (
								<div key={provider} className="space-y-2 rounded-lg border p-3">
									<div className="flex items-start justify-between gap-3">
										<div>
											<div className="flex items-center gap-2">
												<ProviderIcon provider={provider} className="h-4 w-4" />
												<p className="text-sm font-medium">{label}</p>
											</div>
											<p className="text-xs text-muted-foreground">
												{provider === "huggingface"
													? "Remote Inference Providers; no model download."
													: "Use a model already served by local Ollama."}
											</p>
										</div>
										<div className="text-right text-xs text-muted-foreground">
											<p>
												{profile.selectedModelId
													? "Default selected"
													: "No default"}
											</p>
											{provider === "huggingface" && (
												<p>
													{huggingfaceConfigured
														? "Token configured"
														: "Token required"}
												</p>
											)}
										</div>
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
										<Label htmlFor={`${provider}-model`}>Add model ID</Label>
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

									{profile.modelIds.length > 0 && (
										<div className="space-y-1.5">
											<div className="flex items-center justify-between text-xs text-muted-foreground">
												<span>Saved models</span>
												<span>
													{profile.modelIds.length}/{MAX_PROVIDER_MODELS}
												</span>
											</div>
											{profile.modelIds.map((modelId) => {
												const selected = profile.selectedModelId === modelId;
												return (
													<div
														key={modelId}
														className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 ${
															selected ? "bg-muted/40" : "bg-background"
														}`}
													>
														<div className="flex min-w-0 items-center gap-2">
															{selected && (
																<CheckIcon
																	aria-label="Default model"
																	className="h-3.5 w-3.5 shrink-0"
																/>
															)}
															<code className="truncate text-xs">
																{modelId}
															</code>
														</div>
														<div className="flex shrink-0 items-center gap-1">
															<Button
																variant="ghost"
																size="sm"
																disabled={selected || busyProvider === provider}
																onClick={() =>
																	saveModelProvider(provider, modelId, false)
																}
															>
																Use
															</Button>
															<Button
																variant="outline"
																size="sm"
																disabled={
																	busyProvider === provider ||
																	(provider === "huggingface" &&
																		!huggingfaceConfigured &&
																		!huggingFaceToken.trim())
																}
																onClick={() =>
																	saveModelProvider(provider, modelId, true)
																}
															>
																<PlayIcon className="h-3.5 w-3.5" />
																Launch
															</Button>
															<Button
																variant="ghost"
																size="sm"
																aria-label={`Remove ${modelId}`}
																disabled={busyProvider === provider}
																onClick={() =>
																	void removeProviderModel(provider, modelId)
																}
															>
																<Trash2Icon className="h-3.5 w-3.5" />
															</Button>
														</div>
													</div>
												);
											})}
										</div>
									)}

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
												onClick={() => addProviderModel(provider, launch)}
											>
												{launch ? "Add & launch" : "Add model"}
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
