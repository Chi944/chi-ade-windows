import {
	remoteHosts,
	remoteWorkspaceBindings,
	type SelectRemoteHost,
	workspaces,
} from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import {
	buildRemoteWorktreeCommand,
	buildSshTerminalCommand,
	testSshConnection,
	validateRemotePath,
} from "main/lib/remote/ssh";
import {
	getSshTunnelManager,
	type SshTunnelStatus,
} from "main/lib/remote/tunnel-manager";
import { getDaemonTerminalManager } from "main/lib/terminal";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const noShellControls = (value: string) => !/[\r\n\0"']/.test(value);
const destinationHost = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(
		/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/,
		"Invalid destination host",
	);
const portForwardSchema = z.object({
	id: z.string().uuid(),
	direction: z.enum(["local", "remote"]),
	listenPort: z.number().int().min(1024).max(65_535),
	targetHost: destinationHost,
	targetPort: z.number().int().min(1).max(65_535),
});
const portForwardsSchema = z
	.array(portForwardSchema)
	.max(16)
	.superRefine((forwards, context) => {
		const seen = new Set<string>();
		for (const [index, forward] of forwards.entries()) {
			const key = `${forward.direction}:${forward.listenPort}`;
			if (seen.has(key)) {
				context.addIssue({
					code: "custom",
					message: "Duplicate forward listen port",
					path: [index, "listenPort"],
				});
			}
			seen.add(key);
		}
	});
const remotePathSchema = z
	.string()
	.trim()
	.max(2_048)
	.refine(
		(value) => !value || validateRemotePath(value),
		"Invalid remote path",
	);
const profileSchema = z.object({
	id: z.string().uuid().optional(),
	name: z.string().trim().min(1).max(80),
	host: z
		.string()
		.trim()
		.min(1)
		.max(253)
		.refine(
			(value) =>
				!value.startsWith("-") &&
				/^[A-Za-z0-9.:[\]-]+$/.test(value) &&
				!value.includes("@"),
			"Invalid SSH host",
		),
	user: z
		.string()
		.trim()
		.max(80)
		.refine(
			(value) =>
				(!value || /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value)) &&
				noShellControls(value),
			"Invalid SSH user",
		)
		.optional(),
	port: z.number().int().min(1).max(65_535).default(22),
	identityFile: z
		.string()
		.trim()
		.max(1_024)
		.refine(noShellControls, "Invalid identity path")
		.optional(),
	remoteRoot: z
		.string()
		.trim()
		.max(2_048)
		.refine(
			(value) => !value || validateRemotePath(value),
			"Remote root must be an absolute POSIX or ~/ path",
		)
		.optional(),
	agentForwarding: z.boolean().default(false),
});

function getRemoteHost(id: string) {
	const host = localDb
		.select()
		.from(remoteHosts)
		.where(eq(remoteHosts.id, id))
		.get();
	if (!host)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Remote host not found",
		});
	return host;
}

function getWorkspace(id: string) {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, id))
		.get();
	if (!workspace || workspace.deletingAt) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workspace not found",
		});
	}
	return workspace;
}

function getWorkspaceBinding(workspaceId: string) {
	return localDb
		.select()
		.from(remoteWorkspaceBindings)
		.where(eq(remoteWorkspaceBindings.workspaceId, workspaceId))
		.get();
}

async function assertNoLiveWorkspaceTerminals(
	workspaceIds: string[],
): Promise<void> {
	if (workspaceIds.length === 0) return;
	const workspaceIdSet = new Set(workspaceIds);
	const { sessions } = await getDaemonTerminalManager().listDaemonSessions();
	if (
		sessions.some(
			(session) =>
				session.isAlive &&
				!session.hidden &&
				workspaceIdSet.has(session.workspaceId),
		)
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"Close live terminal panes in the affected workspace before changing its remote runtime",
		});
	}
}

