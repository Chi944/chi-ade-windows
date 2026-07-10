import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { getSupersetHomeDir } from "../app-environment";

const MAX_MANIFEST_BYTES = 256 * 1024;
const extensionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/);
const relativePathSchema = z
	.string()
	.min(1)
	.max(1_024)
	.refine((value) => !isAbsolute(value), "Path must be relative")
	.refine(
		(value) => !value.split(/[\\/]/).includes(".."),
		"Path cannot escape extension",
	);

export const extensionManifestSchema = z.object({
	manifestVersion: z.literal(1),
	id: extensionIdSchema,
	name: z.string().min(1).max(120),
	version: z.string().min(1).max(80),
	description: z.string().max(1_000).optional(),
	platforms: z.array(z.enum(["win32", "darwin", "linux"])).optional(),
	permissions: z.array(z.string().min(1).max(160)).max(64).default([]),
	agents: z
		.array(
			z.object({
				id: extensionIdSchema,
				name: z.string().min(1).max(120),
				description: z.string().max(1_000).optional(),
				command: z
					.string()
					.min(1)
					.max(8_192)
					.refine((value) => !/[\r\n\0]/.test(value)),
				cwd: z.string().max(4_096).optional(),
			}),
		)
		.max(64)
		.default([]),
	skills: z
		.array(
			z.object({
				name: z.string().min(1).max(120),
				path: relativePathSchema,
			}),
		)
		.max(128)
		.default([]),
	mcpServers: z
		.array(
			z.object({
				id: extensionIdSchema,
				name: z.string().min(1).max(120),
				command: z.string().min(1).max(1_024),
				args: z.array(z.string().max(4_096)).max(128).default([]),
			}),
		)
		.max(64)
		.default([]),
});

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionRegistryEntry =
	| {
			status: "ready";
			directory: string;
			compatible: boolean;
			manifest: ExtensionManifest;
			resolvedSkills: Array<{ name: string; path: string }>;
	  }
	| {
			status: "invalid";
			directory: string;
			error: string;
	  };

export function getExtensionsDirectory(): string {
	return join(getSupersetHomeDir(), "extensions");
}

function isInside(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent !== "" &&
		!pathFromParent.startsWith("..") &&
		!isAbsolute(pathFromParent)
	);
}

function loadExtension(directory: string): ExtensionRegistryEntry {
	const manifestPath = join(directory, "ade-extension.json");
	try {
		if (!existsSync(manifestPath)) {
			return {
				status: "invalid",
				directory,
				error: "Missing ade-extension.json",
			};
		}
		if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
			return {
				status: "invalid",
				directory,
				error: "Manifest exceeds 256 KiB",
			};
		}
		const manifest = extensionManifestSchema.parse(
			JSON.parse(readFileSync(manifestPath, "utf8")),
		);
		const realDirectory = realpathSync(directory);
		const resolvedSkills = manifest.skills.map((skill) => {
			const lexicalPath = resolve(realDirectory, skill.path);
			if (!isInside(realDirectory, lexicalPath) || !existsSync(lexicalPath)) {
				throw new Error(
					`Skill path is missing or outside the extension: ${skill.path}`,
				);
			}
			const path = realpathSync(lexicalPath);
			if (!isInside(realDirectory, path) || !statSync(path).isFile()) {
				throw new Error(`Skill path is not a contained file: ${skill.path}`);
			}
			return { name: skill.name, path };
		});
		return {
			status: "ready",
			directory: realDirectory,
			compatible:
				!manifest.platforms ||
				manifest.platforms.includes(
					process.platform as "win32" | "darwin" | "linux",
				),
			manifest,
			resolvedSkills,
		};
	} catch (error) {
		return {
			status: "invalid",
			directory,
			error:
				error instanceof Error
					? error.message.slice(0, 1_000)
					: "Invalid extension",
		};
	}
}

export function scanExtensions(): ExtensionRegistryEntry[] {
	const root = getExtensionsDirectory();
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => loadExtension(join(root, entry.name)))
		.sort((left, right) => left.directory.localeCompare(right.directory));
}
