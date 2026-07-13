import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@superset/ui/hover-card";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { HiChevronRight, HiMiniPlus } from "react-icons/hi2";
import {
	LuFolderOpen,
	LuImage,
	LuImageOff,
	LuPalette,
	LuPencil,
	LuPin,
	LuPinOff,
	LuSettings,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useUpdateProject } from "renderer/react-query/projects/useUpdateProject";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { useProjectRename } from "renderer/screens/main/hooks/useProjectRename";
import {
	PROJECT_COLOR_DEFAULT,
	PROJECT_COLORS,
} from "shared/constants/project-colors";
import { STROKE_WIDTH } from "../constants";
import { RenameInput } from "../RenameInput";
import { CloseProjectDialog } from "./CloseProjectDialog";
import { ProjectHoverCardContent } from "./ProjectHoverCard";
import { ProjectThumbnail } from "./ProjectThumbnail";

interface ProjectHeaderProps {
	projectId: string;
	projectName: string;
	projectColor: string;
	githubOwner: string | null;
	mainRepoPath: string;
	hideImage: boolean;
	iconUrl: string | null;
	isPinned: boolean;
	/** Whether the project section is collapsed (workspaces hidden) */
	isCollapsed: boolean;
	/** Whether the sidebar is in collapsed mode (icon-only view) */
	isSidebarCollapsed?: boolean;
	onToggleCollapse: () => void;
	workspaceCount: number;
	threadCount: number;
	onNewWorkspace: () => void;
}

