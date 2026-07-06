import { cn } from "@superset/ui/utils";
import { LuFolderGit2, LuLaptop } from "react-icons/lu";
import { AsciiSpinner } from "renderer/screens/main/components/AsciiSpinner";
import { StatusIndicator } from "renderer/screens/main/components/StatusIndicator";
import type { ActivePaneStatus } from "shared/tabs-types";
import { STROKE_WIDTH } from "../constants";

interface WorkspaceIconProps {
	isBranchWorkspace: boolean;
	isActive: boolean;
	isUnread: boolean;
	workspaceStatus: ActivePaneStatus | null;
	variant: "collapsed" | "expanded";
	/** Optional custom icon (e.g. an agent bust). Overrides the laptop/folder
	 * glyph when present. Used by the agent-fleet "Space" model. */
	iconUrl?: string | null;
	/** Optional Space brand tint rendered as a tile behind the bust. */
	tintColor?: string | null;
}

const OVERLAY_POSITION = {
	collapsed: "top-1 right-1",
	expanded: "-top-0.5 -right-0.5",
} as const;

export function WorkspaceIcon({
	isBranchWorkspace,
	isActive,
	isUnread,
	workspaceStatus,
	variant,
	iconUrl,
}: WorkspaceIconProps) {
	const overlayPosition = OVERLAY_POSITION[variant];
	const iconColor = isActive ? "text-foreground" : "text-muted-foreground";

	return (
		<>
			{workspaceStatus === "working" ? (
				<AsciiSpinner className="text-base" />
			) : iconUrl ? (
				// The agent bust already has its Space brand color baked into the
				// image background, so render it directly as a clean circle (no
				// separate tile).
				<img
					src={iconUrl}
					alt=""
					className={cn(
						"size-8 shrink-0 rounded-full object-cover",
						!isActive && "opacity-90",
					)}
				/>
			) : isBranchWorkspace ? (
				<LuLaptop
					className={cn(
						"size-4",
						variant === "expanded" && "transition-colors",
						iconColor,
					)}
					strokeWidth={STROKE_WIDTH}
				/>
			) : (
				<LuFolderGit2
					className={cn(
						"size-4",
						variant === "expanded" && "transition-colors",
						iconColor,
					)}
					strokeWidth={STROKE_WIDTH}
				/>
			)}
			{workspaceStatus && workspaceStatus !== "working" && (
				<span className={cn("absolute", overlayPosition)}>
					<StatusIndicator status={workspaceStatus} />
				</span>
			)}
			{isUnread && !workspaceStatus && (
				<span className={cn("absolute flex size-2", overlayPosition)}>
					<span className="relative inline-flex size-2 rounded-full bg-blue-500" />
				</span>
			)}
		</>
	);
}
