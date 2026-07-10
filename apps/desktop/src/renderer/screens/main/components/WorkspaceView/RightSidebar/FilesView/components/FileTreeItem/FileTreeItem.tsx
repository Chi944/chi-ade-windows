import type { ItemInstance } from "@headless-tree/core";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useState } from "react";
import {
	LuChevronDown,
	LuChevronRight,
	LuClipboard,
	LuCopy,
	LuDownload,
	LuExternalLink,
	LuFile,
	LuFolder,
	LuFolderOpen,
	LuPencil,
	LuTrash2,
} from "react-icons/lu";
import type { DirectoryEntry } from "shared/file-tree-types";
import { useFileDrag, usePathActions } from "../../../../shared/file-hooks";
import { getFileIcon } from "../../utils";

interface FileTreeItemProps {
	item: ItemInstance<DirectoryEntry>;
	entry: DirectoryEntry;
	rowHeight: number;
	indent: number;
	worktreePath: string;
	projectId?: string;
	onActivate: (entry: DirectoryEntry) => void;
	onOpenInEditor: (entry: DirectoryEntry) => void;
	onNewFile: (parentPath: string) => void;
	onNewFolder: (parentPath: string) => void;
	onRename: (entry: DirectoryEntry) => void;
	onDelete: (entry: DirectoryEntry) => void;
	isRemote?: boolean;
	onDownload?: (entry: DirectoryEntry) => void;
	onUploadLocalPaths?: (
		destinationRelativePath: string,
		localPaths: string[],
	) => void;
}

function getRelativeParent(relativePath: string): string {
	const separator = relativePath.lastIndexOf("/");
	return separator < 0 ? "" : relativePath.slice(0, separator);
}

