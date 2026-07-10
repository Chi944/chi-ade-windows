import {
	asyncDataLoaderFeature,
	expandAllFeature,
	type ItemInstance,
	selectionFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { toast } from "@superset/ui/sonner";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuFile, LuFolder, LuUpload } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useFileExplorerStore } from "renderer/stores/file-explorer";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { DirectoryEntry } from "shared/file-tree-types";
import { DeleteConfirmDialog } from "./components/DeleteConfirmDialog";
import { FileSearchResultItem } from "./components/FileSearchResultItem";
import { FileTreeItem } from "./components/FileTreeItem";
import { FileTreeToolbar } from "./components/FileTreeToolbar";
import { NewItemInput } from "./components/NewItemInput";
import { RenameInput } from "./components/RenameInput";
import { ROW_HEIGHT, TREE_INDENT } from "./constants";
import { useFileSearch } from "./hooks/useFileSearch";
import { useFileTreeActions } from "./hooks/useFileTreeActions";
import type { NewItemMode } from "./types";

function getRelativeParent(relativePath: string): string {
	const separator = relativePath.lastIndexOf("/");
	return separator < 0 ? "" : relativePath.slice(0, separator);
}

function encodeTreeEntry(entry: DirectoryEntry): string {
	return encodeURIComponent(JSON.stringify(entry));
}

function decodeTreeEntry(itemId: string): DirectoryEntry {
	const entry = JSON.parse(decodeURIComponent(itemId)) as DirectoryEntry;
	return { ...entry, id: itemId };
}

