import { COMPANY } from "@superset/shared/constants";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { HiMiniXMark } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	AUTO_UPDATE_READY_ACTION,
	AUTO_UPDATE_STATUS,
	type AutoUpdateReadyAction,
} from "shared/auto-update";

interface UpdateToastProps {
	toastId: string | number;
	status: "available" | "downloading" | "ready" | "error";
	version?: string;
	error?: string;
	progress?: number;
	readyAction?: AutoUpdateReadyAction;
}

export function UpdateToast({
	toastId,
	status,
	version,
	error,
	progress,
	readyAction,
}: UpdateToastProps) {
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const downloadMutation = electronTrpc.autoUpdate.download.useMutation();
	const installMutation = electronTrpc.autoUpdate.install.useMutation();
	const dismissMutation = electronTrpc.autoUpdate.dismiss.useMutation({
		onSuccess: () => {
			toast.dismiss(toastId);
		},
	});

	const isAvailable = status === AUTO_UPDATE_STATUS.AVAILABLE;
	const isDownloading = status === AUTO_UPDATE_STATUS.DOWNLOADING;
	const isReady = status === AUTO_UPDATE_STATUS.READY;
	const isError = status === AUTO_UPDATE_STATUS.ERROR;
	const opensInstaller =
		readyAction === AUTO_UPDATE_READY_ACTION.OPEN_INSTALLER;

	const handleSeeChanges = () => {
		openUrl.mutate(COMPANY.CHANGELOG_URL);
	};

	const handleInstall = () => {
		installMutation.mutate();
	};

	const handleDownload = () => {
		downloadMutation.mutate();
	};

	const handleLater = () => {
		dismissMutation.mutate();
	};

	return (
		<div className="update-toast relative flex min-w-[340px] flex-col gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg">
			{!isDownloading && (
				<button
					type="button"
					onClick={handleLater}
					className="absolute top-2 right-2 size-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
					aria-label="Dismiss"
				>
					<HiMiniXMark className="size-4" />
				</button>
			)}
			<div className="flex flex-col gap-0.5">
				{isError ? (
					<>
						<span className="font-medium text-sm text-destructive">
							Update failed
						</span>
						<span className="text-sm text-muted-foreground">
							{error || "Please try again later"}
						</span>
					</>
				) : isAvailable ? (
					<>
						<span className="font-medium text-sm">Update available</span>
						<span className="text-sm text-muted-foreground">
							{version
								? `Version ${version} is ready to download`
								: "A new version is ready to download"}
						</span>
					</>
				) : isDownloading ? (
					<>
						<span className="font-medium text-sm">Downloading update...</span>
						<span className="text-sm text-muted-foreground">
							{typeof progress === "number"
								? `${Math.round(progress)}% complete`
								: version
									? `Version ${version}`
									: "Please wait"}
						</span>
					</>
				) : (
					<>
						<span className="font-medium text-sm">Update available</span>
						<span className="text-sm text-muted-foreground">
							{opensInstaller
								? version
									? `Verified installer for version ${version} is ready to open`
									: "Verified installer is ready to open"
								: version
									? `Version ${version} is ready to install`
									: "Ready to install"}
						</span>
					</>
				)}
			</div>
			{isDownloading && typeof progress === "number" && (
				<div
					className="h-1.5 overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-label="Update download progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(progress)}
				>
					<div
						className="h-full rounded-full bg-primary transition-[width]"
						style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
					/>
				</div>
			)}
			{isAvailable && (
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={handleSeeChanges}>
						See changes
					</Button>
					<Button
						size="sm"
						onClick={handleDownload}
						disabled={downloadMutation.isPending}
					>
						{downloadMutation.isPending ? "Starting..." : "Download"}
					</Button>
				</div>
			)}
			{isReady && (
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={handleSeeChanges}>
						See changes
					</Button>
					<Button
						size="sm"
						onClick={handleInstall}
						disabled={installMutation.isPending}
					>
						{installMutation.isPending
							? opensInstaller
								? "Opening..."
								: "Restarting..."
							: opensInstaller
								? "Open Installer"
								: "Restart to Install"}
					</Button>
				</div>
			)}
		</div>
	);
}
