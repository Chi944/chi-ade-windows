import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	projects,
	type SelectProject,
	type SelectWorkspace,
	type WorkspaceType,
	workspaces,
} from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";

export interface PortableWorkspaceMetadata {
	repository: string;
	branch: string;
	type: WorkspaceType;
}

export interface WorkspaceIdentityInput extends PortableWorkspaceMetadata {}

export interface EmbeddedWorkspaceMeta extends PortableWorkspaceMetadata {}

export interface ResolveLocalWorkspaceIdOptions {
	autoCreate?: boolean;
}

export interface WorkspaceIdentityDependencies {
	readOrigin: (mainRepoPath: string) => string | null;
}

export interface RequestedIdentityProject {
	id: string;
	mainRepoPath: string;
}

export interface RequestedIdentityWorkspace {
	id: string;
	projectId: string;
	branch: string;
	type: WorkspaceType;
	deletingAt?: unknown | null;
}

export interface RequestedCanonicalWorkspaceMatchInput {
	canonicalWorkspaceIds: readonly string[];
	projects: readonly RequestedIdentityProject[];
	workspaces: readonly RequestedIdentityWorkspace[];
	readOrigin: WorkspaceIdentityDependencies["readOrigin"];
	preferredLocalWorkspaceIdsByCanonical?: Readonly<
		Record<string, readonly string[]>
	>;
	workspaceMetadataByCanonical?: Readonly<
		Record<string, PortableWorkspaceMetadata | undefined>
	>;
}

export type PortableWorkspaceIdentityResult =
	| {
			status: "resolved";
			canonical: string;
			metadata: PortableWorkspaceMetadata;
	  }
	| { status: "unresolved"; warning: string };

const UNRESOLVED_ORIGIN_WARNING =
	"Workspace synchronization was skipped because the Git origin is not portable.";

function trimRepositoryPath(pathname: string): string | null {
	let path = pathname.replace(/^\/+|\/+$/g, "");
	path = path.replace(/\.git$/i, "").replace(/\/+$/g, "");
	return path.length > 0 ? path : null;
}

/**
 * Return a credential-free repository identifier shared by HTTPS and SSH
 * spellings. Local paths and file remotes deliberately have no portable form.
 */
export function normalizeGitOrigin(origin: string): string | null {
	const value = origin.trim();
	if (
		value.length === 0 ||
		/^[a-zA-Z]:[\\/]/.test(value) ||
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.includes("\\") ||
		/^file:/i.test(value)
	) {
		return null;
	}

	if (/^(?:https|ssh):\/\//i.test(value)) {
		try {
			const url = new URL(value);
			const protocol = url.protocol.toLowerCase();
			if (protocol !== "https:" && protocol !== "ssh:") return null;
			const repositoryPath = trimRepositoryPath(url.pathname);
			if (!repositoryPath || url.hostname.length === 0) return null;
			const port =
				url.port &&
				!(
					(protocol === "ssh:" && url.port === "22") ||
					(protocol === "https:" && url.port === "443")
				)
					? `:${url.port}`
					: "";
			return `${url.hostname.toLowerCase()}${port}/${repositoryPath}`;
		} catch {
			return null;
		}
	}

	const scp = value.match(/^(?:[^@\s/:]+@)?([^\s/:]+):(.+)$/);
	if (!scp) return null;
	const repositoryPath = trimRepositoryPath(scp[2]);
	if (!repositoryPath) return null;
	return `${scp[1].toLowerCase()}/${repositoryPath}`;
}

export function canonicalizeWorkspace(input: WorkspaceIdentityInput): string {
	const payload = JSON.stringify([input.repository, input.branch, input.type]);
	return createHash("sha256").update(payload).digest("hex");
}

export function createPortableWorkspaceIdentity(input: {
	origin: string;
	branch: string;
	type: WorkspaceType;
}): PortableWorkspaceIdentityResult {
	const repository = normalizeGitOrigin(input.origin);
	if (!repository) {
		return { status: "unresolved", warning: UNRESOLVED_ORIGIN_WARNING };
	}
	const metadata: PortableWorkspaceMetadata = {
		repository,
		branch: input.branch,
		type: input.type,
	};
	return {
		status: "resolved",
		canonical: canonicalizeWorkspace(metadata),
		metadata,
	};
}

