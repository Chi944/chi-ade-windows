import { TRPCError } from "@trpc/server";
import {
	acknowledgeCoordinationMessage,
	buildWorkspaceContextPacket,
	CoordinationError,
	deleteSharedMemory,
	listCoordinationInbox,
	listProjectPeers,
	listSharedMemories,
	sendCoordinationMessage,
	upsertSharedMemory,
} from "main/lib/coordination/service";
import { notificationsEmitter } from "main/lib/notifications/server";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const messageKindSchema = z.enum([
	"message",
	"handoff",
	"decision",
	"artifact",
	"context",
]);

function toTrpcError(error: unknown): never {
	if (error instanceof CoordinationError) {
		throw new TRPCError({
			code: error.code,
			message: error.message,
		});
	}
	throw error;
}

function emitMessage(
	message: ReturnType<typeof sendCoordinationMessage>,
): void {
	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_MESSAGE, {
		...message,
		workspaceId: message.workspaceId ?? undefined,
		projectId: message.projectId ?? undefined,
		recipientWorkspaceId: message.recipientWorkspaceId ?? undefined,
		summary: message.summary ?? undefined,
		tokenEstimate: message.tokenEstimate ?? undefined,
		metadata: message.metadata ?? undefined,
	});
}

export const createCoordinationRouter = () =>
	router({
		peers: publicProcedure
			.input(z.object({ workspaceId: z.string().min(1) }))
			.query(({ input }) => {
				try {
					return listProjectPeers(input.workspaceId);
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		inbox: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().min(1),
					includeAcknowledged: z.boolean().optional(),
					limit: z.number().int().min(1).max(250).optional(),
				}),
			)
			.query(({ input }) => {
				try {
					return listCoordinationInbox(input);
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		send: publicProcedure
			.input(
				z.object({
					senderWorkspaceId: z.string().min(1),
					recipientWorkspaceId: z.string().min(1).nullable().optional(),
					kind: messageKindSchema.default("handoff"),
					content: z
						.string()
						.min(1)
						.max(32 * 1024),
					summary: z.string().max(500).optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
					correlationId: z.string().max(160).optional(),
					replyToId: z.string().max(160).optional(),
				}),
			)
			.mutation(({ input }) => {
				try {
					const message = sendCoordinationMessage(input);
					emitMessage(message);
					return message;
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		acknowledge: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().min(1),
					messageId: z.string().min(1),
				}),
			)
			.mutation(({ input }) => {
				try {
					return acknowledgeCoordinationMessage(input);
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		memories: publicProcedure
			.input(z.object({ workspaceId: z.string().min(1) }))
			.query(({ input }) => {
				try {
					return listSharedMemories(input.workspaceId);
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		upsertMemory: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().min(1),
					scope: z.enum(["project", "workspace"]).default("project"),
					key: z.string().min(1).max(160),
					title: z.string().min(1).max(300),
					content: z
						.string()
						.min(1)
						.max(64 * 1024),
					summary: z.string().max(500).optional(),
				}),
			)
			.mutation(({ input }) => {
				try {
					return upsertSharedMemory(input);
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		deleteMemory: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().min(1),
					memoryId: z.string().min(1),
				}),
			)
			.mutation(({ input }) => {
				try {
					return deleteSharedMemory(input);
				} catch (error) {
					return toTrpcError(error);
				}
			}),

		contextPacket: publicProcedure
			.input(
				z.object({
					workspaceId: z.string().min(1),
					objective: z.string().max(2_000).optional(),
					maxEstimatedTokens: z.number().int().min(1).max(4_096).optional(),
				}),
			)
			.query(({ input }) => {
				try {
					return buildWorkspaceContextPacket(input);
				} catch (error) {
					return toTrpcError(error);
				}
			}),
	});
