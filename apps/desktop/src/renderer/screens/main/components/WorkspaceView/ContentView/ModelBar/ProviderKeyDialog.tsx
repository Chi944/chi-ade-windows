import type { TerminalPreset } from "@superset/local-db";
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
import {
	CheckIcon,
	PlayIcon,
	SquareTerminalIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePresets } from "renderer/react-query/presets";
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
	onLaunchPreset?: (preset: TerminalPreset) => void;
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
	onLaunchPreset,
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
	const accountProfiles =
		electronTrpc.settings.subscriptionConnections.profiles.useQuery(undefined, {
			enabled: open,
		});
	const codexUsage =
		electronTrpc.settings.subscriptionConnections.codexUsage.useQuery(
			undefined,
			{
				enabled: open && Boolean(accountProfiles.data?.selected.codex),
				staleTime: 60_000,
				retry: false,
			},
		);
	const utils = electronTrpc.useUtils();
	const createAccountProfile =
		electronTrpc.settings.subscriptionConnections.createProfile.useMutation({
			onSuccess: async () => {
				await utils.settings.subscriptionConnections.profiles.invalidate();
				await utils.settings.subscriptionConnections.status.invalidate();
			},
		});
	const selectAccountProfile =
		electronTrpc.settings.subscriptionConnections.selectProfile.useMutation({
			onSuccess: async () => {
				await utils.settings.subscriptionConnections.profiles.invalidate();
				await utils.settings.subscriptionConnections.status.invalidate();
				await utils.settings.subscriptionConnections.codexUsage.invalidate();
			},
		});
	const removeAccountProfile =
		electronTrpc.settings.subscriptionConnections.removeProfile.useMutation({
			onSuccess: async () => {
				await utils.settings.subscriptionConnections.profiles.invalidate();
				await utils.settings.subscriptionConnections.status.invalidate();
				await utils.settings.subscriptionConnections.codexUsage.invalidate();
			},
		});
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const { presets, createPreset, deletePreset } = usePresets();
	const [openRouterKey, setOpenRouterKey] = useState("");
	const [huggingFaceToken, setHuggingFaceToken] = useState("");
	const [modelDrafts, setModelDrafts] = useState<
		Record<OpenCodeModelProvider, string>
	>({ huggingface: "", ollama: "" });
	const [customAgentName, setCustomAgentName] = useState("");
	const [customAgentCommand, setCustomAgentCommand] = useState("");
	const [accountDrafts, setAccountDrafts] = useState<
		Record<SubscriptionProvider, string>
	>({ claude: "", codex: "" });
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
		setCustomAgentName("");
		setCustomAgentCommand("");
		setAccountDrafts({ claude: "", codex: "" });
		void connectionStatus.refetch();
		void accountProfiles.refetch();
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
		if (!accountProfiles.data?.selected[provider]) {
			toast.error(
				`Add a ${provider === "claude" ? "Claude" : "Codex"} account first`,
			);
			return;
		}
		onOpenChange(false);
		onConnectSubscription?.(provider);
	};

	const addSubscriptionAccount = async (provider: SubscriptionProvider) => {
		const label = accountDrafts[provider].trim();
		if (!label) return;
		try {
			await createAccountProfile.mutateAsync({ provider, label });
			setAccountDrafts((current) => ({ ...current, [provider]: "" }));
			toast.success(`${label} added and selected`);
			onOpenChange(false);
			onConnectSubscription?.(provider);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not add the account",
			);
		}
	};

	const selectSubscriptionAccount = async (
		provider: SubscriptionProvider,
		id: string,
		label: string,
	) => {
		try {
			await selectAccountProfile.mutateAsync({ provider, id });
			toast.success(`${label} selected for new sessions`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not switch accounts",
			);
		}
	};

	const removeSubscriptionAccount = async (
		provider: SubscriptionProvider,
		id: string,
		label: string,
	) => {
		if (
			!window.confirm(
				`Remove ${label}? ADE will delete this app-owned profile and its provider-managed login data.`,
			)
		) {
			return;
		}
		try {
			await removeAccountProfile.mutateAsync({ provider, id });
			toast.success(`${label} removed`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not remove the account",
			);
		}
	};

	const customAgents = presets.filter((preset) => preset.pinnedToBar);

	const addCustomAgent = async () => {
		const name = customAgentName.trim();
		const command = customAgentCommand.trim();
		if (!name || !command) return;

		try {
			const preset = await createPreset.mutateAsync({
				name,
				description: "Custom terminal agent",
				cwd: "",
				commands: [command],
				pinnedToBar: true,
				executionMode: "new-tab",
			});
			setCustomAgentName("");
			setCustomAgentCommand("");
			toast.success(`${name} added to the Agent Bar`);
			onLaunchPreset?.(preset);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not add the agent",
			);
		}
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
							<h3 className="text-sm font-medium">Any terminal agent</h3>
							<p className="text-xs text-muted-foreground">
								If it has a CLI command, ADE can run it in a persistent,
								splittable terminal. Use the CLI's native login or OS keychain;
								never put secrets in the saved command.
							</p>
						</div>
						<div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[0.8fr_1.6fr_auto] sm:items-end">
							<div className="space-y-1.5">
								<Label htmlFor="custom-agent-name">Name</Label>
								<Input
									id="custom-agent-name"
									value={customAgentName}
									onChange={(event) => setCustomAgentName(event.target.value)}
									placeholder="Aider"
									maxLength={60}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="custom-agent-command">Command</Label>
								<Input
									id="custom-agent-command"
									value={customAgentCommand}
									onChange={(event) =>
										setCustomAgentCommand(event.target.value)
									}
									onKeyDown={(event) => {
										if (event.key === "Enter") void addCustomAgent();
									}}
									placeholder="aider --watch-files"
									spellCheck={false}
									maxLength={2048}
								/>
							</div>
							<Button
								onClick={() => void addCustomAgent()}
								disabled={
									!customAgentName.trim() ||
									!customAgentCommand.trim() ||
									createPreset.isPending
								}
							>
								Add & launch
							</Button>
						</div>

						{customAgents.length > 0 && (
							<div className="space-y-1.5">
								{customAgents.map((preset) => (
									<div
										key={preset.id}
										className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
									>
										<div className="flex min-w-0 items-center gap-2">
											<SquareTerminalIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
											<div className="min-w-0">
												<p className="truncate text-sm font-medium">
													{preset.name}
												</p>
												<code className="block truncate text-xs text-muted-foreground">
													{preset.commands.join(" · ")}
												</code>
											</div>
										</div>
										<div className="flex shrink-0 gap-1">
											<Button
												variant="outline"
												size="sm"
												onClick={() => onLaunchPreset?.(preset)}
											>
												<PlayIcon className="h-3.5 w-3.5" />
												Launch
											</Button>
											<Button
												variant="ghost"
												size="sm"
												aria-label={`Remove ${preset.name}`}
												disabled={deletePreset.isPending}
												onClick={() => deletePreset.mutate({ id: preset.id })}
											>
												<Trash2Icon className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</section>

					<section className="space-y-3">
						<div>
							<h3 className="text-sm font-medium">Subscriptions</h3>
							<p className="text-xs text-muted-foreground">
								Account profiles hot-swap new sessions without re-login. Running
								sessions stay on the account that started them. ADE stores
								labels and profile IDs; the official CLIs own all credentials.
							</p>
						</div>
						<div className="grid gap-2 sm:grid-cols-2">
							{(["claude", "codex"] as const).map((provider) => {
								const state = connectionStatus.data?.[provider];
								const label = provider === "claude" ? "Claude" : "Codex";
								const selectedId = accountProfiles.data?.selected[provider];
								const providerProfiles =
									accountProfiles.data?.profiles.filter(
										(profile) => profile.provider === provider,
									) ?? [];
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
										className="space-y-2 rounded-lg border bg-muted/20 p-3"
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
												disabled={!state || !selectedId}
												onClick={() => connectSubscription(provider)}
											>
												{!state?.installed
													? "Install"
													: state.authenticated
														? "Reconnect"
														: "Connect"}
											</Button>
										</div>

										{providerProfiles.length > 0 && (
											<div className="space-y-1">
												{providerProfiles.map((profile) => {
													const selected = profile.id === selectedId;
													return (
														<div
															key={profile.id}
															className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${selected ? "border-violet-500/40 bg-violet-500/10" : "bg-background"}`}
														>
															<button
																type="button"
																onClick={() =>
																	void selectSubscriptionAccount(
																		provider,
																		profile.id,
																		profile.label,
																	)
																}
																className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
															>
																<span
																	className={`size-2 rounded-full ${selected ? "bg-violet-400" : "border border-muted-foreground/50"}`}
																/>
																<span className="truncate">
																	{profile.label}
																</span>
																{selected && (
																	<span className="text-violet-400">
																		Active
																	</span>
																)}
															</button>
															<button
																type="button"
																onClick={() =>
																	void removeSubscriptionAccount(
																		provider,
																		profile.id,
																		profile.label,
																	)
																}
																className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
																aria-label={`Remove ${profile.label}`}
															>
																<Trash2Icon className="size-3.5" />
															</button>
														</div>
													);
												})}
											</div>
										)}

										<div className="flex gap-2">
											<Input
												value={accountDrafts[provider]}
												onChange={(event) =>
													setAccountDrafts((current) => ({
														...current,
														[provider]: event.target.value,
													}))
												}
												placeholder="Account label"
												className="h-8"
												maxLength={80}
											/>
											<Button
												size="sm"
												disabled={
													!accountDrafts[provider].trim() ||
													createAccountProfile.isPending
												}
												onClick={() => void addSubscriptionAccount(provider)}
											>
												Add
											</Button>
										</div>
										{provider === "claude" && platform === "darwin" && (
											<p className="text-[11px] text-amber-500/90">
												macOS keeps Claude credentials in Keychain; profile
												history is isolated, but account switching may require
												the official login flow.
											</p>
										)}
									</div>
								);
							})}
						</div>
						{accountProfiles.data?.selected.codex && (
							<div className="space-y-2 rounded-lg border p-3">
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="text-sm font-medium">Codex usage</p>
										<p className="text-xs text-muted-foreground">
											{codexUsage.data?.email ?? "Selected account"}
											{codexUsage.data?.planType
												? ` · ${codexUsage.data.planType}`
												: ""}
										</p>
									</div>
									<Button
										variant="ghost"
										size="sm"
										disabled={codexUsage.isFetching}
										onClick={() => codexUsage.refetch()}
									>
										{codexUsage.isFetching ? "Refreshing…" : "Refresh"}
									</Button>
								</div>
								<p className="text-[11px] text-muted-foreground">
									Fetched on demand through the official local Codex app-server.
									It may contact OpenAI for current account data; ADE never
									opens the profile's credential file.
								</p>
								{codexUsage.data?.error && (
									<p className="text-xs text-amber-500">
										{codexUsage.data.error}
									</p>
								)}
								{codexUsage.data?.windows.map((window) => (
									<div key={window.id} className="space-y-1">
										<div className="flex justify-between text-xs">
											<span>{window.label ?? window.id}</span>
											<span className="text-muted-foreground">
												{Math.round(window.usedPercent)}% used
												{window.resetsAt
													? ` · resets ${new Date(window.resetsAt * 1000).toLocaleString()}`
													: ""}
											</span>
										</div>
										<div className="h-1.5 overflow-hidden rounded-full bg-muted">
											<div
												className={`h-full rounded-full ${window.usedPercent >= 80 ? "bg-amber-500" : "bg-violet-500"}`}
												style={{
													width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
												}}
											/>
										</div>
									</div>
								))}
								{codexUsage.data?.summary?.lifetimeTokens !== null &&
									codexUsage.data?.summary?.lifetimeTokens !== undefined && (
										<p className="text-xs text-muted-foreground">
											Lifetime activity:{" "}
											{codexUsage.data.summary.lifetimeTokens.toLocaleString()}{" "}
											tokens
										</p>
									)}
							</div>
						)}
						<div className="flex gap-3 text-xs text-muted-foreground">
							<button
								type="button"
								className="underline underline-offset-2"
								onClick={() => {
									void connectionStatus.refetch();
									void codexUsage.refetch();
								}}
							>
								Refresh account status
							</button>
							<span>
								Claude usage remains available through Claude’s /usage command.
							</span>
						</div>
					</section>

					<section className="space-y-2">
						<div>
							<h3 className="text-sm font-medium">Model providers</h3>
							<p className="text-xs text-muted-foreground">
								Tokens stay encrypted with OS secure storage. Model IDs do not
								download weights unless you explicitly manage Ollama outside
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
