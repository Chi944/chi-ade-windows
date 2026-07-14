import { useEffect, useRef, useState } from "react";
import { VscTerminalPowershell } from "react-icons/vsc";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { StatusIndicator } from "renderer/screens/main/components/StatusIndicator";
import { useRenamePaneStore } from "renderer/stores/rename-pane-store";
import {
	registerPaneRef,
	unregisterPaneRef,
} from "renderer/stores/tabs/pane-refs";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTerminalCallbacksStore } from "renderer/stores/tabs/terminal-callbacks";
import type { Tab } from "renderer/stores/tabs/types";
import { TabContentContextMenu } from "../TabContentContextMenu";
import { Terminal } from "../Terminal";
import { BasePaneWindow, PaneToolbarActions } from "./components";

interface TabPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	workspaceId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	splitPaneHorizontal: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
	) => void;
	splitPaneVertical: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	availableTabs: Tab[];
	onMoveToTab: (targetTabId: string) => void;
	onMoveToNewTab: () => void;
}

export function TabPane({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	splitPaneHorizontal,
	splitPaneVertical,
	removePane,
	setFocusedPane,
	availableTabs,
	onMoveToTab,
	onMoveToNewTab,
}: TabPaneProps) {
	const paneName = useTabsStore((s) => s.panes[paneId]?.name);
	const paneUserTitle = useTabsStore((s) => s.panes[paneId]?.userTitle);
	const paneStatus = useTabsStore((s) => s.panes[paneId]?.status);
	const paneRuntime = useTabsStore((s) => s.panes[paneId]?.agentRuntime);
	const subscriptionProfileId = useTabsStore(
		(s) => s.panes[paneId]?.subscriptionProfileId,
	);
	const subscriptionProfilePinned = useTabsStore(
		(s) => s.panes[paneId]?.subscriptionProfilePinned,
	);
	const accountProfiles =
		electronTrpc.settings.subscriptionConnections.profiles.useQuery(undefined, {
			enabled: typeof subscriptionProfileId === "string",
			staleTime: 30_000,
		});
	const paneBinding =
		electronTrpc.settings.subscriptionConnections.paneBinding.useQuery(
			{
				provider:
					paneRuntime === "claude" || paneRuntime === "codex"
						? paneRuntime
						: "claude",
				paneId,
				workspaceId,
			},
			{
				enabled:
					(paneRuntime === "claude" || paneRuntime === "codex") &&
					subscriptionProfilePinned === true &&
					subscriptionProfileId === undefined,
				staleTime: 30_000,
				retry: false,
			},
		);
	const setPaneUserTitle = useTabsStore((s) => s.setPaneUserTitle);
	const isRenamingThisPane = useRenamePaneStore(
		(s) => s.renamingPaneId === paneId,
	);
	const stopRenamingPane = useRenamePaneStore((s) => s.stopRenamingPane);
	const displayName = paneUserTitle?.trim() || paneName || "Terminal";
	const accountLabel =
		paneRuntime !== "claude" && paneRuntime !== "codex"
			? null
			: subscriptionProfileId === null
				? "System"
				: typeof subscriptionProfileId === "string"
					? accountProfiles.data
						? (accountProfiles.data.profiles.find(
								(profile) => profile.id === subscriptionProfileId,
							)?.label ?? "Account unavailable")
						: "Loading account"
					: subscriptionProfilePinned
						? paneBinding.isPending
							? "Loading account"
							: (paneBinding.data?.label ?? "Account required")
						: null;
	const isPowerShell =
		process.platform === "win32" ||
		/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?(?:\s|$)/i.test(displayName);
	const [draftName, setDraftName] = useState(displayName);
	const renameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isRenamingThisPane) {
			setDraftName(paneUserTitle?.trim() || paneName || "");
			requestAnimationFrame(() => {
				renameInputRef.current?.focus();
				renameInputRef.current?.select();
			});
		}
	}, [isRenamingThisPane, paneUserTitle, paneName]);

	const commitRename = () => {
		const trimmed = draftName.trim();
		// Always set userTitle (even to empty -> undefined to clear) so we don't
		// touch the auto-name. Setting same value is a noop in the store.
		setPaneUserTitle(paneId, trimmed || undefined);
		stopRenamingPane();
	};

	const terminalContainerRef = useRef<HTMLDivElement>(null);
	const getClearCallback = useTerminalCallbacksStore((s) => s.getClearCallback);
	const getScrollToBottomCallback = useTerminalCallbacksStore(
		(s) => s.getScrollToBottomCallback,
	);
	const getGetSelectionCallback = useTerminalCallbacksStore(
		(s) => s.getGetSelectionCallback,
	);
	const getPasteCallback = useTerminalCallbacksStore((s) => s.getPasteCallback);

	useEffect(() => {
		const container = terminalContainerRef.current;
		if (container) {
			registerPaneRef(paneId, container);
		}
		return () => {
			unregisterPaneRef(paneId);
		};
	}, [paneId]);

	const handleClearTerminal = () => {
		getClearCallback(paneId)?.();
	};

	const handleScrollToBottom = () => {
		getScrollToBottomCallback(paneId)?.();
	};

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between px-3">
					<div className="flex min-w-0 items-center gap-2">
						{isRenamingThisPane ? (
							<input
								ref={renameInputRef}
								value={draftName}
								onChange={(e) => setDraftName(e.target.value)}
								onBlur={commitRename}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										commitRename();
									} else if (e.key === "Escape") {
										e.preventDefault();
										stopRenamingPane();
									}
								}}
								className="min-w-0 border-b border-muted-foreground/40 bg-transparent text-sm text-muted-foreground outline-none"
							/>
						) : (
							<>
								{isPowerShell && (
									<VscTerminalPowershell
										aria-hidden="true"
										className="size-4 shrink-0 text-[#5391fe]"
									/>
								)}
								<span className="truncate text-sm text-muted-foreground">
									{displayName}
								</span>
								{accountLabel && (
									<span
										title={`${paneRuntime === "claude" ? "Claude" : "Codex"} account: ${accountLabel}`}
										className="max-w-28 shrink truncate rounded border border-border/80 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
									>
										{accountLabel}
									</span>
								)}
							</>
						)}
						{paneStatus && paneStatus !== "idle" && (
							<StatusIndicator status={paneStatus} />
						)}
					</div>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						canSplit={handlers.canSplit}
						closeHotkeyId="CLOSE_TERMINAL"
					/>
				</div>
			)}
		>
			<TabContentContextMenu
				onSplitHorizontal={() => splitPaneHorizontal(tabId, paneId, path)}
				onSplitVertical={() => splitPaneVertical(tabId, paneId, path)}
				onClosePane={() => removePane(paneId)}
				onClearTerminal={handleClearTerminal}
				onScrollToBottom={handleScrollToBottom}
				getSelection={() => getGetSelectionCallback(paneId)?.() ?? ""}
				onPaste={(text) => getPasteCallback(paneId)?.(text)}
				currentTabId={tabId}
				availableTabs={availableTabs}
				onMoveToTab={onMoveToTab}
				onMoveToNewTab={onMoveToNewTab}
				closeLabel="Close Terminal"
			>
				<div ref={terminalContainerRef} className="w-full h-full">
					<Terminal paneId={paneId} tabId={tabId} workspaceId={workspaceId} />
				</div>
			</TabContentContextMenu>
		</BasePaneWindow>
	);
}
