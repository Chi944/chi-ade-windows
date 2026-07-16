import { createRouter, RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import ReactDom from "react-dom/client";
import { BootErrorBoundary } from "./components/BootErrorBoundary";
import {
	cleanupBootErrorHandling,
	initBootErrorHandling,
	isBootErrorReported,
	markBootMounted,
	reportBootError,
} from "./lib/boot-errors";
import { persistentHistory } from "./lib/persistent-hash-history";
import { signalRendererCommit } from "./lib/renderer-ready";
import { getInitialSafeRecoveryRoute } from "./lib/startup-recovery";
import { electronTrpcClient } from "./lib/trpc-client";
import { electronQueryClient } from "./providers/ElectronTRPCProvider";
import { routeTree } from "./routeTree.gen";

import "./globals.css";

const rootElement = document.querySelector("app");
initBootErrorHandling(rootElement);

const safeRecoveryRoute = getInitialSafeRecoveryRoute(window.location.search);
if (safeRecoveryRoute) {
	persistentHistory.replace(safeRecoveryRoute);
}

const router = createRouter({
	routeTree,
	history: persistentHistory,
	defaultPreload: "intent",
	context: {
		queryClient: electronQueryClient,
	},
});

const handleDeepLink = (path: string) => {
	console.log("[deep-link] Navigating to:", path);
	router.navigate({ to: path });
};
const ipcRenderer = window.ipcRenderer as typeof window.ipcRenderer | undefined;
if (ipcRenderer) {
	ipcRenderer.on("deep-link-navigate", handleDeepLink);
} else {
	reportBootError(
		"Renderer preload not available (window.ipcRenderer missing)",
	);
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		if (ipcRenderer) {
			ipcRenderer.off("deep-link-navigate", handleDeepLink);
		}
		cleanupBootErrorHandling();
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

function RendererReadySignal({ children }: { children: ReactNode }) {
	useEffect(() => {
		void electronTrpcClient.diagnostics.markRendererReady
			.mutate()
			.then(() => signalRendererCommit())
			.catch((error) => {
				console.error("[renderer] Failed to record renderer readiness", error);
			});
	}, []);
	return children;
}

if (!rootElement) {
	reportBootError("Missing <app> root element");
} else if (!isBootErrorReported()) {
	ReactDom.createRoot(rootElement).render(
		<BootErrorBoundary
			onError={(error) => reportBootError("Render failed", error)}
		>
			<RendererReadySignal>
				<RouterProvider router={router} />
			</RendererReadySignal>
		</BootErrorBoundary>,
	);
	markBootMounted();
}

if (
	new URLSearchParams(window.location.search).get("adePackagedSmoke") === "1"
) {
	const smokeSearch = window.location.search;
	void import("./lib/packaged-smoke-bridge")
		.then(({ initializePackagedSmokeBridge }) =>
			initializePackagedSmokeBridge(smokeSearch),
		)
		.catch(() => reportBootError("Packaged smoke bridge failed"));
}

// Dev-only test bridge: expose stores + router so external scripts (curl ->
// main process /test/eval -> webContents.executeJavaScript) can drive the app.
if (process.env.NODE_ENV === "development") {
	void (async () => {
		const { useTabsStore } = await import("./stores/tabs/store");
		const { useRenamePaneStore } = await import("./stores/rename-pane-store");
		const { electronTrpcClient } = await import("./lib/trpc-client");
		const w = window as unknown as { __ade?: unknown };
		w.__ade = {
			useTabsStore,
			useRenamePaneStore,
			trpc: electronTrpcClient,
			router,
		};
		console.log("[ade-test] window.__ade ready");
	})();
}
