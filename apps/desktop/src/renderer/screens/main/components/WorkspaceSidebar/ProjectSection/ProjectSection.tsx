import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { AnimatePresence, motion } from "framer-motion";
import { useDrag, useDrop } from "react-dnd";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useReorderProjects } from "renderer/react-query/projects";
import { useWorkspaceSidebarStore } from "renderer/stores";
import { useOpenNewWorkspaceModal } from "renderer/stores/new-workspace-modal";
import { getSpaceTint } from "../space-colors";
import { WorkspaceListItem } from "../WorkspaceListItem";
import { ProjectHeader } from "./ProjectHeader";

const PROJECT_TYPE = "PROJECT";

interface ProjectDragItem {
	projectId: string;
	index: number;
	originalIndex: number;
	isPinned: boolean;
}

interface Workspace {
	id: string;
	projectId: string;
	worktreePath: string;
	type: "worktree" | "branch";
	branch: string;
	name: string;
	tabOrder: number;
	isUnread: boolean;
	iconUrl: string | null;
	role: string | null;
}

interface ProjectSectionProps {
	projectId: string;
	projectName: string;
	projectColor: string;
	githubOwner: string | null;
	mainRepoPath: string;
	hideImage: boolean;
	iconUrl: string | null;
	isPinned: boolean;
	workspaces: Workspace[];
	threadCount: number;
	/** Base index for keyboard shortcuts (0-based) */
	shortcutBaseIndex: number;
	/** Index for drag-and-drop reordering */
	index: number;
	/** Whether the sidebar is in collapsed mode */
	isCollapsed?: boolean;
}

export function ProjectSection({
	projectId,
	projectName,
	projectColor,
	githubOwner,
	mainRepoPath,
	hideImage,
	iconUrl,
	isPinned,
	workspaces,
	threadCount,
	shortcutBaseIndex,
	index,
	isCollapsed: isSidebarCollapsed = false,
}: ProjectSectionProps) {
	const { isProjectCollapsed, toggleProjectCollapsed } =
		useWorkspaceSidebarStore();
	const openModal = useOpenNewWorkspaceModal();
	const reorderProjects = useReorderProjects();
	const utils = electronTrpc.useUtils();

	const isCollapsed = isProjectCollapsed(projectId);

	const handleNewWorkspace = () => {
		openModal(projectId);
	};

	const [{ isDragging }, drag] = useDrag<
		ProjectDragItem,
		unknown,
		{ isDragging: boolean }
	>(
		() => ({
			type: PROJECT_TYPE,
			item: { projectId, index, originalIndex: index, isPinned },
			end: (item, monitor) => {
				if (!item) return;
				const dropResult = monitor.getDropResult<{ accepted: true }>();
				if (!dropResult?.accepted) {
					// Hover updates are optimistic. Restore canonical server order when a
					// project is released outside its own pinned/unpinned group.
					void utils.workspaces.getAllGrouped.invalidate();
					return;
				}
				if (item.originalIndex !== item.index) {
					reorderProjects.mutate(
						{ fromIndex: item.originalIndex, toIndex: item.index },
						{
							onError: (error) =>
								toast.error(`Failed to reorder: ${error.message}`),
							onSettled: () => utils.workspaces.getAllGrouped.invalidate(),
						},
					);
				}
			},
			collect: (monitor) => ({
				isDragging: monitor.isDragging(),
			}),
		}),
		[projectId, index, isPinned, reorderProjects, utils],
	);

	const [, drop] = useDrop<ProjectDragItem, { accepted: true }, unknown>({
		accept: PROJECT_TYPE,
		canDrop: (item) => item.isPinned === isPinned,
		hover: (item) => {
			if (item.isPinned !== isPinned) return;
			if (item.index !== index) {
				utils.workspaces.getAllGrouped.setData(undefined, (oldData) => {
					if (!oldData) return oldData;
					const newGroups = [...oldData];
					const [moved] = newGroups.splice(item.index, 1);
					newGroups.splice(index, 0, moved);
					return newGroups;
				});
				item.index = index;
			}
		},
		drop: (item) => {
			if (item.isPinned !== isPinned) return;
			return { accepted: true as const };
		},
	});

	if (isSidebarCollapsed) {
		return (
			<div
				ref={(node) => {
					drag(drop(node));
				}}
				className={cn(
					"flex flex-col items-center py-2 border-b border-border last:border-b-0",
					isDragging && "opacity-30",
				)}
				style={{ cursor: isDragging ? "grabbing" : "grab" }}
			>
				<ProjectHeader
					projectId={projectId}
					projectName={projectName}
					projectColor={projectColor}
					githubOwner={githubOwner}
					mainRepoPath={mainRepoPath}
					hideImage={hideImage}
					iconUrl={iconUrl}
					isPinned={isPinned}
					isCollapsed={isCollapsed}
					isSidebarCollapsed={isSidebarCollapsed}
					onToggleCollapse={() => toggleProjectCollapsed(projectId)}
					workspaceCount={workspaces.length}
					threadCount={threadCount}
					onNewWorkspace={handleNewWorkspace}
				/>
				<AnimatePresence initial={false}>
					{!isCollapsed && (
						<motion.div
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: "auto", opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden w-full"
						>
							<div className="flex flex-col items-center gap-1 pt-1">
								{workspaces.map((workspace, wsIndex) => (
									<WorkspaceListItem
										key={workspace.id}
										id={workspace.id}
										projectId={workspace.projectId}
										worktreePath={workspace.worktreePath}
										name={workspace.name}
										branch={workspace.branch}
										type={workspace.type}
										isUnread={workspace.isUnread}
										iconUrl={workspace.iconUrl}
										tintColor={getSpaceTint(
											projectName,
											wsIndex,
											workspaces.length,
										)}
										role={workspace.role}
										index={wsIndex}
										shortcutIndex={shortcutBaseIndex + wsIndex}
										isCollapsed={isSidebarCollapsed}
									/>
								))}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		);
	}

	return (
		<div
			ref={(node) => {
				drag(drop(node));
			}}
			className={cn(
				"border-b border-border last:border-b-0",
				isDragging && "opacity-30",
			)}
			style={{ cursor: isDragging ? "grabbing" : "grab" }}
		>
			<ProjectHeader
				projectId={projectId}
				projectName={projectName}
				projectColor={projectColor}
				githubOwner={githubOwner}
				mainRepoPath={mainRepoPath}
				hideImage={hideImage}
				iconUrl={iconUrl}
				isPinned={isPinned}
				isCollapsed={isCollapsed}
				isSidebarCollapsed={isSidebarCollapsed}
				onToggleCollapse={() => toggleProjectCollapsed(projectId)}
				workspaceCount={workspaces.length}
				threadCount={threadCount}
				onNewWorkspace={handleNewWorkspace}
			/>

			<AnimatePresence initial={false}>
				{!isCollapsed && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<div className="pb-1">
							{workspaces.map((workspace, wsIndex) => (
								<WorkspaceListItem
									key={workspace.id}
									id={workspace.id}
									projectId={workspace.projectId}
									worktreePath={workspace.worktreePath}
									name={workspace.name}
									branch={workspace.branch}
									type={workspace.type}
									isUnread={workspace.isUnread}
									iconUrl={workspace.iconUrl}
									tintColor={getSpaceTint(
										projectName,
										wsIndex,
										workspaces.length,
									)}
									role={workspace.role}
									index={wsIndex}
									shortcutIndex={shortcutBaseIndex + wsIndex}
								/>
							))}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
