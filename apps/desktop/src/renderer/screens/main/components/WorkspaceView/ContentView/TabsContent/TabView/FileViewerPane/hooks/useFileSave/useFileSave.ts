import { toast } from "@superset/ui/sonner";
import type * as Monaco from "monaco-editor";
import { type MutableRefObject, useCallback, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { ChangeCategory } from "shared/changes-types";

interface UseFileSaveParams {
	workspaceId: string;
	isRemoteWorkspace: boolean;
	isRemoteBindingLoading: boolean;
	remoteTransportToken: string | null;
	worktreePath: string;
	filePath: string;
	paneId: string;
	diffCategory?: ChangeCategory;
	editorRef: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>;
	originalContentRef: MutableRefObject<string>;
	remoteRevisionRef: MutableRefObject<string | null>;
	originalDiffContentRef: MutableRefObject<string>;
	draftContentRef: MutableRefObject<string | null>;
	setIsDirty: (dirty: boolean) => void;
}

export function useFileSave({
	workspaceId,
	isRemoteWorkspace,
	isRemoteBindingLoading,
	remoteTransportToken,
	worktreePath,
	filePath,
	paneId,
	diffCategory,
	editorRef,
	originalContentRef,
	remoteRevisionRef,
	originalDiffContentRef,
	draftContentRef,
	setIsDirty,
}: UseFileSaveParams) {
	const savingFromRawRef = useRef(false);
	const savingDiffContentRef = useRef<string | null>(null);
	const utils = electronTrpc.useUtils();

	const handleSaveSuccess = (revision?: string) => {
		setIsDirty(false);
		if (revision) remoteRevisionRef.current = revision;
		if (editorRef.current) {
			originalContentRef.current = editorRef.current.getValue();
		}
		if (savingDiffContentRef.current !== null) {
			originalDiffContentRef.current = savingDiffContentRef.current;
			savingDiffContentRef.current = null;
		}
		if (savingFromRawRef.current) {
			draftContentRef.current = null;
		}
		savingFromRawRef.current = false;

		utils.changes.readWorkingFile.invalidate();
		utils.changes.getFileContents.invalidate();
		utils.changes.getStatus.invalidate();

		if (diffCategory === "staged") {
			const panes = useTabsStore.getState().panes;
			const currentPane = panes[paneId];
			if (currentPane?.fileViewer) {
				useTabsStore.setState({
					panes: {
						...panes,
						[paneId]: {
							...currentPane,
							fileViewer: {
								...currentPane.fileViewer,
								diffCategory: "unstaged",
							},
						},
					},
				});
			}
		}
	};

	const saveFileMutation = electronTrpc.changes.saveFile.useMutation({
		onSuccess: () => handleSaveSuccess(),
	});
	const saveRemoteFileMutation = electronTrpc.remote.writeFile.useMutation({
		onSuccess: (result) => {
			handleSaveSuccess(result.revision);
			utils.remote.readFile.invalidate();
			utils.remote.readDirectory.invalidate();
		},
		onError: (error) => toast.error(`Remote save failed: ${error.message}`),
	});

	const handleSaveRaw = useCallback(async () => {
		if (!editorRef.current || !filePath || !worktreePath) return;
		if (isRemoteBindingLoading) {
			toast.error("Wait for the workspace transport to finish loading");
			return;
		}
		savingFromRawRef.current = true;
		const content = editorRef.current.getValue();
		if (isRemoteWorkspace) {
			if (!remoteRevisionRef.current || !remoteTransportToken) {
				toast.error("Reload the remote file before saving");
				return;
			}
			await saveRemoteFileMutation.mutateAsync({
				workspaceId,
				relativePath: filePath,
				content,
				expectedRevision: remoteRevisionRef.current,
				transportToken: remoteTransportToken,
			});
			return;
		}
		await saveFileMutation.mutateAsync({ worktreePath, filePath, content });
	}, [
		worktreePath,
		filePath,
		isRemoteWorkspace,
		isRemoteBindingLoading,
		remoteTransportToken,
		workspaceId,
		saveFileMutation,
		saveRemoteFileMutation,
		editorRef,
		remoteRevisionRef,
	]);

	const handleSaveDiff = useCallback(
		async (content: string) => {
			if (!filePath || !worktreePath || isRemoteWorkspace) return;
			savingFromRawRef.current = false;
			savingDiffContentRef.current = content;
			await saveFileMutation.mutateAsync({
				worktreePath,
				filePath,
				content,
			});
		},
		[worktreePath, filePath, isRemoteWorkspace, saveFileMutation],
	);

	return {
		handleSaveRaw,
		handleSaveDiff,
		isSaving: saveFileMutation.isPending || saveRemoteFileMutation.isPending,
	};
}
