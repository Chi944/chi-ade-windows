import {
	createFileRoute,
	Navigate,
	Outlet,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { DndProvider } from "react-dnd";
import { NewAgentModal } from "renderer/components/NewAgentModal/NewAgentModal";
import { NewCategoryModal } from "renderer/components/NewCategoryModal/NewCategoryModal";
import { useUpdateListener } from "renderer/components/UpdateToast";
import { dragDropManager } from "renderer/lib/dnd";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { InitGitDialog } from "renderer/react-query/projects/InitGitDialog";
import { WorkspaceInitEffects } from "renderer/screens/main/components/WorkspaceInitEffects";
import { useHotkeysSync } from "renderer/stores/hotkeys";
import { useAgentHookListener } from "renderer/stores/tabs/useAgentHookListener";
import { useTabsSyncSubscription } from "renderer/stores/tabs/useTabsSyncSubscription";
import { useWorkspaceInitStore } from "renderer/stores/workspace-init";
import { AgentHooks } from "./components/AgentHooks";
import { TeardownLogsDialog } from "./components/TeardownLogsDialog";
import { CollectionsProvider } from "./providers/CollectionsProvider";
import { getAuthenticatedLayoutMode } from "./safe-recovery-mode";

export const Route = createFileRoute("/_authenticated")({
	component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
	return getAuthenticatedLayoutMode(window.location.search) === "safe" ? (
		<SafeRecoveryLayout />
	) : (
		<NormalAuthenticatedLayout />
	);
}

function SafeRecoveryLayout() {
	const location = useLocation();
	const navigate = useNavigate();
	electronTrpc.menu.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type === "open-settings") {
				navigate({ to: "/settings/health" });
			}
		},
	});

	if (!location.pathname.startsWith("/settings/health")) {
		return <Navigate to="/settings/health" replace />;
	}
	return <Outlet />;
}

function NormalAuthenticatedLayout() {
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();

	useAgentHookListener();
	useUpdateListener();
	useHotkeysSync();
	useTabsSyncSubscription();

	// Workspace initialization progress subscription
	const updateInitProgress = useWorkspaceInitStore((s) => s.updateProgress);
	electronTrpc.workspaces.onInitProgress.useSubscription(undefined, {
		onData: (progress) => {
			updateInitProgress(progress);
			if (progress.step === "ready" || progress.step === "failed") {
				utils.workspaces.getAllGrouped.invalidate();
				utils.workspaces.get.invalidate({ id: progress.workspaceId });
			}
		},
		onError: (error) => {
			console.error("[workspace-init-subscription] Subscription error:", error);
		},
	});

	// Menu navigation subscription
	electronTrpc.menu.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type === "open-settings") {
				const section = event.data.section || "account";
				navigate({ to: `/settings/${section}` as "/settings/account" });
			} else if (event.type === "open-workspace") {
				navigate({ to: `/workspace/${event.data.workspaceId}` });
			}
		},
	});

	return (
		<DndProvider manager={dragDropManager}>
			<CollectionsProvider>
				<AgentHooks />
				<Outlet />
				<WorkspaceInitEffects />
				<NewAgentModal />
				<NewCategoryModal />
				<InitGitDialog />
				<TeardownLogsDialog />
			</CollectionsProvider>
		</DndProvider>
	);
}