export function ProjectHeader({
	projectId,
	projectName,
	projectColor,
	githubOwner,
	mainRepoPath,
	hideImage,
	iconUrl,
	isPinned,
	isCollapsed,
	isSidebarCollapsed = false,
	onToggleCollapse,
	workspaceCount,
	threadCount,
	onNewWorkspace,
}: ProjectHeaderProps) {
	const utils = electronTrpc.useUtils();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { workspaceId?: string };
	const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
	const rename = useProjectRename(projectId, projectName);

	const closeProject = electronTrpc.projects.close.useMutation({
		onMutate: async ({ id }) => {
			// Check if we're viewing a workspace from this project BEFORE closing
			let shouldNavigate = false;

			if (params.workspaceId) {
				try {
					const currentWorkspace = await utils.workspaces.get.fetch({
						id: params.workspaceId,
					});
					shouldNavigate = currentWorkspace?.projectId === id;
				} catch {
					// Workspace might not exist, skip navigation
				}
			}

			return { shouldNavigate };
		},
		onSuccess: async (data, { id }, context) => {
			utils.workspaces.getAllGrouped.invalidate();
			utils.projects.getRecents.invalidate();

			// Navigate away if we were viewing a workspace from the closed project
			if (context?.shouldNavigate) {
				// Find a workspace from a different project to navigate to
				const groups = await utils.workspaces.getAllGrouped.fetch();
				const otherWorkspace = groups
					.flatMap((group) => group.workspaces)
					.find((w) => w.projectId !== id);

				if (otherWorkspace) {
					navigateToWorkspace(otherWorkspace.id, navigate);
				} else {
					// No other workspaces exist - go to workspace index
					navigate({ to: "/workspace" });
				}
			}

			if (data.terminalWarning) {
				toast.warning(data.terminalWarning);
			}
		},
		onError: (error) => {
			toast.error(`Failed to close category: ${error.message}`);
		},
	});

	const openInFinder = electronTrpc.external.openInFinder.useMutation({
		onError: (error) => toast.error(`Failed to open: ${error.message}`),
	});

	const handleCloseProject = () => {
		setIsCloseDialogOpen(true);
	};

	const handleConfirmClose = () => {
		closeProject.mutate({ id: projectId });
	};

	const handleOpenInFinder = () => {
		if (!mainRepoPath) return;
		openInFinder.mutate(mainRepoPath);
	};

	const handleOpenSettings = () => {
		navigate({ to: "/settings/project/$projectId", params: { projectId } });
	};

	const updateProject = useUpdateProject({
		onError: (error) =>
			toast.error(`Failed to update project: ${error.message}`),
	});

	const handleColorChange = (color: string) => {
		updateProject.mutate({ id: projectId, patch: { color } });
	};

	const handleToggleImage = () => {
		updateProject.mutate({ id: projectId, patch: { hideImage: !hideImage } });
	};

	const handleTogglePin = () => {
		updateProject.mutate({ id: projectId, patch: { isPinned: !isPinned } });
	};

	const projectHoverCard = (
		<HoverCardContent side="right" align="start" className="w-72">
			<ProjectHoverCardContent
				projectName={projectName}
				githubOwner={githubOwner}
				mainRepoPath={mainRepoPath}
				agentCount={workspaceCount}
				threadCount={threadCount}
				isPinned={isPinned}
			/>
		</HoverCardContent>
	);

	// Color picker submenu used in both collapsed and expanded context menus
	const colorPickerSubmenu = (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<LuPalette className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
				Set Color
			</ContextMenuSubTrigger>
			<ContextMenuSubContent className="w-36">
				{PROJECT_COLORS.map((color) => {
					const isDefault = color.value === PROJECT_COLOR_DEFAULT;
					return (
						<ContextMenuItem
							key={color.value}
							onSelect={() => handleColorChange(color.value)}
							className="flex items-center gap-2"
						>
							<span
								className={cn(
									"size-3 rounded-full border",
									isDefault ? "border-border bg-muted" : "border-border/50",
								)}
								style={isDefault ? undefined : { backgroundColor: color.value }}
							/>
							<span>{color.name}</span>
							{projectColor === color.value && (
								<span className="ml-auto text-xs text-muted-foreground">✓</span>
							)}
						</ContextMenuItem>
					);
				})}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);

	// Collapsed sidebar: show just the thumbnail with hover details and context menu
	if (isSidebarCollapsed) {
		return (
			<>
				<ContextMenu>
					<HoverCard openDelay={300} closeDelay={100}>
						<HoverCardTrigger asChild>
							<ContextMenuTrigger asChild>
								<button
									type="button"
									onClick={onToggleCollapse}
									className={cn(
										"relative flex items-center justify-center size-8 rounded-md",
										"hover:bg-muted/50 transition-colors",
									)}
								>
									<ProjectThumbnail
										projectId={projectId}
										projectName={projectName}
										projectColor={projectColor}
										githubOwner={githubOwner}
										iconUrl={iconUrl}
									/>
									{isPinned && (
										<LuPin className="absolute -right-0.5 -top-0.5 size-3 text-muted-foreground" />
									)}
								</button>
							</ContextMenuTrigger>
						</HoverCardTrigger>
						{projectHoverCard}
					</HoverCard>
					<ContextMenuContent>
						<ContextMenuItem onSelect={handleTogglePin}>
							{isPinned ? (
								<LuPinOff className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
							) : (
								<LuPin className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
							)}
							{isPinned ? "Unpin" : "Pin"}
						</ContextMenuItem>
						<ContextMenuItem onSelect={rename.startRename}>
							<LuPencil className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
							Rename
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem
							onSelect={handleOpenInFinder}
							disabled={!mainRepoPath}
						>
							<LuFolderOpen
								className="size-4 mr-2"
								strokeWidth={STROKE_WIDTH}
							/>
							Show in folder
						</ContextMenuItem>
						<ContextMenuItem onSelect={handleOpenSettings}>
							<LuSettings className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
							Project Settings
						</ContextMenuItem>
						{colorPickerSubmenu}
						<ContextMenuSeparator />
						<ContextMenuItem
							onSelect={handleCloseProject}
							disabled={closeProject.isPending}
							className="text-destructive focus:text-destructive"
						>
							<LuX
								className="size-4 mr-2 text-destructive"
								strokeWidth={STROKE_WIDTH}
							/>
							{closeProject.isPending ? "Closing..." : "Close Project"}
						</ContextMenuItem>
					</ContextMenuContent>
				</ContextMenu>

				<CloseProjectDialog
					projectName={projectName}
					workspaceCount={workspaceCount}
					open={isCloseDialogOpen}
					onOpenChange={setIsCloseDialogOpen}
					onConfirm={handleConfirmClose}
				/>
			</>
		);
	}

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							"flex items-center w-full pl-3 pr-2 py-1.5 text-sm font-medium",
							"hover:bg-muted/50 transition-colors",
						)}
					>
						{/* Main clickable area */}
						{rename.isRenaming ? (
							<div className="flex items-center gap-2 flex-1 min-w-0 py-0.5">
								<ProjectThumbnail
									projectId={projectId}
									projectName={projectName}
									projectColor={projectColor}
									githubOwner={githubOwner}
									hideImage={hideImage}
									iconUrl={iconUrl}
								/>
								<RenameInput
									value={rename.renameValue}
									onChange={rename.setRenameValue}
									onSubmit={rename.submitRename}
									onCancel={rename.cancelRename}
									className="h-6 px-1 py-0 text-sm -ml-1 font-medium bg-transparent border-none outline-none flex-1 min-w-0"
								/>
							</div>
						) : (
							<HoverCard openDelay={300} closeDelay={100}>
								<HoverCardTrigger asChild>
									<button
										type="button"
										onClick={onToggleCollapse}
										onDoubleClick={rename.startRename}
										className="flex items-center gap-2 flex-1 min-w-0 py-0.5 text-left cursor-pointer"
									>
										<ProjectThumbnail
											projectId={projectId}
											projectName={projectName}
											projectColor={projectColor}
											githubOwner={githubOwner}
											hideImage={hideImage}
											iconUrl={iconUrl}
										/>
										<span className="truncate">{projectName}</span>
										{isPinned && (
											<LuPin
												className="size-3.5 shrink-0 text-muted-foreground"
												strokeWidth={STROKE_WIDTH}
											/>
										)}
										<span className="text-xs text-muted-foreground tabular-nums font-normal">
											({workspaceCount})
										</span>
									</button>
								</HoverCardTrigger>
								{projectHoverCard}
							</HoverCard>
						)}

						{/* Add workspace button */}
						<Tooltip delayDuration={500}>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onNewWorkspace();
									}}
									onContextMenu={(e) => e.stopPropagation()}
									className="p-1 rounded hover:bg-muted transition-colors shrink-0 ml-1"
								>
									<HiMiniPlus className="size-4 text-muted-foreground" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" sideOffset={4}>
								New agent
							</TooltipContent>
						</Tooltip>

						{/* Collapse chevron */}
						<button
							type="button"
							onClick={onToggleCollapse}
							onContextMenu={(e) => e.stopPropagation()}
							aria-expanded={!isCollapsed}
							className="p-1 rounded hover:bg-muted transition-colors shrink-0 ml-1"
						>
							<HiChevronRight
								className={cn(
									"size-3.5 text-muted-foreground transition-transform duration-150",
									!isCollapsed && "rotate-90",
								)}
							/>
						</button>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onSelect={handleTogglePin}>
						{isPinned ? (
							<LuPinOff className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						) : (
							<LuPin className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						)}
						{isPinned ? "Unpin" : "Pin"}
					</ContextMenuItem>
					<ContextMenuItem onSelect={rename.startRename}>
						<LuPencil className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						Rename
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						onSelect={handleOpenInFinder}
						disabled={!mainRepoPath}
					>
						<LuFolderOpen className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						Show in folder
					</ContextMenuItem>
					<ContextMenuItem onSelect={handleOpenSettings}>
						<LuSettings className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						Project Settings
					</ContextMenuItem>
					{colorPickerSubmenu}
					<ContextMenuItem onSelect={handleToggleImage}>
						{hideImage ? (
							<LuImage className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						) : (
							<LuImageOff className="size-4 mr-2" strokeWidth={STROKE_WIDTH} />
						)}
						{hideImage ? "Show Image" : "Hide Image"}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						onSelect={handleCloseProject}
						disabled={closeProject.isPending}
						className="text-destructive focus:text-destructive"
					>
						<LuX
							className="size-4 mr-2 text-destructive"
							strokeWidth={STROKE_WIDTH}
						/>
						{closeProject.isPending ? "Closing..." : "Close Project"}
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>

			<CloseProjectDialog
				projectName={projectName}
				workspaceCount={workspaceCount}
				open={isCloseDialogOpen}
				onOpenChange={setIsCloseDialogOpen}
				onConfirm={handleConfirmClose}
			/>
		</>
	);
}