function assertNoActiveForwardConflicts(input: {
	workspaceId: string;
	remoteHostId: string;
	portForwards: Array<{
		direction: "local" | "remote";
		listenPort: number;
	}>;
}) {
	const activeBindings = localDb
		.select()
		.from(remoteWorkspaceBindings)
		.where(eq(remoteWorkspaceBindings.tunnelEnabled, true))
		.all()
		.filter((binding) => binding.workspaceId !== input.workspaceId);

	for (const forward of input.portForwards) {
		const conflict = activeBindings.find((binding) =>
			binding.portForwards.some(
				(active) =>
					active.direction === forward.direction &&
					active.listenPort === forward.listenPort &&
					(forward.direction === "local" ||
						binding.remoteHostId === input.remoteHostId),
			),
		);
		if (conflict) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					forward.direction === "local"
						? `Local port ${forward.listenPort} is already used by another managed tunnel`
						: `Remote port ${forward.listenPort} is already used on this host`,
			});
		}
	}
}

export const createRemoteRouter = () =>
	router({
		list: publicProcedure.query(() =>
			localDb
				.select()
				.from(remoteHosts)
				.all()
				.sort((left, right) => left.name.localeCompare(right.name)),
		),

		upsert: publicProcedure.input(profileSchema).mutation(async ({ input }) => {
			const now = Date.now();
			const values = {
				name: input.name,
				host: input.host,
				user: input.user || null,
				port: input.port,
				identityFile: input.identityFile || null,
				remoteRoot: input.remoteRoot || null,
				agentForwarding: input.agentForwarding,
				updatedAt: now,
			};
			const previous = input.id ? getRemoteHost(input.id) : null;
			const connectionChanged =
				previous !== null &&
				(previous.host !== values.host ||
					previous.user !== values.user ||
					previous.port !== values.port ||
					previous.identityFile !== values.identityFile ||
					previous.agentForwarding !== values.agentForwarding);
			const boundWorkspaces =
				input.id && connectionChanged
					? localDb
							.select()
							.from(remoteWorkspaceBindings)
							.where(eq(remoteWorkspaceBindings.remoteHostId, input.id))
							.all()
					: [];
			if (connectionChanged) {
				await assertNoLiveWorkspaceTerminals(
					boundWorkspaces.map((binding) => binding.workspaceId),
				);
			}
			try {
				let saved: SelectRemoteHost;
				if (input.id) {
					saved = localDb
						.update(remoteHosts)
						.set(values)
						.where(eq(remoteHosts.id, input.id))
						.returning()
						.get();
					if (!saved) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Remote host not found",
						});
					}
				} else {
					saved = localDb
						.insert(remoteHosts)
						.values({ ...values, createdAt: now })
						.returning()
						.get();
				}
				if (connectionChanged) {
					await Promise.allSettled(
						boundWorkspaces
							.filter((binding) => binding.tunnelEnabled)
							.map((binding) =>
								getSshTunnelManager().restart(binding.workspaceId),
							),
					);
				}
				return saved;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "CONFLICT",
					message: "A remote host with this name already exists",
					cause: error,
				});
			}
		}),

		remove: publicProcedure
			.input(z.object({ id: z.string().uuid() }))
			.mutation(({ input }) => {
				const binding = localDb
					.select({ workspaceId: remoteWorkspaceBindings.workspaceId })
					.from(remoteWorkspaceBindings)
					.where(eq(remoteWorkspaceBindings.remoteHostId, input.id))
					.get();
				if (binding) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Unbind all workspaces before removing this host",
					});
				}
				localDb.delete(remoteHosts).where(eq(remoteHosts.id, input.id)).run();
				return { success: true } as const;
			}),

		bindings: publicProcedure.query(() =>
			localDb.select().from(remoteWorkspaceBindings).all(),
		),

		binding: publicProcedure
			.input(z.object({ workspaceId: z.string().uuid() }))
			.query(({ input }) => getWorkspaceBinding(input.workspaceId) ?? null),

		bindWorkspace: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().uuid(),
					remoteHostId: z.string().uuid(),
					remotePath: remotePathSchema.optional(),
					portForwards: portForwardsSchema.default([]),
				}),
			)
			.mutation(async ({ input }) => {
				getWorkspace(input.workspaceId);
				getRemoteHost(input.remoteHostId);
				const existing = getWorkspaceBinding(input.workspaceId);
				const transportChanged =
					!existing ||
					existing.remoteHostId !== input.remoteHostId ||
					existing.remotePath !== (input.remotePath || null);
				if (transportChanged) {
					await assertNoLiveWorkspaceTerminals([input.workspaceId]);
				}
				if (existing?.tunnelEnabled) {
					assertNoActiveForwardConflicts(input);
				}
				const now = Date.now();
				const values = {
					remoteHostId: input.remoteHostId,
					remotePath: input.remotePath || null,
					portForwards: input.portForwards,
					updatedAt: now,
				};
				const binding = existing
					? localDb
							.update(remoteWorkspaceBindings)
							.set(values)
							.where(eq(remoteWorkspaceBindings.workspaceId, input.workspaceId))
							.returning()
							.get()
					: localDb
							.insert(remoteWorkspaceBindings)
							.values({
								workspaceId: input.workspaceId,
								...values,
								createdAt: now,
							})
							.returning()
							.get();
				if (existing?.tunnelEnabled) {
					await getSshTunnelManager().restart(input.workspaceId);
				}
				return binding;
			}),

		unbindWorkspace: publicProcedure
			.input(z.object({ workspaceId: z.string().uuid() }))
			.mutation(async ({ input }) => {
				const binding = getWorkspaceBinding(input.workspaceId);
				if (binding) {
					await assertNoLiveWorkspaceTerminals([input.workspaceId]);
					localDb
						.update(remoteWorkspaceBindings)
						.set({ tunnelEnabled: false, updatedAt: Date.now() })
						.where(eq(remoteWorkspaceBindings.workspaceId, input.workspaceId))
						.run();
					await getSshTunnelManager().stop(input.workspaceId);
				}
				localDb
					.delete(remoteWorkspaceBindings)
					.where(eq(remoteWorkspaceBindings.workspaceId, input.workspaceId))
					.run();
				return { success: true } as const;
			}),

		startTunnel: publicProcedure
			.input(z.object({ workspaceId: z.string().uuid() }))
			.mutation(async ({ input }) => {
				const binding = getWorkspaceBinding(input.workspaceId);
				if (!binding) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Remote workspace binding not found",
					});
				}
				if (binding.portForwards.length === 0) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "Add at least one port forward first",
					});
				}
				assertNoActiveForwardConflicts(binding);
				localDb
					.update(remoteWorkspaceBindings)
					.set({ tunnelEnabled: true, updatedAt: Date.now() })
					.where(eq(remoteWorkspaceBindings.workspaceId, input.workspaceId))
					.run();
				return getSshTunnelManager().ensure(input.workspaceId);
			}),

		stopTunnel: publicProcedure
			.input(z.object({ workspaceId: z.string().uuid() }))
			.mutation(async ({ input }) => {
				localDb
					.update(remoteWorkspaceBindings)
					.set({ tunnelEnabled: false, updatedAt: Date.now() })
					.where(eq(remoteWorkspaceBindings.workspaceId, input.workspaceId))
					.run();
				return getSshTunnelManager().stop(input.workspaceId);
			}),

		tunnelStatuses: publicProcedure.query(() =>
			localDb
				.select({ workspaceId: remoteWorkspaceBindings.workspaceId })
				.from(remoteWorkspaceBindings)
				.all()
				.map(({ workspaceId }) => getSshTunnelManager().getStatus(workspaceId)),
		),

		tunnelStatus: publicProcedure.subscription(() =>
			observable<SshTunnelStatus>((emit) => {
				const manager = getSshTunnelManager();
				const handler = (status: SshTunnelStatus) => emit.next(status);
				manager.on("status", handler);
				return () => manager.off("status", handler);
			}),
		),

		terminalCommand: publicProcedure
			.input(z.object({ id: z.string().uuid() }))
			.query(({ input }) => ({
				command: buildSshTerminalCommand(getRemoteHost(input.id)),
			})),

		worktreeCommand: publicProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					repoPath: z.string().min(1).max(2_048).refine(noShellControls),
					worktreePath: z.string().min(1).max(2_048).refine(noShellControls),
					branch: z.string().min(1).max(300).refine(noShellControls),
					baseBranch: z.string().min(1).max(300).refine(noShellControls),
				}),
			)
			.query(({ input }) => ({
				command: buildRemoteWorktreeCommand(getRemoteHost(input.id), input),
			})),

		test: publicProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					trustNewHostKey: z.boolean().default(false),
				}),
			)
			.mutation(({ input }) =>
				testSshConnection(getRemoteHost(input.id), {
					trustNewHostKey: input.trustNewHostKey,
				}),
			),
	});
