import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { BsTerminalPlus } from "react-icons/bs";
import { HiMiniChevronDown } from "react-icons/hi2";
import { LuFileText, LuPlus } from "react-icons/lu";
import { TbWorld } from "react-icons/tb";
import { HotkeyMenuShortcut } from "renderer/components/HotkeyMenuShortcut";
import { NewTabDropZone } from "../../NewTabDropZone";

interface AddTabButtonProps {
	useCompactAddButton: boolean;
	onDropToNewTab: (paneId: string) => void;
	isLastPaneInTab: (paneId: string) => boolean;
	onAddTerminal: () => void;
	/** Optional: open a plain shell tab, independent of the agent runtime. */
	onAddShell?: () => void;
	onAddBrowser: () => void;
	onAddNote: () => void;
	onToggleCompactAddButton: (enabled: boolean) => void;
}

export function AddTabButton({
	useCompactAddButton,
	onDropToNewTab,
	isLastPaneInTab,
	onAddTerminal,
	onAddShell,
	onAddBrowser,
	onAddNote,
	onToggleCompactAddButton,
}: AddTabButtonProps) {
	const showBigAddButton = !useCompactAddButton;

	return (
		<NewTabDropZone onDrop={onDropToNewTab} isLastPaneInTab={isLastPaneInTab}>
			<DropdownMenu>
				<div className="flex items-center shrink-0">
					{showBigAddButton ? (
						<>
							<Button
								variant="outline"
								className="h-7 rounded-r-none pl-2 pr-1.5 gap-1 text-xs"
								onClick={onAddTerminal}
							>
								<BsTerminalPlus className="size-3.5" />
								Session
							</Button>
							<Button
								variant="outline"
								className="h-7 rounded-none border-l-0 px-1.5 gap-1 text-xs"
								onClick={onAddBrowser}
							>
								<TbWorld className="size-3.5" />
								Browser
							</Button>
							<Button
								variant="outline"
								className="h-7 rounded-none border-l-0 px-1.5 gap-1 text-xs"
								onClick={onAddNote}
							>
								<LuFileText className="size-3.5" />
								Note
							</Button>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									size="icon"
									className="size-7 rounded-l-none border-l-0 px-1"
								>
									<HiMiniChevronDown className="size-3" />
								</Button>
							</DropdownMenuTrigger>
						</>
					) : (
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="size-7 px-1 rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
							>
								<LuPlus className="size-3.5" strokeWidth={1.8} />
							</Button>
						</DropdownMenuTrigger>
					)}
				</div>
				<DropdownMenuContent align="end" className="w-56">
					{onAddShell && (
						<>
							<DropdownMenuItem onClick={onAddShell} className="gap-2">
								<BsTerminalPlus className="size-4" />
								<span>Plain Shell</span>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}
					{!showBigAddButton && (
						<>
							<DropdownMenuItem onClick={onAddTerminal} className="gap-2">
								<BsTerminalPlus className="size-4" />
								<span>Session</span>
								<HotkeyMenuShortcut hotkeyId="NEW_GROUP" />
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onAddBrowser} className="gap-2">
								<TbWorld className="size-4" />
								<span>Browser</span>
								<HotkeyMenuShortcut hotkeyId="NEW_BROWSER" />
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onAddNote} className="gap-2">
								<LuFileText className="size-4" />
								<span>Note</span>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}
					<DropdownMenuCheckboxItem
						checked={useCompactAddButton}
						onCheckedChange={(checked) =>
							onToggleCompactAddButton(checked === true)
						}
						onSelect={(e) => e.preventDefault()}
					>
						Use Compact Button
					</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</NewTabDropZone>
	);
}
