import { toast } from "@superset/ui/sonner";
import { HiMiniXMark } from "react-icons/hi2";

interface AgentReviewToastProps {
	toastId: string | number;
	agentName: string;
	role?: string | null;
	iconUrl?: string | null;
	/** Navigate to the agent's tab. */
	onOpen: () => void;
}

/**
 * Top-right "an agent finished while you were elsewhere" toast. Shows the
 * agent's bust + name + role; clicking the card opens the agent's tab.
 */
export function AgentReviewToast({
	toastId,
	agentName,
	role,
	iconUrl,
	onOpen,
}: AgentReviewToastProps) {
	return (
		<div className="agent-review-toast relative flex items-stretch bg-popover text-popover-foreground rounded-lg border border-border shadow-lg min-w-[320px] overflow-hidden">
			<button
				type="button"
				onClick={onOpen}
				className="flex flex-1 items-center gap-3 p-3 pr-9 text-left hover:bg-muted/50 transition-colors"
			>
				{iconUrl ? (
					<img
						src={iconUrl}
						alt=""
						className="size-9 shrink-0 rounded-full object-cover"
					/>
				) : (
					<span className="size-9 shrink-0 rounded-full bg-muted flex items-center justify-center text-sm font-medium uppercase">
						{agentName.slice(0, 1)}
					</span>
				)}
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate text-sm font-medium">
						{agentName}
						{role ? (
							<span className="text-muted-foreground"> · {role}</span>
						) : null}
					</span>
					<span className="text-xs text-muted-foreground">
						finished — click to review
					</span>
				</div>
			</button>
			<button
				type="button"
				onClick={() => toast.dismiss(toastId)}
				className="absolute top-2 right-2 size-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
				aria-label="Dismiss"
			>
				<HiMiniXMark className="size-4" />
			</button>
		</div>
	);
}
