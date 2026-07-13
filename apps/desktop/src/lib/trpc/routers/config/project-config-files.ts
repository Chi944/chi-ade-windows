import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	CONFIG_FILE_NAME,
	CONFIG_TEMPLATE,
	PROJECT_SUPERSET_DIR_NAME,
} from "shared/constants";

/**
 * Categories use an empty mainRepoPath sentinel. Reject that sentinel and any
 * corrupt relative path before resolving project-local files: otherwise Node
 * resolves the config beneath the packaged process cwd (for example
 * C:\\Program Files\\ADE on Windows).
 */
export function isRepoBackedProjectPath(mainRepoPath: string): boolean {
	if (mainRepoPath.length === 0 || !isAbsolute(mainRepoPath)) return false;

	try {
		return statSync(mainRepoPath).isDirectory();
	} catch {
		return false;
	}
}

export function getProjectConfigPath(mainRepoPath: string): string | null {
	if (!isRepoBackedProjectPath(mainRepoPath)) return null;

	return join(mainRepoPath, PROJECT_SUPERSET_DIR_NAME, CONFIG_FILE_NAME);
}

export function ensureProjectConfigExists(mainRepoPath: string): string | null {
	const configPath = getProjectConfigPath(mainRepoPath);
	if (!configPath) return null;

	if (!existsSync(configPath)) {
		mkdirSync(join(mainRepoPath, PROJECT_SUPERSET_DIR_NAME), {
			recursive: true,
		});
		writeFileSync(configPath, `${CONFIG_TEMPLATE}\n`, "utf-8");
	}

	return configPath;
}
