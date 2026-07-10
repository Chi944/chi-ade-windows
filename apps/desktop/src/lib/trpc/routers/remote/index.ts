import { remoteHosts } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import {
	buildRemoteWorktreeCommand,
	buildSshTerminalCommand,
	testSshConnection,
} from "main/lib/remote/ssh";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const noShellControls = (value: string) => !/[\r\n\0"']/.test(value);
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
		.refine(noShellControls, "Invalid remote root")
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

export const createRemoteRouter = () =>
	router({
		list: publicProcedure.query(() =>
			localDb
				.select()
				.from(remoteHosts)
				.all()
				.sort((left, right) => left.name.localeCompare(right.name)),
		),

		upsert: publicProcedure.input(profileSchema).mutation(({ input }) => {
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
			try {
				if (input.id) {
					const updated = localDb
						.update(remoteHosts)
						.set(values)
						.where(eq(remoteHosts.id, input.id))
						.returning()
						.get();
					if (!updated) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Remote host not found",
						});
					}
					return updated;
				}
				return localDb
					.insert(remoteHosts)
					.values({ ...values, createdAt: now })
					.returning()
					.get();
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
				localDb.delete(remoteHosts).where(eq(remoteHosts.id, input.id)).run();
				return { success: true } as const;
			}),

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
			.input(z.object({ id: z.string().uuid() }))
			.mutation(({ input }) => testSshConnection(getRemoteHost(input.id))),
	});
