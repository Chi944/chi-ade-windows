import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "shared/constants";

const ADE_HOME_DIR_ENV = "ADE_HOME_DIR";

/**
 * Resolve the ADE home dir, reading ADE_HOME_DIR at call time. Prefer this over
 * the SUPERSET_HOME_DIR const in code paths that must honor an ADE_HOME_DIR set
 * after this module was first imported — e.g. a test that overrides the home in
 * its module scope but only after another test file already loaded this module
 * (bun shares one module cache across files). The const below snapshots the value
 * at load, which is fine for the real app where the home never changes.
 */
export function getSupersetHomeDir(): string {
	return process.env[ADE_HOME_DIR_ENV] || join(homedir(), SUPERSET_DIR_NAME);
}

export const SUPERSET_HOME_DIR = getSupersetHomeDir();
process.env[ADE_HOME_DIR_ENV] = SUPERSET_HOME_DIR;

export const SUPERSET_HOME_DIR_MODE = 0o700;
export const SUPERSET_SENSITIVE_FILE_MODE = 0o600;

export function ensureSupersetHomeDirExists(): void {
	if (!existsSync(SUPERSET_HOME_DIR)) {
		mkdirSync(SUPERSET_HOME_DIR, {
			recursive: true,
			mode: SUPERSET_HOME_DIR_MODE,
		});
	}

	// Best-effort repair if the directory already existed with weak permissions.
	try {
		chmodSync(SUPERSET_HOME_DIR, SUPERSET_HOME_DIR_MODE);
	} catch (error) {
		console.warn(
			"[app-environment] Failed to chmod ADE home dir (best-effort):",
			SUPERSET_HOME_DIR,
			error,
		);
	}
}

// For lowdb - use our own path instead of app.getPath("userData")
export const APP_STATE_PATH = join(SUPERSET_HOME_DIR, "app-state.json");

// Window geometry state (separate from UI state - main process only, sync I/O)
export const WINDOW_STATE_PATH = join(SUPERSET_HOME_DIR, "window-state.json");
