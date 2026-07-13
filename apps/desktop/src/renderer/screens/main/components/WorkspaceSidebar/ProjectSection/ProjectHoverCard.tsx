import { LuFolder, LuMessageCircle, LuPin, LuUserRound } from "react-icons/lu";
import { authClient } from "renderer/lib/auth-client";
import { STROKE_WIDTH } from "../constants";
import {
	getProjectOwnerLabel,
	getProjectPathLabel,
} from "./project-hover-metadata";

interface ProjectHoverCardContentProps {
	projectName: string;
	githubOwner: string | null;
	mainRepoPath: string;
	agentCount: number;
	threadCount: number;
	isPinned: boolean;
}

export function ProjectHoverCardContent({
	projectName,
	githubOwner,
	mainRepoPath,
	agentCount,
	threadCount,
	isPinned,
}: ProjectHoverCardContentProps) {
	const { data: session } = authClient.useSession();
	const ownerLabel = getProjectOwnerLabel({
		githubOwner,
		profileName: session?.user?.name,
	});
	const pathLabel = getProjectPathLabel(mainRepoPath);

	return (
		<div className="space-y-2.5">
			<div className="flex items-center gap-2">
				<LuFolder className="size-4 shrink-0" strokeWidth={STROKE_WIDTH} />
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{projectName}
				</span>
				{isPinned && (
					<LuPin
						className="size-3.5 shrink-0 text-muted-foreground"
						strokeWidth={STROKE_WIDTH}
						aria-label="Pinned"
					/>
				)}
			</div>

			<div className="space-y-1.5 border-t border-border/60 pt-2 text-xs">
				<div className="flex items-center gap-2 text-muted-foreground">
					<LuMessageCircle
						className="size-3.5 shrink-0"
						strokeWidth={STROKE_WIDTH}
					/>
					<span>
						{threadCount} thread{threadCount !== 1 ? "s" : ""} · {agentCount}{" "}
						agent{agentCount !== 1 ? "s" : ""}
					</span>
				</div>
				<div className="flex items-center gap-2 text-muted-foreground">
					<LuUserRound
						className="size-3.5 shrink-0"
						strokeWidth={STROKE_WIDTH}
					/>
					<span className="truncate">{ownerLabel}</span>
				</div>
				<div className="flex items-start gap-2 text-muted-foreground">
					<LuFolder
						className="mt-0.5 size-3.5 shrink-0"
						strokeWidth={STROKE_WIDTH}
					/>
					<span className="min-w-0 break-all" title={pathLabel}>
						{pathLabel}
					</span>
				</div>
			</div>
		</div>
	);
}