function readOriginFromGit(mainRepoPath: string): string | null {
	try {
		const value = execFileSync(
			"git",
			["-C", mainRepoPath, "config", "--get", "remote.origin.url"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5_000,
			},
		).trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

const defaultDependencies: WorkspaceIdentityDependencies = {
	readOrigin: readOriginFromGit,
};

function collectRequestedCanonicalWorkspaceIds(
	input: RequestedCanonicalWorkspaceMatchInput,
): Map<string, string | null> {
	const requested = new Set(input.canonicalWorkspaceIds);
	if (requested.size === 0) return new Map();
	const validMetadata = new Map<string, PortableWorkspaceMetadata>();
	for (const canonical of requested) {
		const metadata = input.workspaceMetadataByCanonical?.[canonical];
		if (metadata && canonicalizeWorkspace(metadata) === canonical) {
			validMetadata.set(canonical, metadata);
		}
	}
	const hasUnconstrainedRequest = [...requested].some(
		(canonical) => !validMetadata.has(canonical),
	);
	const requestedWorkspaceShapes = new Set(
		[...validMetadata.values()].map((metadata) =>
			JSON.stringify([metadata.branch, metadata.type]),
		),
	);
	const projectsById = new Map(
		input.projects.map((project) => [project.id, project] as const),
	);
	const repositoryByProjectId = new Map<string, string | null>();
	const candidates = new Map<string, string | null>();
	const workspacesById = new Map(
		input.workspaces.map((workspace) => [workspace.id, workspace] as const),
	);
	const consideredWorkspaceIds = new Set<string>();
	const consider = (workspace: RequestedIdentityWorkspace): void => {
		if (consideredWorkspaceIds.has(workspace.id)) return;
		consideredWorkspaceIds.add(workspace.id);
		if (workspace.deletingAt != null) return;
		if (
			!hasUnconstrainedRequest &&
			!requestedWorkspaceShapes.has(
				JSON.stringify([workspace.branch, workspace.type]),
			)
		) {
			return;
		}
		const project = projectsById.get(workspace.projectId);
		if (!project) return;
		let repository = repositoryByProjectId.get(project.id);
		if (repository === undefined) {
			repository = normalizeGitOrigin(
				input.readOrigin(project.mainRepoPath) ?? "",
			);
			repositoryByProjectId.set(project.id, repository);
		}
		if (!repository) return;
		const canonical = canonicalizeWorkspace({
			repository,
			branch: workspace.branch,
			type: workspace.type,
		});
		if (!requested.has(canonical)) return;
		if (candidates.has(canonical)) {
			candidates.set(canonical, null);
		} else {
			candidates.set(canonical, workspace.id);
		}
	};

	for (const canonical of requested) {
		for (const workspaceId of input.preferredLocalWorkspaceIdsByCanonical?.[
			canonical
		] ?? []) {
			const workspace = workspacesById.get(workspaceId);
			if (workspace) consider(workspace);
		}
	}
	// Preferences determine probe order only. Every plausible candidate must be
	// considered so an unpersisted duplicate cannot hide behind a preferred ID.
	for (const workspace of input.workspaces) consider(workspace);

	return candidates;
}

/**
 * Resolve only requested canonical IDs while reading each plausible project's
 * Git origin at most once. Canonical collisions and deleting workspaces are
 * intentionally omitted.
 */
export function matchRequestedCanonicalWorkspaceIds(
	input: RequestedCanonicalWorkspaceMatchInput,
): Record<string, string> {
	const candidates = collectRequestedCanonicalWorkspaceIds(input);

	return Object.fromEntries(
		[...candidates].flatMap(([canonical, workspaceId]) =>
			workspaceId ? [[canonical, workspaceId] as const] : [],
		),
	);
}

export function getLocalWorkspaceMappingsForCanonicalIds(
	canonicalWorkspaceIds: readonly string[],
	options: {
		dependencies?: WorkspaceIdentityDependencies;
		preferredLocalWorkspaceIdsByCanonical?: Readonly<
			Record<string, readonly string[]>
		>;
		workspaceMetadataByCanonical?: Readonly<
			Record<string, PortableWorkspaceMetadata | undefined>
		>;
	} = {},
): Record<string, string> {
	return matchRequestedCanonicalWorkspaceIds({
		canonicalWorkspaceIds,
		projects: localDb.select().from(projects).all(),
		workspaces: localDb.select().from(workspaces).all(),
		readOrigin: (options.dependencies ?? defaultDependencies).readOrigin,
		preferredLocalWorkspaceIdsByCanonical:
			options.preferredLocalWorkspaceIdsByCanonical,
		workspaceMetadataByCanonical: options.workspaceMetadataByCanonical,
	});
}

function identityForWorkspace(
	workspace: SelectWorkspace,
	project: SelectProject,
	dependencies: WorkspaceIdentityDependencies,
): PortableWorkspaceIdentityResult {
	return createPortableWorkspaceIdentity({
		origin: dependencies.readOrigin(project.mainRepoPath) ?? "",
		branch: workspace.branch,
		type: workspace.type,
	});
}

function memoizeOriginReads(
	dependencies: WorkspaceIdentityDependencies,
): WorkspaceIdentityDependencies {
	const origins = new Map<string, string | null>();
	return {
		readOrigin(mainRepoPath) {
			if (!origins.has(mainRepoPath)) {
				origins.set(mainRepoPath, dependencies.readOrigin(mainRepoPath));
			}
			return origins.get(mainRepoPath) ?? null;
		},
	};
}

function collectLocalWorkspaceMatches(
	canonicalWorkspaceIds: readonly string[],
	options: {
		dependencies: WorkspaceIdentityDependencies;
		workspaceMetadataByCanonical?: Readonly<
			Record<string, PortableWorkspaceMetadata | undefined>
		>;
	},
): Map<string, string | null> {
	return collectRequestedCanonicalWorkspaceIds({
		canonicalWorkspaceIds,
		projects: localDb.select().from(projects).all(),
		workspaces: localDb.select().from(workspaces).all(),
		readOrigin: options.dependencies.readOrigin,
		workspaceMetadataByCanonical: options.workspaceMetadataByCanonical,
	});
}

/** Resolve portable canonical identity without fabricating missing projects. */
export function resolveLocalWorkspaceId(
	canonical: string,
	embeddedMeta?: EmbeddedWorkspaceMeta,
	options?: ResolveLocalWorkspaceIdOptions,
	dependencies: WorkspaceIdentityDependencies = defaultDependencies,
): string | null {
	const memoizedDependencies = memoizeOriginReads(dependencies);
	const matches = collectLocalWorkspaceMatches([canonical], {
		dependencies: memoizedDependencies,
		workspaceMetadataByCanonical: embeddedMeta
			? { [canonical]: embeddedMeta }
			: undefined,
	});
	if (matches.has(canonical)) return matches.get(canonical) ?? null;

	if (!embeddedMeta || !options?.autoCreate) return null;
	if (canonicalizeWorkspace(embeddedMeta) !== canonical) return null;

	const matchingProject = localDb
		.select()
		.from(projects)
		.all()
		.find(
			(project) =>
				normalizeGitOrigin(
					memoizedDependencies.readOrigin(project.mainRepoPath) ?? "",
				) === embeddedMeta.repository,
		);
	if (!matchingProject) return null;

	const siblingWorkspaces = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.projectId, matchingProject.id))
		.all();
	const maxTabOrder = siblingWorkspaces.reduce(
		(max, workspace) => Math.max(max, workspace.tabOrder),
		-1,
	);
	const inserted = localDb
		.insert(workspaces)
		.values({
			projectId: matchingProject.id,
			branch: embeddedMeta.branch,
			type: embeddedMeta.type,
			name: embeddedMeta.branch,
			tabOrder: maxTabOrder + 1,
			isUnnamed: true,
		})
		.returning()
		.get();
	return inserted?.id ?? null;
}

/** Look up a local workspace using only its current credential-free origin. */
export function getCanonicalForLocalWorkspaceId(
	localWorkspaceId: string,
	dependencies: WorkspaceIdentityDependencies = defaultDependencies,
): { canonical: string; meta: EmbeddedWorkspaceMeta } | null {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, localWorkspaceId))
		.get();
	if (!workspace || workspace.deletingAt != null) return null;
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, workspace.projectId))
		.get();
	if (!project) return null;
	const memoizedDependencies = memoizeOriginReads(dependencies);
	const identity = identityForWorkspace(
		workspace,
		project,
		memoizedDependencies,
	);
	if (identity.status !== "resolved") return null;
	const matches = collectLocalWorkspaceMatches([identity.canonical], {
		dependencies: memoizedDependencies,
		workspaceMetadataByCanonical: {
			[identity.canonical]: identity.metadata,
		},
	});
	return matches.get(identity.canonical) === localWorkspaceId
		? { canonical: identity.canonical, meta: identity.metadata }
		: null;
}
