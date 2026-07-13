import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useMemo } from "react";
import { LuFolderOpen, LuFolderPlus, LuPlus } from "react-icons/lu";
import { useWorkspaceShortcuts } from "renderer/hooks/useWorkspaceShortcuts";
import { useOpenProject } from "renderer/react-query/projects";
import { useOpenNewCategoryModal } from "renderer/stores/new-category-modal";
import { useTabsStore } from "renderer/stores/tabs";
import { PortsList } from "./PortsList";
import { ProjectSection } from "./ProjectSection";
import { countProjectTerminalThreads } from "./ProjectSection/project-hover-metadata";
import { SidebarDropZone } from "./SidebarDropZone";

interface WorkspaceSidebarProps {
	isCollapsed?: boolean;
	activeProjectId: string | null;
	activeProjectName: string | null;
}

export function WorkspaceSidebar({
	isCollapsed = false,
}: WorkspaceSidebarProps) {
	const { groups } = useWorkspaceShortcuts();
	const openNewCategory = useOpenNewCategoryModal();
	const { openNewAndNavigate, isPending: isOpeningProject } = useOpenProject();
	const tabs = useTabsStore((state) => state.tabs);
	const panes = useTabsStore((state) => state.panes);

	// Calculate shortcut base indices for each project group using cumulative offsets
	const projectShortcutIndices = useMemo(
		() =>
			groups.reduce<{ indices: number[]; cumulative: number }>(
				(acc, group) => ({
					indices: [...acc.indices, acc.cumulative],
					cumulative: acc.cumulative + group.workspaces.length,
				}),
				{ indices: [], cumulative: 0 },
			).indices,
		[groups],
	);
	const projectThreadCounts = useMemo(
		() =>
			new Map(
				groups.map((group) => [
					group.project.id,
					countProjectTerminalThreads({
						workspaces: group.workspaces,
						tabs,
						panes,
					}),
				]),
			),
		[groups, panes, tabs],
	);

	return (
		<SidebarDropZone className="flex flex-col h-full bg-muted/45 dark:bg-muted/35">
			{!isCollapsed && (
				<div className="flex items-center justify-between px-3 h-10 shrink-0">
					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Projects
					</span>
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										className="flex items-center justify-center size-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
										aria-label="Add project or category"
									>
										<LuPlus className="size-4" />
									</button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="right">Add project</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end" className="w-48">
							<DropdownMenuItem
								onSelect={() => void openNewAndNavigate()}
								disabled={isOpeningProject}
							>
								<LuFolderOpen className="size-4" />
								{isOpeningProject ? "Opening..." : "Open project folder"}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openNewCategory()}>
								<LuFolderPlus className="size-4" />
								New category
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}
			<div className="flex-1 overflow-y-auto hide-scrollbar">
				{groups.map((group, index) => (
					<ProjectSection
						key={group.project.id}
						projectId={group.project.id}
						projectName={group.project.name}
						projectColor={group.project.color}
						githubOwner={group.project.githubOwner}
						mainRepoPath={group.project.mainRepoPath}
						hideImage={group.project.hideImage}
						iconUrl={group.project.iconUrl}
						isPinned={group.project.isPinned}
						workspaces={group.workspaces}
						threadCount={projectThreadCounts.get(group.project.id) ?? 0}
						shortcutBaseIndex={projectShortcutIndices[index]}
						index={index}
						isCollapsed={isCollapsed}
					/>
				))}

				{groups.length === 0 && !isCollapsed && (
					<div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm px-4 text-center">
						<span>No projects yet</span>
						<button
							type="button"
							onClick={() => openNewCategory()}
							className="text-xs mt-2 text-foreground underline underline-offset-2"
						>
							Open your first project
						</button>
					</div>
				)}
			</div>

			{!isCollapsed && <PortsList />}
		</SidebarDropZone>
	);
}
