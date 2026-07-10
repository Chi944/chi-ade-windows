import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import type { DirectoryEntry } from "shared/file-tree-types";

interface DeleteConfirmDialogProps {
	entry: DirectoryEntry | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	isDeleting?: boolean;
	isPermanent?: boolean;
}

export function DeleteConfirmDialog({
	entry,
	open,
	onOpenChange,
	onConfirm,
	isDeleting = false,
	isPermanent = false,
}: DeleteConfirmDialogProps) {
	if (!entry) return null;

	const itemType = entry.isDirectory ? "folder" : "file";
	const title = `Delete ${itemType} "${entry.name}"?`;
	const description = isPermanent
		? entry.isDirectory
			? "This permanently removes the remote folder only when it is empty. This action cannot be undone."
			: "This remote file will be permanently deleted. This action cannot be undone."
		: entry.isDirectory
			? "This folder and all its contents will be moved to the trash. This action can be undone from the system trash."
			: "This file will be moved to the trash. This action can be undone from the system trash.";

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="max-w-[340px] gap-0 p-0">
				<AlertDialogHeader className="px-4 pt-4 pb-2">
					<AlertDialogTitle className="font-medium">{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="px-4 pb-4 pt-2 flex-row justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-3 text-xs"
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						size="sm"
						className="h-7 px-3 text-xs"
						onClick={onConfirm}
						disabled={isDeleting}
					>
						{isDeleting ? "Deleting..." : "Delete"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