export function FileTreeItem({
	item,
	entry,
	rowHeight,
	indent,
	worktreePath,
	projectId,
	onActivate,
	onOpenInEditor,
	onNewFile,
	onNewFolder,
	onRename,
	onDelete,
	isRemote = false,
	onDownload,
	onUploadLocalPaths,
}: FileTreeItemProps) {
	const [isNativeDragOver, setIsNativeDragOver] = useState(false);
	const isFolder = entry.isDirectory;
	const isExpanded = item.isExpanded();
	const level = item.getItemMeta().level;
	const { icon: Icon, color } = getFileIcon(entry.name, isFolder, isExpanded);

	const parentPath = isRemote
		? isFolder
			? entry.relativePath
			: getRelativeParent(entry.relativePath)
		: isFolder
			? entry.path
			: entry.path.split("/").slice(0, -1).join("/") || worktreePath;

	const localPathActions = usePathActions({
		absolutePath: isRemote ? null : entry.path,
		relativePath: entry.relativePath,
		cwd: worktreePath,
		projectId,
	});

	const localFileDragProps = useFileDrag({
		absolutePath: isRemote ? null : entry.path,
	});
	const uploadDestination = isFolder
		? entry.relativePath
		: getRelativeParent(entry.relativePath);

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isFolder) {
			if (isExpanded) {
				item.collapse();
			} else {
				item.expand();
			}
		} else {
			onActivate(entry);
		}
	};

	const handleDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isRemote) {
			if (!isFolder) onActivate(entry);
			return;
		}
		onOpenInEditor(entry);
	};

	const handleDragOver = (event: React.DragEvent) => {
		if (!isRemote || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "copy";
		setIsNativeDragOver(true);
	};

	const handleDragStart = (event: React.DragEvent) => {
		if (!isRemote) {
			localFileDragProps.onDragStart(event);
			return;
		}
		event.dataTransfer.setData("text/plain", `./${entry.relativePath}`);
		event.dataTransfer.setData(
			"application/x-ade-remote-file-path",
			entry.path,
		);
		event.dataTransfer.effectAllowed = "copy";
	};

	const handleCopyPath = () => {
		if (isRemote) {
			navigator.clipboard.writeText(entry.path);
			return;
		}
		localPathActions.copyPath();
	};

	const handleCopyRelativePath = () => {
		if (isRemote) {
			navigator.clipboard.writeText(entry.relativePath);
			return;
		}
		localPathActions.copyRelativePath();
	};

	const handleDragLeave = (event: React.DragEvent) => {
		if (!isNativeDragOver) return;
		const nextTarget = event.relatedTarget;
		if (
			nextTarget instanceof Node &&
			event.currentTarget.contains(nextTarget)
		) {
			return;
		}
		setIsNativeDragOver(false);
	};

	const handleDrop = (event: React.DragEvent) => {
		if (!isRemote || !onUploadLocalPaths) return;
		const files = Array.from(event.dataTransfer.files);
		if (files.length === 0) return;
		event.preventDefault();
		event.stopPropagation();
		setIsNativeDragOver(false);
		try {
			const localPaths = files
				.map((file) => window.webUtils.getPathForFile(file))
				.filter(Boolean);
			if (localPaths.length > 0) {
				onUploadLocalPaths(uploadDestination, localPaths);
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not read the dropped file paths",
			);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (isFolder) {
				if (isExpanded) {
					item.collapse();
				} else {
					item.expand();
				}
			} else {
				onActivate(entry);
			}
		}
	};

	const itemContent = (
		<div
			{...item.getProps()}
			draggable={isRemote || localFileDragProps.draggable}
			data-item-id={item.getId()}
			style={{
				height: rowHeight,
				paddingLeft: level * indent,
			}}
			role="treeitem"
			tabIndex={0}
			aria-expanded={isFolder ? isExpanded : undefined}
			className={cn(
				"flex items-center gap-1 px-1 cursor-pointer select-none",
				"hover:bg-accent/50 transition-colors",
				item.isSelected() && "bg-accent",
				isNativeDragOver && "bg-primary/10 ring-1 ring-inset ring-primary/50",
			)}
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			onKeyDown={handleKeyDown}
			onDragStart={handleDragStart}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<span className="flex items-center justify-center w-4 h-4 shrink-0">
				{isFolder ? (
					isExpanded ? (
						<LuChevronDown className="size-3.5 text-muted-foreground" />
					) : (
						<LuChevronRight className="size-3.5 text-muted-foreground" />
					)
				) : null}
			</span>

			<Icon className={cn("size-4 shrink-0", color)} />

			<span className="flex-1 min-w-0 text-xs truncate">{entry.name}</span>
		</div>
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{itemContent}</ContextMenuTrigger>
			<ContextMenuContent className="w-48">
				<ContextMenuItem onClick={() => onNewFile(parentPath)}>
					<LuFile className="mr-2 size-4" />
					New File
				</ContextMenuItem>
				<ContextMenuItem onClick={() => onNewFolder(parentPath)}>
					<LuFolder className="mr-2 size-4" />
					New Folder
				</ContextMenuItem>

				<ContextMenuSeparator />

				<ContextMenuItem onClick={handleCopyPath}>
					<LuClipboard className="mr-2 size-4" />
					Copy Path
				</ContextMenuItem>
				<ContextMenuItem onClick={handleCopyRelativePath}>
					<LuCopy className="mr-2 size-4" />
					Copy Relative Path
				</ContextMenuItem>

				<ContextMenuSeparator />

				{isRemote ? (
					onDownload ? (
						<ContextMenuItem onClick={() => onDownload(entry)}>
							<LuDownload className="mr-2 size-4" />
							Download…
						</ContextMenuItem>
					) : null
				) : (
					<>
						<ContextMenuItem onClick={localPathActions.revealInFinder}>
							<LuFolderOpen className="mr-2 size-4" />
							Reveal in Finder
						</ContextMenuItem>
						<ContextMenuItem onClick={localPathActions.openInEditor}>
							<LuExternalLink className="mr-2 size-4" />
							Open in Editor
						</ContextMenuItem>
					</>
				)}

				<ContextMenuSeparator />

				<ContextMenuItem onClick={() => onRename(entry)}>
					<LuPencil className="mr-2 size-4" />
					Rename
				</ContextMenuItem>
				<ContextMenuItem
					onClick={() => onDelete(entry)}
					className="text-destructive focus:text-destructive"
				>
					<LuTrash2 className="mr-2 size-4" />
					Delete
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
