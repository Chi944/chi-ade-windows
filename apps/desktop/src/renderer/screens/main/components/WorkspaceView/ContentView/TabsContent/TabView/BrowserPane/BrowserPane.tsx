import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { GlobeIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	TbDeviceDesktop,
	TbDeviceMobile,
	TbDeviceTablet,
	TbFocusCentered,
	TbMaximize,
	TbX,
} from "react-icons/tb";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { BrowserErrorOverlay } from "./components/BrowserErrorOverlay";
import { BrowserToolbar } from "./components/BrowserToolbar";
import { BrowserOverflowMenu } from "./components/BrowserToolbar/components/BrowserOverflowMenu";
import { DEFAULT_BROWSER_URL, VIEWPORT_PRESETS } from "./constants";
import { usePersistentWebview } from "./hooks/usePersistentWebview";

interface BrowserPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
}

export function BrowserPane({
	paneId,
	path,
	tabId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
}: BrowserPaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const openDevToolsPane = useTabsStore((s) => s.openDevToolsPane);
	const setBrowserViewport = useTabsStore((s) => s.setBrowserViewport);
	const browserState = pane?.browser;
	const viewport = browserState?.viewport ?? null;
	const currentUrl = browserState?.currentUrl ?? DEFAULT_BROWSER_URL;
	const pageTitle =
		browserState?.history[browserState.historyIndex]?.title ?? "";
	const isLoading = browserState?.isLoading ?? false;
	const loadError = browserState?.error ?? null;
	const isBlankPage = currentUrl === "about:blank";
	const [designMode, setDesignMode] = useState(false);
	const [selection, setSelection] = useState<{
		tagName?: string;
		selector?: string;
		text?: string;
		styles?: Record<string, string>;
		rect?: { width: number; height: number };
		page?: { path: string; title: string };
	} | null>(null);
	const designModeMutation = electronTrpc.browser.setDesignMode.useMutation({
		onError: (error) => {
			setDesignMode(false);
			toast.error(error.message);
		},
	});
	const disableDesignMode = designModeMutation.mutate;
	useEffect(
		() => () => {
			disableDesignMode({ paneId, enabled: false });
		},
		[disableDesignMode, paneId],
	);

	electronTrpc.browser.designSelection.useSubscription(
		{ paneId },
		{
			onData: (result) => {
				setDesignMode(false);
				if (!result.cancelled) setSelection(result);
			},
		},
	);

	const {
		containerRef,
		goBack,
		goForward,
		reload,
		navigateTo,
		canGoBack,
		canGoForward,
	} = usePersistentWebview({
		paneId,
		initialUrl: currentUrl,
	});

	const handleOpenDevTools = useCallback(() => {
		openDevToolsPane(tabId, paneId, path);
	}, [openDevToolsPane, tabId, paneId, path]);

	const handleDesignMode = useCallback(() => {
		const enabled = !designMode;
		setDesignMode(enabled);
		if (enabled) setSelection(null);
		designModeMutation.mutate({ paneId, enabled });
	}, [designMode, designModeMutation, paneId]);

	const copySelection = useCallback(() => {
		if (!selection) return;
		const context = [
			"Design review target:",
			`Page: ${selection.page?.path ?? currentUrl}`,
			`Element: <${selection.tagName ?? "element"}> ${selection.selector ?? ""}`,
			selection.rect
				? `Size: ${selection.rect.width} × ${selection.rect.height}px`
				: "",
			selection.text ? `Text: ${selection.text}` : "",
			selection.styles
				? `Computed styles: ${Object.entries(selection.styles)
						.map(([key, value]) => `${key}=${value}`)
						.join(", ")}`
				: "",
		]
			.filter(Boolean)
			.join("\n");
		void navigator.clipboard.writeText(context).then(() => {
			toast.success("Design context copied for your agent");
		});
	}, [currentUrl, selection]);

	const viewportOptions = [
		{ preset: VIEWPORT_PRESETS[0], icon: TbDeviceDesktop },
		{ preset: VIEWPORT_PRESETS[1], icon: TbDeviceTablet },
		{ preset: VIEWPORT_PRESETS[2], icon: TbDeviceMobile },
	];

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between min-w-0">
					<BrowserToolbar
						currentUrl={currentUrl}
						pageTitle={pageTitle}
						isLoading={isLoading}
						canGoBack={canGoBack}
						canGoForward={canGoForward}
						onGoBack={goBack}
						onGoForward={goForward}
						onReload={reload}
						onNavigate={navigateTo}
					/>
					<div className="flex items-center shrink-0">
						{viewportOptions.map(({ preset, icon: Icon }) => (
							<Tooltip key={preset.name}>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={() =>
											setBrowserViewport(
												paneId,
												viewport?.name === preset.name ? null : preset,
											)
										}
										className={cn(
											"rounded p-0.5 transition-colors hover:text-muted-foreground",
											viewport?.name === preset.name
												? "bg-muted text-foreground"
												: "text-muted-foreground/60",
										)}
									>
										<Icon className="size-3.5" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="bottom" showArrow={false}>
									{preset.name} · {preset.width} × {preset.height}
								</TooltipContent>
							</Tooltip>
						))}
						{viewport && (
							<button
								type="button"
								onClick={() => setBrowserViewport(paneId, null)}
								className="rounded p-0.5 text-muted-foreground/60 hover:text-muted-foreground"
								aria-label="Fit browser to pane"
							>
								<TbMaximize className="size-3.5" />
							</button>
						)}
						<div className="mx-1.5 h-3.5 w-px bg-muted-foreground/60" />
						<PaneToolbarActions
							splitOrientation={handlers.splitOrientation}
							onSplitPane={handlers.onSplitPane}
							onClosePane={handlers.onClosePane}
							canSplit={handlers.canSplit}
							closeHotkeyId="CLOSE_TERMINAL"
							leadingActions={
								<>
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												onClick={handleDesignMode}
												disabled={isBlankPage}
												className={cn(
													"rounded p-0.5 transition-colors",
													designMode
														? "bg-violet-500/20 text-violet-400"
														: "text-muted-foreground/60 hover:text-muted-foreground",
												)}
											>
												<TbFocusCentered className="size-3.5" />
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom" showArrow={false}>
											{designMode
												? "Cancel Design Mode"
												: "Design Mode · select a localhost element"}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												onClick={handleOpenDevTools}
												className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
											>
												<TbDeviceDesktop className="size-3.5" />
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom" showArrow={false}>
											Open DevTools
										</TooltipContent>
									</Tooltip>
									<BrowserOverflowMenu paneId={paneId} hasPage={!isBlankPage} />
								</>
							}
						/>
					</div>
				</div>
			)}
		>
			<div className="relative flex flex-1 h-full overflow-auto bg-muted/20">
				<div
					className={cn(
						"relative shrink-0 bg-background",
						viewport ? "m-auto border shadow-xl" : "h-full w-full",
					)}
					style={
						viewport
							? { width: viewport.width, height: viewport.height }
							: undefined
					}
				>
					<div ref={containerRef} className="h-full w-full" />
				</div>
				{loadError && !isLoading && (
					<BrowserErrorOverlay error={loadError} onRetry={reload} />
				)}
				{isBlankPage && !isLoading && !loadError && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background pointer-events-none">
						<GlobeIcon className="size-10 text-muted-foreground/30" />
						<div className="text-center">
							<p className="text-sm font-medium text-muted-foreground/50">
								Browser
							</p>
							<p className="mt-1 text-xs text-muted-foreground/30">
								Enter a URL above, or instruct an agent to navigate
								<br />
								and use the browser
							</p>
						</div>
					</div>
				)}
				{designMode && (
					<div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-violet-400/50 bg-background/95 px-3 py-1.5 text-xs text-foreground shadow-lg">
						Select an element · Esc to cancel
					</div>
				)}
				{selection && (
					<div className="absolute inset-x-3 bottom-3 rounded-lg border bg-background/95 p-3 shadow-xl backdrop-blur">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="text-xs font-medium">
									Selected &lt;{selection.tagName ?? "element"}&gt;
								</p>
								<code className="mt-0.5 block truncate text-[11px] text-muted-foreground">
									{selection.selector}
								</code>
							</div>
							<button
								type="button"
								onClick={() => setSelection(null)}
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
								aria-label="Close design selection"
							>
								<TbX className="size-4" />
							</button>
						</div>
						<div className="mt-2 flex items-center justify-between gap-3">
							<p className="truncate text-xs text-muted-foreground">
								{selection.text || "No visible text"}
							</p>
							<button
								type="button"
								onClick={copySelection}
								className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground"
							>
								Copy for agent
							</button>
						</div>
					</div>
				)}
			</div>
		</BasePaneWindow>
	);
}