export function FilesView() {
	const { workspaceId } = useParams({ strict: false });
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const {
		data: remoteBinding,
		isPending: isRemoteBindingPending,
		isError: isRemoteBindingError,
	} = electronTrpc.remote.binding.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const worktreePath = workspace?.worktreePath;
	const isRemote = !!remoteBinding;

	const [searchTerm, setSearchTerm] = useState("");
	const [treeError, setTreeError] = useState<string | null>(null);
	const projectId = workspace?.project?.id;
	const showHiddenFiles = useFileExplorerStore((s) =>
		projectId ? (s.showHiddenFiles[projectId] ?? false) : false,
	);
	const toggleHiddenFiles = useFileExplorerStore((s) => s.toggleHiddenFiles);

	// Refs avoid stale closure in dataLoader callbacks
	const worktreePathRef = useRef(worktreePath);
	worktreePathRef.current = worktreePath;
	const workspaceIdRef = useRef(workspaceId);
	workspaceIdRef.current = workspaceId;
	const remoteBindingRef = useRef(remoteBinding);
	remoteBindingRef.current = remoteBinding;
	const remoteBindingPendingRef = useRef(isRemoteBindingPending);
	remoteBindingPendingRef.current = isRemoteBindingPending;
	const showHiddenFilesRef = useRef(showHiddenFiles);
	showHiddenFilesRef.current = showHiddenFiles;

	const trpcUtils = electronTrpc.useUtils();

	const tree = useTree<DirectoryEntry>({
		rootItemId: "root",
		getItemName: (item: ItemInstance<DirectoryEntry>) =>
			item.getItemData()?.name ?? "",
		isItemFolder: (item: ItemInstance<DirectoryEntry>) =>
			item.getItemData()?.isDirectory ?? false,
		dataLoader: {
			getItem: async (itemId: string): Promise<DirectoryEntry> => {
				if (itemId === "root") {
					return {
						id: "root",
						name: "root",
						path:
							remoteBindingRef.current?.effectiveRemoteRoot ??
							worktreePathRef.current ??
							"",
						relativePath: "",
						isDirectory: true,
					};
				}
				return decodeTreeEntry(itemId);
			},
			getChildren: async (itemId: string): Promise<string[]> => {
				const currentPath = worktreePathRef.current;
				const currentWorkspaceId = workspaceIdRef.current;
				if (
					!currentPath ||
					!currentWorkspaceId ||
					remoteBindingPendingRef.current
				) {
					return [];
				}

				const currentEntry = itemId === "root" ? null : decodeTreeEntry(itemId);

				try {
					const entries = remoteBindingRef.current
						? await trpcUtils.remote.readDirectory.fetch({
								workspaceId: currentWorkspaceId,
								relativePath: currentEntry?.relativePath ?? "",
								includeHidden: showHiddenFilesRef.current,
								transportToken: remoteBindingRef.current.transportToken,
							})
						: await trpcUtils.filesystem.readDirectory.fetch({
								dirPath: currentEntry?.path ?? currentPath,
								rootPath: currentPath,
								includeHidden: showHiddenFilesRef.current,
							});
					if (remoteBindingRef.current) setTreeError(null);
					return entries.map(encodeTreeEntry);
				} catch (error) {
					console.error("[FilesView] Failed to load children:", error);
					if (remoteBindingRef.current) {
						setTreeError(
							error instanceof Error
								? error.message
								: "Could not load the remote directory",
						);
					}
					return [];
				}
			},
		},
		features: [asyncDataLoaderFeature, selectionFeature, expandAllFeature],
	});

	const rootIdentity = isRemoteBindingPending
		? `loading:${workspaceId ?? ""}`
		: remoteBinding
			? `remote:${remoteBinding.transportToken}`
			: `local:${worktreePath ?? ""}`;
	const previousRootIdentityRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (
			previousRootIdentityRef.current !== undefined &&
			previousRootIdentityRef.current !== rootIdentity
		) {
			tree.collapseAll();
			tree.setSelectedItems([]);
			tree.getItemInstance("root")?.invalidateChildrenIds();
		}
		previousRootIdentityRef.current = rootIdentity;
	}, [rootIdentity, tree]);

	const { createFile, createDirectory, rename, deleteItems, isDeleting } =
		useFileTreeActions({
			worktreePath,
			onRefresh: async (parentPath: string) => {
				const isRoot = parentPath === worktreePath;
				const itemId = isRoot
					? "root"
					: tree
							.getItems()
							.find(
								(item: ItemInstance<DirectoryEntry>) =>
									item.getItemData()?.path === parentPath,
							)
							?.getId();
				if (itemId) {
					await tree.getItemInstance(itemId)?.invalidateChildrenIds();
				}
			},
		});

	const refreshRemoteDirectory = useCallback(
		async (relativePath: string) => {
			const itemId =
				relativePath === ""
					? "root"
					: tree
							.getItems()
							.find(
								(item: ItemInstance<DirectoryEntry>) =>
									item.getItemData()?.relativePath === relativePath,
							)
							?.getId();
			if (itemId) {
				await tree.getItemInstance(itemId)?.invalidateChildrenIds();
			}
		},
		[tree],
	);

	const remoteCreateFile = electronTrpc.remote.createFile.useMutation({
		onSuccess: async (_data, variables) => {
			toast.success(`Created ${variables.name}`);
			await refreshRemoteDirectory(variables.parentRelativePath ?? "");
		},
		onError: (error) => toast.error(`Failed to create file: ${error.message}`),
	});
	const remoteCreateDirectory = electronTrpc.remote.createDirectory.useMutation(
		{
			onSuccess: async (_data, variables) => {
				toast.success(`Created ${variables.name}`);
				await refreshRemoteDirectory(variables.parentRelativePath ?? "");
			},
			onError: (error) =>
				toast.error(`Failed to create folder: ${error.message}`),
		},
	);
	const remoteRename = electronTrpc.remote.renameEntry.useMutation({
		onSuccess: async (_data, variables) => {
			toast.success(`Renamed to ${variables.newName}`);
			await refreshRemoteDirectory(getRelativeParent(variables.relativePath));
		},
		onError: (error) => toast.error(`Failed to rename: ${error.message}`),
	});
	const remoteRemove = electronTrpc.remote.removeEntry.useMutation({
		onSuccess: async (_data, variables) => {
			toast.success("Remote item deleted");
			await refreshRemoteDirectory(getRelativeParent(variables.relativePath));
		},
		onError: (error) => toast.error(`Failed to delete: ${error.message}`),
	});
	const remotePickAndUpload = electronTrpc.remote.pickAndUpload.useMutation({
		onSuccess: async (data, variables) => {
			if (data.canceled) return;
			toast.success(
				data.uploaded.length === 1
					? "File uploaded"
					: `${data.uploaded.length} files uploaded`,
			);
			await Promise.all([
				trpcUtils.remote.readFile.invalidate(),
				trpcUtils.remote.readImage.invalidate(),
			]);
			await refreshRemoteDirectory(variables.destinationRelativePath ?? "");
		},
		onError: (error) => toast.error(`Failed to upload: ${error.message}`),
	});
	const remoteUploadLocalPaths =
		electronTrpc.remote.uploadLocalPaths.useMutation({
			onSuccess: async (_data, variables) => {
				toast.success(
					variables.localPaths.length === 1
						? "File uploaded"
						: `${variables.localPaths.length} files uploaded`,
				);
				await Promise.all([
					trpcUtils.remote.readFile.invalidate(),
					trpcUtils.remote.readImage.invalidate(),
				]);
				await refreshRemoteDirectory(variables.destinationRelativePath ?? "");
			},
			onError: (error) => toast.error(`Failed to upload: ${error.message}`),
		});
	const remoteDownload = electronTrpc.remote.download.useMutation({
		onError: (error) => toast.error(`Failed to download: ${error.message}`),
	});

	const {
		searchResults,
		isFetching: isSearchFetching,
		hasQuery: isSearching,
	} = useFileSearch({
		worktreePath: isRemote ? undefined : worktreePath,
		searchTerm: isRemote ? "" : searchTerm,
		includeHidden: showHiddenFiles,
	});

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const openFileInEditorMutation =
		electronTrpc.external.openFileInEditor.useMutation();

	const [newItemMode, setNewItemMode] = useState<NewItemMode>(null);
	const [newItemParentPath, setNewItemParentPath] = useState<string>("");
	const [renameEntry, setRenameEntry] = useState<DirectoryEntry | null>(null);
	const [deleteEntry, setDeleteEntry] = useState<DirectoryEntry | null>(null);
	const [showDeleteDialog, setShowDeleteDialog] = useState(false);
	const [isRootDragOver, setIsRootDragOver] = useState(false);

	const handleFileActivate = useCallback(
		(entry: DirectoryEntry) => {
			if (!workspaceId || !worktreePath || entry.isDirectory) return;
			addFileViewerPane(workspaceId, {
				filePath: entry.relativePath,
			});
		},
		[workspaceId, worktreePath, addFileViewerPane],
	);

	const handleOpenInEditor = useCallback(
		(entry: DirectoryEntry) => {
			if (!worktreePath) return;
			openFileInEditorMutation.mutate({
				path: entry.path,
				cwd: worktreePath,
				projectId,
			});
		},
		[worktreePath, projectId, openFileInEditorMutation],
	);

	const handleNewFile = useCallback(
		async (parentPath: string) => {
			const rootPath = isRemote ? "" : worktreePath;
			if (parentPath !== rootPath) {
				const item = tree
					.getItems()
					.find((i: ItemInstance<DirectoryEntry>) =>
						isRemote
							? i.getItemData()?.relativePath === parentPath
							: i.getItemData()?.path === parentPath,
					);
				if (item && !item.isExpanded()) {
					await item.expand();
				}
			}
			setNewItemMode("file");
			setNewItemParentPath(parentPath);
		},
		[isRemote, worktreePath, tree],
	);

	const handleNewFolder = useCallback(
		async (parentPath: string) => {
			const rootPath = isRemote ? "" : worktreePath;
			if (parentPath !== rootPath) {
				const item = tree
					.getItems()
					.find((i: ItemInstance<DirectoryEntry>) =>
						isRemote
							? i.getItemData()?.relativePath === parentPath
							: i.getItemData()?.path === parentPath,
					);
				if (item && !item.isExpanded()) {
					await item.expand();
				}
			}
			setNewItemMode("folder");
			setNewItemParentPath(parentPath);
		},
		[isRemote, worktreePath, tree],
	);

	const handleNewItemSubmit = useCallback(
		(name: string) => {
			if (newItemMode === "file") {
				if (remoteBinding && workspaceId) {
					remoteCreateFile.mutate({
						workspaceId,
						parentRelativePath: newItemParentPath,
						name,
						transportToken: remoteBinding.transportToken,
					});
				} else {
					createFile(newItemParentPath, name);
				}
			} else if (newItemMode === "folder") {
				if (remoteBinding && workspaceId) {
					remoteCreateDirectory.mutate({
						workspaceId,
						parentRelativePath: newItemParentPath,
						name,
						transportToken: remoteBinding.transportToken,
					});
				} else {
					createDirectory(newItemParentPath, name);
				}
			}
			setNewItemMode(null);
			setNewItemParentPath("");
		},
		[
			newItemMode,
			newItemParentPath,
			remoteBinding,
			workspaceId,
			remoteCreateFile,
			remoteCreateDirectory,
			createFile,
			createDirectory,
		],
	);

	const handleNewItemCancel = useCallback(() => {
		setNewItemMode(null);
		setNewItemParentPath("");
	}, []);

	const handleDeleteRequest = useCallback((entry: DirectoryEntry) => {
		setDeleteEntry(entry);
		setShowDeleteDialog(true);
	}, []);

	const handleDeleteConfirm = useCallback(() => {
		if (deleteEntry) {
			if (remoteBinding && workspaceId) {
				remoteRemove.mutate({
					workspaceId,
					relativePath: deleteEntry.relativePath,
					transportToken: remoteBinding.transportToken,
				});
			} else {
				deleteItems([deleteEntry.path]);
			}
		}
		setShowDeleteDialog(false);
		setDeleteEntry(null);
	}, [deleteEntry, remoteBinding, workspaceId, remoteRemove, deleteItems]);

	const handleRename = useCallback((entry: DirectoryEntry) => {
		setRenameEntry(entry);
	}, []);

	const handleRenameSubmit = useCallback(
		(newName: string) => {
			if (renameEntry) {
				if (remoteBinding && workspaceId) {
					remoteRename.mutate({
						workspaceId,
						relativePath: renameEntry.relativePath,
						newName,
						transportToken: remoteBinding.transportToken,
					});
				} else {
					rename(renameEntry.path, newName);
				}
			}
			setRenameEntry(null);
		},
		[renameEntry, remoteBinding, workspaceId, remoteRename, rename],
	);

	const handleRenameCancel = useCallback(() => {
		setRenameEntry(null);
	}, []);

	const getSelectedUploadDestination = useCallback(() => {
		const selectedEntry = tree.getSelectedItems()[0]?.getItemData();
		if (!selectedEntry) return "";
		return selectedEntry.isDirectory
			? selectedEntry.relativePath
			: getRelativeParent(selectedEntry.relativePath);
	}, [tree]);

	const handlePickAndUpload = useCallback(() => {
		if (!workspaceId || !remoteBinding) return;
		remotePickAndUpload.mutate({
			workspaceId,
			destinationRelativePath: getSelectedUploadDestination(),
			transportToken: remoteBinding.transportToken,
		});
	}, [
		workspaceId,
		remoteBinding,
		remotePickAndUpload,
		getSelectedUploadDestination,
	]);

	const handleUploadLocalPaths = useCallback(
		(destinationRelativePath: string, localPaths: string[]) => {
			if (!workspaceId || !remoteBinding || localPaths.length === 0) return;
			remoteUploadLocalPaths.mutate({
				workspaceId,
				destinationRelativePath,
				localPaths,
				transportToken: remoteBinding.transportToken,
			});
		},
		[workspaceId, remoteBinding, remoteUploadLocalPaths],
	);

	const handleDownload = useCallback(
		(entry: DirectoryEntry) => {
			if (!workspaceId || !remoteBinding) return;
			remoteDownload.mutate({
				workspaceId,
				relativePath: entry.relativePath,
				transportToken: remoteBinding.transportToken,
			});
		},
		[workspaceId, remoteBinding, remoteDownload],
	);

	const handleRootDragOver = useCallback(
		(event: React.DragEvent) => {
			if (!isRemote || !event.dataTransfer.types.includes("Files")) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			setIsRootDragOver(true);
		},
		[isRemote],
	);

	const handleRootDragLeave = useCallback((event: React.DragEvent) => {
		const nextTarget = event.relatedTarget;
		if (
			nextTarget instanceof Node &&
			event.currentTarget.contains(nextTarget)
		) {
			return;
		}
		setIsRootDragOver(false);
	}, []);

	const handleRootDrop = useCallback(
		(event: React.DragEvent) => {
			if (!isRemote) return;
			const files = Array.from(event.dataTransfer.files);
			if (files.length === 0) return;
			event.preventDefault();
			setIsRootDragOver(false);
			try {
				const localPaths = files
					.map((file) => window.webUtils.getPathForFile(file))
					.filter(Boolean);
				handleUploadLocalPaths("", localPaths);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Could not read the dropped file paths",
				);
			}
		},
		[isRemote, handleUploadLocalPaths],
	);

	const handleCollapseAll = useCallback(() => {
		tree.collapseAll();
	}, [tree]);

	const handleRefresh = useCallback(() => {
		setTreeError(null);
		// Invalidate root explicitly (getItems() may not include it)
		tree.getItemInstance("root")?.invalidateChildrenIds();
		// Also invalidate all expanded directories so new files in nested folders appear
		for (const item of tree.getItems()) {
			if (item.getItemData()?.isDirectory) {
				item.invalidateChildrenIds();
			}
		}
	}, [tree]);

	useEffect(() => {
		if (isRemote) setSearchTerm("");
	}, [isRemote]);

	const handleToggleHiddenFiles = useCallback(() => {
		if (!projectId) return;
		// Update ref synchronously so invalidation uses correct value
		showHiddenFilesRef.current = !showHiddenFilesRef.current;
		toggleHiddenFiles(projectId);
		// invalidateChildrenIds doesn't cascade, so invalidate every directory
		tree.getItemInstance("root")?.invalidateChildrenIds();
		for (const item of tree.getItems()) {
			if (item.getItemData()?.isDirectory) {
				item.invalidateChildrenIds();
			}
		}
	}, [tree, projectId, toggleHiddenFiles]);

	const searchResultEntries = useMemo(() => {
		return searchResults.map((result) => ({
			id: result.id,
			name: result.name,
			path: result.path,
			relativePath: result.relativePath,
			isDirectory: result.isDirectory,
		}));
	}, [searchResults]);

	if (!worktreePath) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				No agent selected
			</div>
		);
	}
	if (workspaceId && isRemoteBindingPending) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				Loading workspace files...
			</div>
		);
	}
	if (isRemoteBindingError) {
		return (
			<div className="flex-1 flex items-center justify-center text-destructive text-sm p-4 text-center">
				Could not determine whether this workspace uses local or remote files.
			</div>
		);
	}

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<FileTreeToolbar
				searchTerm={searchTerm}
				onSearchChange={setSearchTerm}
				onNewFile={() => handleNewFile(isRemote ? "" : worktreePath)}
				onNewFolder={() => handleNewFolder(isRemote ? "" : worktreePath)}
				onCollapseAll={handleCollapseAll}
				onRefresh={handleRefresh}
				showHiddenFiles={showHiddenFiles}
				onToggleHiddenFiles={handleToggleHiddenFiles}
				searchDisabled={isRemote}
				onUpload={isRemote ? handlePickAndUpload : undefined}
				isUploading={
					remotePickAndUpload.isPending || remoteUploadLocalPaths.isPending
				}
			/>

			<div className="flex-1 min-h-0 overflow-hidden">
				<ContextMenu>
					<ContextMenuTrigger asChild className="h-full">
						<section
							aria-label="File explorer"
							className={`h-full overflow-auto ${
								isRootDragOver
									? "ring-1 ring-inset ring-primary/50 bg-primary/5"
									: ""
							}`}
							onDragOver={handleRootDragOver}
							onDragLeave={handleRootDragLeave}
							onDrop={handleRootDrop}
						>
							{treeError && (
								<div className="m-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
									<p>{treeError}</p>
									<button
										type="button"
										className="mt-2 underline underline-offset-2"
										onClick={handleRefresh}
									>
										Retry
									</button>
								</div>
							)}
							{newItemMode &&
								newItemParentPath === (isRemote ? "" : worktreePath) && (
									<NewItemInput
										mode={newItemMode}
										parentPath={newItemParentPath}
										onSubmit={handleNewItemSubmit}
										onCancel={handleNewItemCancel}
									/>
								)}

							{isSearching ? (
								searchResultEntries.length > 0 ? (
									<div className="flex flex-col">
										{searchResultEntries.map((entry) =>
											renameEntry?.path === entry.path ? (
												<RenameInput
													key={entry.id}
													entry={entry}
													onSubmit={handleRenameSubmit}
													onCancel={handleRenameCancel}
												/>
											) : (
												<FileSearchResultItem
													key={entry.id}
													entry={entry}
													worktreePath={worktreePath}
													projectId={projectId}
													onActivate={handleFileActivate}
													onOpenInEditor={handleOpenInEditor}
													onNewFile={handleNewFile}
													onNewFolder={handleNewFolder}
													onRename={handleRename}
													onDelete={handleDeleteRequest}
												/>
											),
										)}
									</div>
								) : (
									<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
										{isSearchFetching
											? "Searching files..."
											: "No matching files"}
									</div>
								)
							) : (
								<div {...tree.getContainerProps()} className="outline-none">
									{tree.getItems().map((item: ItemInstance<DirectoryEntry>) => {
										const data = item.getItemData();
										if (!data || item.getId() === "root") return null;
										const showNewItemInput =
											newItemMode &&
											data.isDirectory &&
											(isRemote
												? data.relativePath === newItemParentPath
												: data.path === newItemParentPath);
										const isRenaming = renameEntry?.path === data.path;
										return (
											<div key={item.getId()}>
												{isRenaming ? (
													<RenameInput
														entry={data}
														onSubmit={handleRenameSubmit}
														onCancel={handleRenameCancel}
														level={item.getItemMeta().level}
													/>
												) : (
													<FileTreeItem
														item={item}
														entry={data}
														rowHeight={ROW_HEIGHT}
														indent={TREE_INDENT}
														worktreePath={worktreePath}
														projectId={projectId}
														onActivate={handleFileActivate}
														onOpenInEditor={handleOpenInEditor}
														onNewFile={handleNewFile}
														onNewFolder={handleNewFolder}
														onRename={handleRename}
														onDelete={handleDeleteRequest}
														isRemote={isRemote}
														onDownload={handleDownload}
														onUploadLocalPaths={handleUploadLocalPaths}
													/>
												)}
												{showNewItemInput && (
													<NewItemInput
														mode={newItemMode}
														parentPath={newItemParentPath}
														onSubmit={handleNewItemSubmit}
														onCancel={handleNewItemCancel}
														level={item.getItemMeta().level + 1}
													/>
												)}
											</div>
										);
									})}
								</div>
							)}
						</section>
					</ContextMenuTrigger>
					<ContextMenuContent className="w-48">
						<ContextMenuItem
							onClick={() => handleNewFile(isRemote ? "" : worktreePath)}
						>
							<LuFile className="mr-2 size-4" />
							New File
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() => handleNewFolder(isRemote ? "" : worktreePath)}
						>
							<LuFolder className="mr-2 size-4" />
							New Folder
						</ContextMenuItem>
						{isRemote && (
							<ContextMenuItem onClick={handlePickAndUpload}>
								<LuUpload className="mr-2 size-4" />
								Upload…
							</ContextMenuItem>
						)}
					</ContextMenuContent>
				</ContextMenu>
			</div>

			<DeleteConfirmDialog
				entry={deleteEntry}
				open={showDeleteDialog}
				onOpenChange={setShowDeleteDialog}
				onConfirm={handleDeleteConfirm}
				isDeleting={isDeleting || remoteRemove.isPending}
				isPermanent={isRemote}
			/>
		</div>
	);
}
