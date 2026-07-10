import {
	type AgentBinary,
	type CheckedBinary,
	RUNTIME_BINARY,
} from "@superset/shared/agent-binaries";
import {
	buildProviderModelCommand,
	buildSubscriptionConnectCommand,
	isValidOpenCodeModelId,
	type OpenCodeModelProvider,
	type SubscriptionProvider,
} from "@superset/shared/agent-command";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useParams } from "@tanstack/react-router";
import { SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { HiOutlinePlus } from "react-icons/hi2";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";
import { BinaryInstallDialog } from "renderer/components/BinaryInstallDialog/BinaryInstallDialog";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePresets } from "renderer/react-query/presets";
import { useProviderKeys } from "renderer/stores/model-bar/useProviderKeys";
import { useProviderProfiles } from "renderer/stores/model-bar/useProviderProfiles";
import { useRuntimeAvailability } from "renderer/stores/model-bar/useRuntimeAvailability";
import { useAgentSession } from "renderer/stores/tabs/useAgentSession";
import { useTabsWithPresets } from "renderer/stores/tabs/useTabsWithPresets";
import { MODEL_BAR_MODELS, type ModelDescriptor } from "./models";
import { ProviderIcon } from "./ProviderIcon";
import {
	ProviderKeyDialog,
	type ProviderKeyDialogMode,
} from "./ProviderKeyDialog";

/**
 * A quiet row of model logos below the session tab strip. Clicking a logo opens
 * a new session in the current agent's worktree running that model's CLI. The
 * OpenRouter-proxied models (Kimi / MiniMax / GLM) first gate on a stored
 * OpenRouter key; the trailing "+" manages that key.
 */
