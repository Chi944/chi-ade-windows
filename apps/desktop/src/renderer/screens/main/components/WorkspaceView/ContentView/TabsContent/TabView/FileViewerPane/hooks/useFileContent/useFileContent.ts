import { useEffect, useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ChangeCategory } from "shared/changes-types";
import { isImageFile } from "shared/file-types";

interface UseFileContentParams {
	workspaceId: string;
	isRemoteWorkspace: boolean;
	isRemoteBindingLoading: boolean;
	remoteTransportToken: string | null;
	worktreePath: string;
	filePath: string;
	/** Absolute path for out-of-worktree files (e.g. agent memory). When set,
	 * raw content is read by absolute path instead of the worktree-relative path. */
	absolutePath?: string;
	viewMode: "raw" | "diff" | "rendered";
	diffCategory?: ChangeCategory;
	commitHash?: string;
	oldPath?: string;
	isDirty: boolean;
	originalContentRef: React.MutableRefObject<string>;
	baselineLoadedRef: React.MutableRefObject<boolean>;
	remoteRevisionRef: React.MutableRefObject<string | null>;
	originalDiffContentRef: React.MutableRefObject<string>;
}

export function useFileContent({
	workspaceId,
	isRemoteWorkspace,
	isRemoteBindingLoading,
	remoteTransportToken,
	worktreePath,
	filePath,
	absolutePath,
	viewMode,
	diffCategory,
	commitHash,
	oldPath,
	isDirty,
	originalContentRef,
	baselineLoadedRef,
	remoteRevisionRef,
	originalDiffContentRef,
}: UseFileContentParams) {
	// For remote URLs (e.g. Vercel Blob), skip all IPC queries
	const isRemoteUrl =
		filePath.startsWith("https://") || filePath.startsWith("http://");

	// Out-of-worktree files (e.g. agent memory) are read by absolute path.
	const isAbsolute = !!absolutePath;

	const { data: branchData } = electronTrpc.changes.getBranches.useQuery(
		{ worktreePath },
		{
			enabled:
				!isRemoteBindingLoading &&
				!isRemoteWorkspace &&
				!isRemoteUrl &&
				!!worktreePath &&
				diffCategory === "against-base",
		},
	);
	const effectiveBaseBranch =
		branchData?.worktreeBaseBranch ?? branchData?.defaultBranch ?? "main";

	const isImage = isImageFile(filePath);

	const { data: workingFileData, isLoading: isLoadingWorkingFile } =
		electronTrpc.changes.readWorkingFile.useQuery(
			{ worktreePath, filePath },
			{
				enabled:
					!isRemoteBindingLoading &&
					!isRemoteWorkspace &&
					!isRemoteUrl &&
					!isAbsolute &&
					viewMode !== "diff" &&
					!isImage &&
					!!filePath &&
					!!worktreePath,
			},
		);

	const { data: absoluteFileData, isLoading: isLoadingAbsolute } =
		electronTrpc.filesystem.readFileByPath.useQuery(
			{ absolutePath: absolutePath ?? "" },
			{
				enabled:
					!isRemoteBindingLoading &&
					!isRemoteWorkspace &&
					!isRemoteUrl &&
					isAbsolute &&
					viewMode !== "diff" &&
					!isImage &&
					!!absolutePath,
			},
		);

	const {
		data: remoteFileData,
		isLoading: isLoadingRemoteFile,
		error: remoteFileError,
	} = electronTrpc.remote.readFile.useQuery(
		{
			workspaceId,
			relativePath: filePath,
			transportToken: remoteTransportToken ?? "",
		},
		{
			enabled:
				!isRemoteBindingLoading &&
				isRemoteWorkspace &&
				!!remoteTransportToken &&
				viewMode !== "diff" &&
				!isImage &&
				!!filePath,
		},
	);

	const rawFileData = isRemoteWorkspace
		? remoteFileData
		: isAbsolute
			? absoluteFileData
			: workingFileData;
	const isLoadingRaw =
		isRemoteBindingLoading ||
		(isRemoteWorkspace
			? isLoadingRemoteFile
			: isAbsolute
				? isLoadingAbsolute
				: isLoadingWorkingFile);

	const { data: localImageData, isLoading: isLoadingLocalImage } =
		electronTrpc.changes.readWorkingFileImage.useQuery(
			{ worktreePath, filePath },
			{
				enabled:
					!isRemoteBindingLoading &&
					!isRemoteWorkspace &&
					!isRemoteUrl &&
					viewMode === "rendered" &&
					isImage &&
					!!filePath &&
					!!worktreePath,
			},
		);
	const {
		data: remoteImageData,
		isLoading: isLoadingRemoteImage,
		error: remoteImageError,
	} = electronTrpc.remote.readImage.useQuery(
		{
			workspaceId,
			relativePath: filePath,
			transportToken: remoteTransportToken ?? "",
		},
		{
			enabled:
				!isRemoteBindingLoading &&
				isRemoteWorkspace &&
				!!remoteTransportToken &&
				viewMode === "rendered" &&
				isImage &&
				!!filePath,
		},
	);

	const { data: diffData, isLoading: isLoadingDiff } =
		electronTrpc.changes.getFileContents.useQuery(
			{
				worktreePath,
				filePath,
				oldPath,
				category: diffCategory ?? "unstaged",
				commitHash,
				defaultBranch:
					diffCategory === "against-base" ? effectiveBaseBranch : undefined,
			},
			{
				enabled:
					!isRemoteBindingLoading &&
					!isRemoteWorkspace &&
					!isRemoteUrl &&
					viewMode === "diff" &&
					!!diffCategory &&
					!!filePath &&
					!!worktreePath,
			},
		);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Only update baseline when content loads
	useEffect(() => {
		if (rawFileData?.ok === true && !isDirty) {
			originalContentRef.current = rawFileData.content;
			baselineLoadedRef.current = true;
			remoteRevisionRef.current =
				"revision" in rawFileData ? rawFileData.revision : null;
		}
	}, [rawFileData]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Only update baseline when diff loads
	useEffect(() => {
		if (diffData && !isDirty) {
			originalDiffContentRef.current = diffData.modified;
		}
	}, [diffData]);

	// For remote URLs, return the URL directly as imageData (works with <img src=>)
	const urlImageData = useMemo(
		() =>
			isRemoteUrl
				? { ok: true as const, dataUrl: filePath, byteLength: 0 }
				: undefined,
		[isRemoteUrl, filePath],
	);
	const imageData = isRemoteUrl
		? urlImageData
		: isRemoteWorkspace
			? remoteImageData
			: localImageData;
	const isLoadingImage = isRemoteUrl
		? false
		: isRemoteBindingLoading ||
			(isRemoteWorkspace ? isLoadingRemoteImage : isLoadingLocalImage);

	return {
		rawFileData,
		isLoadingRaw: isLoadingRaw || (isImage && isLoadingImage),
		imageData,
		isLoadingImage,
		loadError:
			(remoteFileError instanceof Error
				? remoteFileError.message
				: undefined) ??
			(remoteImageError instanceof Error
				? remoteImageError.message
				: undefined),
		diffData,
		isLoadingDiff,
	};
}
