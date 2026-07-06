import { formatDistanceToNow } from "date-fns";
import { LuExternalLink, LuTriangleAlert } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePRStatus } from "renderer/screens/main/hooks";
import { STROKE_WIDTH } from "../../../constants";

interface WorkspaceHoverCardContentProps {
	workspaceId: string;
	workspaceAlias?: string;
	/** Agent role (from the agent folder's CLAUDE.md), shown at the top. */
	role?: string | null;
}

export function WorkspaceHoverCardContent({
	workspaceId,
	workspaceAlias,
	role,
}: WorkspaceHoverCardContentProps) {
	const { data: worktreeInfo } =
		electronTrpc.workspaces.getWorktreeInfo.useQuery(
			{ workspaceId },
			{ enabled: !!workspaceId },
		);

	const { repoUrl, branchExistsOnRemote } = usePRStatus({ workspaceId });

	const needsRebase = worktreeInfo?.gitStatus?.needsRebase;
	const behindCount = worktreeInfo?.gitStatus?.behind;

	const worktreeName = worktreeInfo?.worktreeName;
	const branchName = worktreeInfo?.branchName;
	const hasCustomAlias =
		workspaceAlias && worktreeName && workspaceAlias !== worktreeName;

	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				{role && (
					<div>
						<div className="text-sm font-medium">{workspaceAlias}</div>
						<div className="text-xs text-muted-foreground">{role}</div>
					</div>
				)}
				{!role && hasCustomAlias && (
					<div className="text-sm font-medium">{workspaceAlias}</div>
				)}
				{branchName && (
					<div className="space-y-0.5">
						<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
							Branch
						</span>
						{repoUrl && branchExistsOnRemote ? (
							<a
								href={`${repoUrl}/tree/${branchName}`}
								target="_blank"
								rel="noopener noreferrer"
								className={`flex items-center gap-1 font-mono break-all hover:underline ${hasCustomAlias ? "text-xs" : "text-sm"}`}
							>
								{branchName}
								<LuExternalLink
									className="size-3 shrink-0"
									strokeWidth={STROKE_WIDTH}
								/>
							</a>
						) : (
							<code
								className={`font-mono break-all block ${hasCustomAlias ? "text-xs" : "text-sm"}`}
							>
								{branchName}
							</code>
						)}
					</div>
				)}
				{worktreeInfo?.createdAt && (
					<span className="text-xs text-muted-foreground block">
						{formatDistanceToNow(worktreeInfo.createdAt, { addSuffix: true })}
					</span>
				)}
			</div>

			{needsRebase && (
				<div className="flex items-center gap-2 text-amber-500 text-xs bg-amber-500/10 px-2 py-1.5 rounded-md">
					<LuTriangleAlert
						className="size-3.5 shrink-0"
						strokeWidth={STROKE_WIDTH}
					/>
					<span>
						Behind main by {behindCount ?? "?"} commit
						{behindCount !== 1 && "s"}, needs rebase
					</span>
				</div>
			)}
		</div>
	);
}