export function ModelBar() {
	const { workspaceId } = useParams({ strict: false });
	const isDark = useIsDarkTheme();
	const { spawnAgentSession } = useAgentSession();
	const { openPreset } = useTabsWithPresets();
	const { presets } = usePresets();
	const { openrouterConfigured, huggingfaceConfigured } = useProviderKeys();
	const profiles = useProviderProfiles((state) => state.profiles);
	const { isAvailable, recheck, isFetching } = useRuntimeAvailability();

	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);

	const [dialog, setDialog] = useState<{
		mode: ProviderKeyDialogMode;
		model?: ModelDescriptor;
	} | null>(null);
	const [installBinary, setInstallBinary] = useState<AgentBinary | null>(null);

	// Close the install dialog once a re-check confirms the tool is now present.
	useEffect(() => {
		if (installBinary && isAvailable(installBinary as CheckedBinary)) {
			setInstallBinary(null);
		}
	}, [installBinary, isAvailable]);

	if (!workspaceId) return null;

	const worktreePath = workspace?.worktreePath ?? null;
	const ready = !!worktreePath;
	const customAgents = presets.filter((preset) => preset.pinnedToBar);

	const spawn = (
		model: ModelDescriptor,
		options?: { commands?: string[]; name?: string },
	) => {
		spawnAgentSession(
			{
				id: workspaceId,
				runtime: model.runtime,
				worktreePath,
			},
			options,
		);
	};

	const launchOpenRouter = (model: ModelDescriptor) => {
		spawn(model);
	};

	const launchProviderModel = async (input: {
		provider: OpenCodeModelProvider;
		modelId: string;
	}) => {
		const binary: AgentBinary = "codex";
		if (!isAvailable(binary as CheckedBinary)) {
			setInstallBinary(binary);
			return;
		}
		const model = MODEL_BAR_MODELS.find(
			(item) => item.runtime === input.provider,
		);
		if (!model) return;
		spawn(model, {
			commands: [buildProviderModelCommand(input)],
			name: `${model.label} · ${input.modelId}`,
		});
	};

	const connectSubscription = (provider: SubscriptionProvider) => {
		const binary: AgentBinary = provider;
		if (!isAvailable(binary as CheckedBinary)) {
			setInstallBinary(binary);
			return;
		}
		const model = MODEL_BAR_MODELS.find((item) => item.runtime === provider);
		if (!model) return;
		spawn(model, {
			commands: [
				buildSubscriptionConnectCommand({
					provider,
					windows: process.platform === "win32",
				}),
			],
			name: `Connect ${model.label}`,
		});
	};

	const launchPreset = (preset: (typeof presets)[number]) => {
		if (!ready) return;
		openPreset(workspaceId, preset, { target: "new-tab" });
	};

	const handleModelClick = async (model: ModelDescriptor) => {
		try {
			if (!ready) return;
			if (model.provider === "huggingface" || model.provider === "ollama") {
				const profile = profiles[model.provider];
				if (
					!isValidOpenCodeModelId(profile.selectedModelId) ||
					(model.provider === "huggingface" && !huggingfaceConfigured)
				) {
					setDialog({ mode: "launch", model });
					return;
				}
				await launchProviderModel({
					provider: model.provider,
					modelId: profile.selectedModelId,
				});
				return;
			}
			// Availability gate comes first: every runtime (including the OpenRouter
			// ones, which drive the claude CLI) needs its binary present before we
			// bother prompting for a key or spawning.
			const binary = RUNTIME_BINARY[model.runtime];
			if (!isAvailable(binary as CheckedBinary)) {
				setInstallBinary(binary);
				return;
			}
			if (model.provider === "openrouter" && openrouterConfigured !== true) {
				setDialog({ mode: "launch", model });
				return;
			}
			if (model.provider === "openrouter") {
				await launchOpenRouter(model);
				return;
			}
			spawn(model);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not launch this model",
			);
		}
	};

	return (
		<div className="flex h-9 shrink-0 items-center gap-0.5 border-b bg-background px-2">
			<div
				className={`flex items-center gap-0.5 ${
					ready ? "" : "pointer-events-none opacity-40"
				}`}
			>
				{MODEL_BAR_MODELS.map((model) => {
					const icon = getPresetIcon(model.iconName, isDark);
					const modelProvider =
						model.provider === "huggingface" || model.provider === "ollama"
							? model.provider
							: null;
					const binary = modelProvider
						? "codex"
						: RUNTIME_BINARY[model.runtime];
					const missing = !isAvailable(binary as CheckedBinary);
					const selectedModel = modelProvider
						? profiles[modelProvider].selectedModelId
						: "";
					return (
						<Tooltip key={model.runtime}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={
										missing
											? `${model.label} — not detected, click to install`
											: `New session — ${model.label}`
									}
									disabled={!ready}
									onClick={() => handleModelClick(model)}
									className="group relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted"
								>
									{modelProvider ? (
										<ProviderIcon
											provider={modelProvider}
											className={`h-4 w-4 transition-opacity group-hover:opacity-100 ${
												missing
													? "opacity-30 grayscale group-hover:opacity-60"
													: "opacity-70"
											}`}
										/>
									) : icon ? (
										<img
											src={icon}
											alt=""
											className={`h-4 w-4 object-contain transition-opacity group-hover:opacity-100 ${
												missing
													? "opacity-30 grayscale group-hover:opacity-60"
													: model.isDefault
														? "opacity-90"
														: "opacity-55"
											}`}
										/>
									) : (
										<span className="text-[10px] text-muted-foreground">
											{model.label.slice(0, 2)}
										</span>
									)}
									{model.isDefault && !missing && (
										<span className="absolute -bottom-px h-[3px] w-[3px] rounded-full bg-foreground/40" />
									)}
									{missing && (
										<span className="absolute -right-px -top-px h-[5px] w-[5px] rounded-full bg-amber-500 ring-1 ring-background" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{missing
									? `${model.label} not detected — click to install`
									: `${model.label}${model.isDefault ? " · default" : ""}`}
								{selectedModel && !missing && (
									<span className="block max-w-72 truncate text-muted-foreground">
										{selectedModel}
									</span>
								)}
							</TooltipContent>
						</Tooltip>
					);
				})}
				{customAgents.map((preset) => (
					<Tooltip key={preset.id}>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={`New session — ${preset.name}`}
								disabled={!ready}
								onClick={() => launchPreset(preset)}
								className="group flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
							>
								<SquareTerminalIcon className="h-4 w-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							{preset.name}
							<code className="block max-w-72 truncate text-muted-foreground">
								{preset.commands.join(" · ")}
							</code>
						</TooltipContent>
					</Tooltip>
				))}
			</div>

			<div className="mx-1 h-4 w-px bg-border" />

			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label="Add or manage models"
						onClick={() => setDialog({ mode: "manage" })}
						className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
					>
						<HiOutlinePlus className="h-4 w-4" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					Add or manage models
				</TooltipContent>
			</Tooltip>

			<ProviderKeyDialog
				open={dialog !== null}
				onOpenChange={(open) => !open && setDialog(null)}
				mode={dialog?.mode ?? "manage"}
				modelLabel={dialog?.model?.label}
				initialProvider={dialog?.model?.provider}
				onLaunchOpenRouter={async () => {
					if (dialog?.model) await launchOpenRouter(dialog.model);
					setDialog(null);
				}}
				onLaunchModel={launchProviderModel}
				onConnectSubscription={connectSubscription}
				onLaunchPreset={launchPreset}
			/>

			<BinaryInstallDialog
				binary={installBinary}
				onOpenChange={(open) => !open && setInstallBinary(null)}
				onRecheck={recheck}
				isRechecking={isFetching}
			/>
		</div>
	);
}
