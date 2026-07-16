import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@superset/ui/card";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import type { HealthStatus } from "main/lib/diagnostics/health";
import {
	HiArrowDownTray,
	HiArrowPath,
	HiArrowUturnLeft,
	HiCheckCircle,
	HiExclamationCircle,
	HiExclamationTriangle,
	HiFolderOpen,
	HiShieldCheck,
	HiTrash,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../utils/settings-search";
import {
	buildHealthViewModel,
	getHealthStatusPresentation,
	type HealthStatusTone,
} from "./health-view-model";

interface HealthSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

const TONE_CLASSES: Record<HealthStatusTone, string> = {
	success:
		"border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
	warning:
		"border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
	danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

function StatusIcon({ status }: { status: HealthStatus }) {
	if (status === "pass") return <HiCheckCircle className="h-4 w-4" />;
	if (status === "warning") {
		return <HiExclamationTriangle className="h-4 w-4" />;
	}
	return <HiExclamationCircle className="h-4 w-4" />;
}

function StatusBadge({ status }: { status: HealthStatus }) {
	const presentation = getHealthStatusPresentation(status);
	return (
		<Badge
			variant="outline"
			className={cn("gap-1 border", TONE_CLASSES[presentation.tone])}
		>
			<StatusIcon status={status} />
			{presentation.label}
		</Badge>
	);
}

function formatRunTime(value: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return null;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

export function HealthSettings({ visibleItems }: HealthSettingsProps) {
	const showDiagnostics = isItemVisible(
		SETTING_ITEM_ID.HEALTH_DIAGNOSTICS,
		visibleItems,
	);
	const showRecovery = isItemVisible(
		SETTING_ITEM_ID.HEALTH_RECOVERY,
		visibleItems,
	);
	const health = electronTrpc.diagnostics.run.useQuery(undefined, {
		refetchOnWindowFocus: false,
		retry: false,
	});
	const exportMutation = electronTrpc.diagnostics.export.useMutation({
		onSuccess: (result) => {
			if (!result.canceled) toast.success("Diagnostics exported");
		},
		onError: (error) => toast.error(error.message),
	});
	const openFolder = electronTrpc.diagnostics.openFolder.useMutation({
		onError: (error) => toast.error(error.message),
	});
	const restore =
		electronTrpc.diagnostics.restoreLatestAppStateSnapshot.useMutation({
			onSuccess: (result) => {
				if (!result.canceled) {
					toast.success("Application state restored", {
						description: "Restart ADE to load the restored state.",
					});
				}
			},
			onError: (error) => toast.error(error.message),
		});
	const reset = electronTrpc.diagnostics.resetAppStateWithBackup.useMutation({
		onSuccess: (result) => {
			if (!result.canceled) {
				toast.success("Application state reset safely", {
					description: "A recovery backup was created first.",
				});
			}
		},
		onError: (error) => toast.error(error.message),
	});
	const retryNormal = electronTrpc.diagnostics.retryNormalMode.useMutation({
		onSuccess: () =>
			toast.success("Normal startup is ready", {
				description: "Restart ADE to leave recovery mode.",
			}),
		onError: (error) => toast.error(error.message),
	});
	const view = buildHealthViewModel(health.data);
	const lastRun = formatRunTime(view.generatedAt);

	return (
		<div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-5 p-4 sm:p-6">
			<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="flex items-center gap-2 text-xl font-semibold">
						<HiShieldCheck className="h-5 w-5 text-primary" />
						Health & Recovery
					</h1>
					<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
						Check this device locally, export a privacy-safe report, and recover
						from startup or state problems. Nothing is uploaded automatically.
					</p>
				</div>
				{showDiagnostics && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => health.refetch()}
						disabled={health.isFetching}
						className="shrink-0"
					>
						<HiArrowPath
							className={cn("h-4 w-4", health.isFetching && "animate-spin")}
						/>
						Run again
					</Button>
				)}
			</div>

			{showDiagnostics && (
				<Card className="gap-0 py-0">
					<CardHeader className="gap-3 border-b px-4 py-4 sm:grid-cols-[1fr_auto]">
						<div>
							<CardTitle className="text-base">Device health</CardTitle>
							<CardDescription className="mt-1">
								{lastRun ? `Last run ${lastRun}` : "Running local checks…"}
							</CardDescription>
						</div>
						<div className="flex flex-wrap gap-2 sm:justify-end">
							<Badge
								variant="outline"
								className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
							>
								{view.summary.pass} pass
							</Badge>
							<Badge
								variant="outline"
								className="border-amber-500/30 text-amber-600 dark:text-amber-400"
							>
								{view.summary.warning} warning
							</Badge>
							<Badge
								variant="outline"
								className="border-destructive/30 text-destructive"
							>
								{view.summary.fail} fail
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="px-0 py-0">
						{health.isLoading && (
							<div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
								<HiArrowPath className="h-4 w-4 animate-spin" />
								Running checks…
							</div>
						)}
						{health.error && (
							<div className="px-4 py-6 text-sm text-destructive">
								{health.error.message}
							</div>
						)}
						{view.groups.map((group) => (
							<section key={group.id} className="border-b last:border-b-0">
								<div className="flex items-center justify-between gap-3 bg-muted/20 px-4 py-2.5">
									<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
										{group.label}
									</h2>
									<StatusBadge status={group.status} />
								</div>
								<div className="divide-y">
									{group.checks.map((check) => (
										<div
											key={check.id}
											className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
										>
											<div className="min-w-0">
												<div className="text-sm font-medium">{check.label}</div>
												<p className="mt-0.5 text-xs text-muted-foreground">
													{check.message}
												</p>
												{check.remediation && (
													<p className="mt-1 text-xs text-foreground/80">
														{check.remediation}
													</p>
												)}
											</div>
											<StatusBadge status={check.status} />
										</div>
									))}
								</div>
							</section>
						))}
					</CardContent>
				</Card>
			)}

			{showDiagnostics && (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={() => exportMutation.mutate()}
						disabled={exportMutation.isPending}
					>
						<HiArrowDownTray className="h-4 w-4" />
						Export diagnostics
					</Button>
					<Button
						variant="outline"
						onClick={() => openFolder.mutate()}
						disabled={openFolder.isPending}
					>
						<HiFolderOpen className="h-4 w-4" />
						Open diagnostics folder
					</Button>
				</div>
			)}

			{showRecovery && (
				<Card className="gap-0 py-0">
					<CardHeader className="border-b px-4 py-4">
						<CardTitle className="text-base">Recovery controls</CardTitle>
						<CardDescription>
							ADE asks for native confirmation before changing saved state.
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-3 p-4 lg:grid-cols-3">
						<Button
							variant="outline"
							className="h-auto min-w-0 justify-start whitespace-normal py-3 text-left"
							onClick={() => restore.mutate()}
							disabled={restore.isPending}
						>
							<HiArrowUturnLeft className="h-4 w-4 shrink-0" />
							Restore latest app-state snapshot
						</Button>
						<Button
							variant="outline"
							className="h-auto min-w-0 justify-start whitespace-normal py-3 text-left text-destructive hover:text-destructive"
							onClick={() => reset.mutate()}
							disabled={reset.isPending}
						>
							<HiTrash className="h-4 w-4 shrink-0" />
							Reset app state with backup
						</Button>
						<Button
							variant="outline"
							className="h-auto min-w-0 justify-start whitespace-normal py-3 text-left"
							onClick={() => retryNormal.mutate()}
							disabled={retryNormal.isPending}
						>
							<HiArrowPath className="h-4 w-4 shrink-0" />
							Retry normal mode
						</Button>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
