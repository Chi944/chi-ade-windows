import { Button } from "@superset/ui/button";
import { LoaderCircleIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";

interface SubscriptionProfileChoice {
	id: string;
	provider: "claude" | "codex";
	label: string;
}

interface SubscriptionProfileRebindNoticeProps {
	provider: "claude" | "codex";
	isLoading: boolean;
	isError: boolean;
	profiles: SubscriptionProfileChoice[];
	onSelect: (profileId: string | null) => void;
	onRetry: () => void;
}

export function SubscriptionProfileRebindNotice({
	provider,
	isLoading,
	isError,
	profiles,
	onSelect,
	onRetry,
}: SubscriptionProfileRebindNoticeProps) {
	const providerName = provider === "claude" ? "Claude" : "Codex";

	if (isLoading) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-background p-4 text-muted-foreground">
				<output className="flex items-center gap-2 text-sm">
					<LoaderCircleIcon className="size-4 animate-spin" />
					Checking local {providerName} accounts…
				</output>
			</div>
		);
	}

	const providerProfiles = profiles.filter(
		(profile) => profile.provider === provider,
	);

	return (
		<div className="flex h-full w-full items-center justify-center bg-background p-4">
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-sm">
				<div className="flex items-start gap-3">
					<div className="mt-0.5 rounded-md bg-amber-500/10 p-2 text-amber-500">
						<ShieldAlertIcon className="size-4" />
					</div>
					<div className="min-w-0 flex-1">
						<h3 className="font-medium text-card-foreground text-sm">
							Choose a local {providerName} account
						</h3>
						<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
							This pane references an account from another device or one that
							was removed. ADE will not start it under a different account until
							you choose.
						</p>
					</div>
				</div>

				<div className="mt-4 grid gap-2">
					<Button
						type="button"
						variant="outline"
						className="h-auto justify-start px-3 py-2 text-left"
						onClick={() => onSelect(null)}
					>
						<span>
							<span className="block text-sm">System account</span>
							<span className="block font-normal text-muted-foreground text-xs">
								Use the account already authorized by the {providerName} CLI
							</span>
						</span>
					</Button>
					{providerProfiles.map((profile) => (
						<Button
							key={profile.id}
							type="button"
							variant="outline"
							className="justify-start"
							onClick={() => onSelect(profile.id)}
						>
							{profile.label}
						</Button>
					))}
				</div>
				<p className="mt-3 text-muted-foreground text-xs leading-relaxed">
					If this pane already ran on this device, choose its original account.
					For safety, an existing pane stays pinned to that account; close it
					and open a new pane to use a different one.
				</p>

				{isError && (
					<div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2">
						<p className="text-destructive text-xs">
							Named accounts could not be loaded. You can use System or retry.
						</p>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="shrink-0"
							onClick={onRetry}
						>
							<RefreshCwIcon className="size-3.5" />
							Retry
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
