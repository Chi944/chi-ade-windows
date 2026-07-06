import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SUPERSET_HOME_DIR } from "./app-environment";

/**
 * Icon namespaces. The `superset-icon://<namespace>/<id>` protocol encodes the
 * namespace as the URL host, and each namespace has its own on-disk directory.
 * ADE uses `projects` for Category photos and `workspaces` for Agent avatars.
 */
export type IconNamespace = "projects" | "workspaces";

const ICON_DIRS: Record<IconNamespace, string> = {
	projects: join(SUPERSET_HOME_DIR, "project-icons"),
	workspaces: join(SUPERSET_HOME_DIR, "workspace-icons"),
};

export const PROJECT_ICONS_DIR = ICON_DIRS.projects;
export const WORKSPACE_ICONS_DIR = ICON_DIRS.workspaces;

/** Max icon file size: 512KB */
const MAX_ICON_SIZE = 512 * 1024;

// ---------------------------------------------------------------------------
// Generic namespace-aware core
// ---------------------------------------------------------------------------

function ensureIconsDir(namespace: IconNamespace): void {
	const dir = ICON_DIRS[namespace];
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Finds the icon file for an id within a namespace by globbing for any
 * extension. Returns the full path or null if no icon exists.
 */
export function getIconPath(
	namespace: IconNamespace,
	id: string,
): string | null {
	const dir = ICON_DIRS[namespace];
	if (!existsSync(dir)) return null;

	const files = readdirSync(dir);
	const match = files.find((f) => {
		const name = f.substring(0, f.lastIndexOf("."));
		return name === id;
	});

	return match ? join(dir, match) : null;
}

function removeExistingIcon(namespace: IconNamespace, id: string): void {
	const existing = getIconPath(namespace, id);
	if (existing) {
		unlinkSync(existing);
	}
}

function getIconProtocolUrl(namespace: IconNamespace, id: string): string {
	return `superset-icon://${namespace}/${id}`;
}

async function saveIconFromDataUrl(
	namespace: IconNamespace,
	id: string,
	dataUrl: string,
): Promise<string> {
	ensureIconsDir(namespace);
	removeExistingIcon(namespace, id);

	// Parse data URL: data:image/png;base64,<data>
	const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
	if (!match) {
		throw new Error("Invalid data URL format");
	}

	const ext = match[1] === "jpeg" ? "jpg" : match[1];
	const buffer = Buffer.from(match[2], "base64");

	if (buffer.length > MAX_ICON_SIZE) {
		throw new Error(
			`Icon file too large (${Math.round(buffer.length / 1024)}KB). Maximum is ${MAX_ICON_SIZE / 1024}KB.`,
		);
	}

	const destPath = join(ICON_DIRS[namespace], `${id}.${ext}`);
	await writeFile(destPath, buffer);

	return getIconProtocolUrl(namespace, id);
}

// ---------------------------------------------------------------------------
// Project (Category) icons — preserved API
// ---------------------------------------------------------------------------

/**
 * Ensures the project icons directory exists. Call at startup.
 */
export function ensureProjectIconsDir(): void {
	ensureIconsDir("projects");
}

export function getProjectIconPath(projectId: string): string | null {
	return getIconPath("projects", projectId);
}

export function getProjectIconProtocolUrl(projectId: string): string {
	return getIconProtocolUrl("projects", projectId);
}

/**
 * Saves an icon file for a project from a local file path.
 * Copies the file to PROJECT_ICONS_DIR/{projectId}.{ext}.
 */
export async function saveProjectIconFromFile({
	projectId,
	sourcePath,
}: {
	projectId: string;
	sourcePath: string;
}): Promise<string> {
	ensureIconsDir("projects");
	removeExistingIcon("projects", projectId);

	const ext = extname(sourcePath) || ".png";
	const destPath = join(PROJECT_ICONS_DIR, `${projectId}${ext}`);
	await copyFile(sourcePath, destPath);

	return getProjectIconProtocolUrl(projectId);
}

/**
 * Saves an icon file for a project from a base64 data URL.
 */
export async function saveProjectIconFromDataUrl({
	projectId,
	dataUrl,
}: {
	projectId: string;
	dataUrl: string;
}): Promise<string> {
	return saveIconFromDataUrl("projects", projectId, dataUrl);
}

/**
 * Saves an icon from a Buffer with explicit extension.
 */
export async function saveProjectIconFromBuffer({
	projectId,
	buffer,
	ext,
}: {
	projectId: string;
	buffer: Buffer;
	ext: string;
}): Promise<string> {
	ensureIconsDir("projects");
	removeExistingIcon("projects", projectId);

	if (buffer.length > MAX_ICON_SIZE) {
		throw new Error(
			`Icon file too large (${Math.round(buffer.length / 1024)}KB). Maximum is ${MAX_ICON_SIZE / 1024}KB.`,
		);
	}

	const destPath = join(PROJECT_ICONS_DIR, `${projectId}.${ext}`);
	await writeFile(destPath, buffer);

	return getProjectIconProtocolUrl(projectId);
}

/**
 * Removes the icon file for a project from disk.
 */
export function deleteProjectIcon(projectId: string): void {
	removeExistingIcon("projects", projectId);
}

// ---------------------------------------------------------------------------
// Workspace (Agent) avatars — ADE
// ---------------------------------------------------------------------------

export function ensureWorkspaceIconsDir(): void {
	ensureIconsDir("workspaces");
}

export function getWorkspaceIconPath(workspaceId: string): string | null {
	return getIconPath("workspaces", workspaceId);
}

export function getWorkspaceIconProtocolUrl(workspaceId: string): string {
	return getIconProtocolUrl("workspaces", workspaceId);
}

/**
 * Saves an agent avatar from a base64 data URL to
 * WORKSPACE_ICONS_DIR/{workspaceId}.{ext}. Returns the protocol URL.
 */
export async function saveWorkspaceIconFromDataUrl({
	workspaceId,
	dataUrl,
}: {
	workspaceId: string;
	dataUrl: string;
}): Promise<string> {
	return saveIconFromDataUrl("workspaces", workspaceId, dataUrl);
}

/**
 * Removes the avatar file for an agent from disk.
 */
export function deleteWorkspaceIcon(workspaceId: string): void {
	removeExistingIcon("workspaces", workspaceId);
}
