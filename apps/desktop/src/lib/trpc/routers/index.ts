import type { BrowserWindow } from "electron";
import { router } from "..";
import { createAuthRouter } from "./auth";
import { createAutoUpdateRouter } from "./auto-update";
import { createBrowserRouter } from "./browser/browser";
import { createBrowserHistoryRouter } from "./browser-history";
import { createCacheRouter } from "./cache";
import { createChangesRouter } from "./changes";
import { createConfigRouter } from "./config";
import { createCoordinationRouter } from "./coordination";
import { createDiagnosticsRouter } from "./diagnostics";
import { createExtensionsRouter } from "./extensions";
import { createExternalRouter } from "./external";
import { createFilesystemRouter } from "./filesystem";
import { createHotkeysRouter } from "./hotkeys";
import { createMenuRouter } from "./menu";
import { createNotificationsRouter } from "./notifications";
import { createPermissionsRouter } from "./permissions";
import { createPortsRouter } from "./ports";
import { createProjectsRouter } from "./projects";
import { createRemoteRouter } from "./remote";
import { createResourceMetricsRouter } from "./resource-metrics";
import { createRingtoneRouter } from "./ringtone";
import { createSettingsRouter } from "./settings";
import { createSyncRouter } from "./sync";
import { createTerminalRouter } from "./terminal";
import { createUiStateRouter } from "./ui-state";
import { createWindowRouter } from "./window";
import { createWorkspacesRouter } from "./workspaces";

export const createAppRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		browser: createBrowserRouter(),
		browserHistory: createBrowserHistoryRouter(),
		auth: createAuthRouter(),
		autoUpdate: createAutoUpdateRouter(),
		cache: createCacheRouter(),
		window: createWindowRouter(getWindow),
		projects: createProjectsRouter(getWindow),
		workspaces: createWorkspacesRouter(),
		terminal: createTerminalRouter(),
		changes: createChangesRouter(),
		filesystem: createFilesystemRouter(),
		notifications: createNotificationsRouter(),
		permissions: createPermissionsRouter(),
		ports: createPortsRouter(),
		resourceMetrics: createResourceMetricsRouter(),
		remote: createRemoteRouter(getWindow),
		menu: createMenuRouter(),
		hotkeys: createHotkeysRouter(getWindow),
		external: createExternalRouter(),
		extensions: createExtensionsRouter(),
		settings: createSettingsRouter(),
		config: createConfigRouter(),
		coordination: createCoordinationRouter(),
		diagnostics: createDiagnosticsRouter(),
		uiState: createUiStateRouter(),
		sync: createSyncRouter(),
		ringtone: createRingtoneRouter(getWindow),
	});
};

export type AppRouter = ReturnType<typeof createAppRouter>;
