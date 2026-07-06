import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useState } from "react";
import { LuBrain, LuExpand, LuFile, LuShrink, LuX } from "react-icons/lu";
import { HotkeyTooltipContent } from "renderer/components/HotkeyTooltipContent";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SidebarMode, useSidebarStore } from "renderer/stores/sidebar-state";
import { AgentFilesView } from "./AgentFilesView";
import { FilesView } from "./FilesView";

type PanelTab = "all-files" | "agent-files";

function TabButton({
	isActive,
	onClick,
	icon,
	label,
	compact,
}: {
	isActive: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	compact?: boolean;
}) {
	if (compact) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={onClick}
						className={cn(
							"flex items-center justify-center shrink-0 h-full w-10 transition-all",
							isActive
								? "text-foreground bg-border/30"
								: "text-muted-foreground/70 hover:text-muted-foreground hover:bg-tertiary/20",
						)}
					>
						{icon}
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					{label}
				</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			title={label}
			className={cn(
				"flex items-center gap-2 min-w-0 px-3 h-full transition-colors text-sm",
				isActive
					? "text-foreground bg-border/30"
					: "text-muted-foreground/70 hover:text-muted-foreground hover:bg-tertiary/20",
			)}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate">{label}</span>
		</button>
	);
}

export function RightSidebar() {
	const { currentMode, toggleSidebar, setMode } = useSidebarStore();
	const isExpanded = currentMode === SidebarMode.Changes;
	const [panelTab, setPanelTab] = useState<PanelTab>("all-files");

	// Agent Files is staged off pending the video's Stage 2 reveal; hide the tab
	// entirely until the memory scaffold flag is on.
	const { data: featureFlags } = electronTrpc.config.featureFlags.useQuery();
	const showAgentFiles = featureFlags?.memoryScaffold ?? false;
	const activeTab: PanelTab = showAgentFiles ? panelTab : "all-files";

	const handleExpandToggle = () => {
		setMode(isExpanded ? SidebarMode.Tabs : SidebarMode.Changes);
	};

	return (
		<aside className="h-full flex flex-col overflow-hidden">
			<div className="flex items-center bg-background shrink-0 h-10 border-b">
				<div className="flex items-center h-full min-w-0 flex-1">
					<TabButton
						isActive={activeTab === "all-files"}
						onClick={() => setPanelTab("all-files")}
						icon={<LuFile className="size-3.5" />}
						label="All files"
					/>
					{showAgentFiles && (
						<TabButton
							isActive={activeTab === "agent-files"}
							onClick={() => setPanelTab("agent-files")}
							icon={<LuBrain className="size-3.5" />}
							label="Agent Files"
						/>
					)}
				</div>
				<div className="flex items-center h-10 shrink-0 pl-1 pr-2 gap-1 border-l border-border/60">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleExpandToggle}
								className="size-6 p-0"
							>
								{isExpanded ? (
									<LuShrink className="size-3.5" />
								) : (
									<LuExpand className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyTooltipContent
								label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
								hotkeyId="TOGGLE_EXPAND_SIDEBAR"
							/>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={toggleSidebar}
								className="size-6 p-0"
							>
								<LuX className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyTooltipContent
								label="Close sidebar"
								hotkeyId="TOGGLE_SIDEBAR"
							/>
						</TooltipContent>
					</Tooltip>
				</div>
			</div>
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
				{activeTab === "all-files" ? <FilesView /> : <AgentFilesView />}
			</div>
		</aside>
	);
}
