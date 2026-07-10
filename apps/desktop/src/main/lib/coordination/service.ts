import { createHash } from "node:crypto";
import {
	agentMessageReceipts,
	agentMessages,
	sharedMemories,
	workspaces,
} from "@superset/local-db";
import { and, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
	buildContextPacket,
	type ContextPacket,
	estimateContextTokens,
} from "shared/coordination";
import { localDb } from "../local-db";

export type CoordinationMessageKind =
	| "message"
	| "handoff"
	| "decision"
	| "artifact"
	| "context";

const MAX_MESSAGE_LENGTH = 32 * 1024;
const MAX_MEMORY_LENGTH = 64 * 1024;
const MAX_PROJECT_MESSAGES = 1_000;
const MAX_PROJECT_MEMORIES = 512;
const MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MESSAGE_KINDS = new Set<CoordinationMessageKind>([
	"message",
	"handoff",
	"decision",
	"artifact",
	"context",
]);

export class CoordinationError extends Error {
	constructor(
		message: string,
		readonly code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST",
	) {
		super(message);
		this.name = "CoordinationError";
	}
}

function requireWorkspace(workspaceId: string) {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace || workspace.deletingAt) {
		throw new CoordinationError("Workspace not found", "NOT_FOUND");
	}
	return workspace;
}

function normalizedRequiredText(
	value: string,
	label: string,
	maxLength: number,
): string {
	if (typeof value !== "string") {
		throw new CoordinationError(`${label} is required`, "BAD_REQUEST");
	}
	const normalized = value.trim();
	if (!normalized) {
		throw new CoordinationError(`${label} is required`, "BAD_REQUEST");
	}
	if (normalized.length > maxLength) {
		throw new CoordinationError(
			`${label} exceeds the ${maxLength} character limit`,
			"BAD_REQUEST",
		);
	}
	return normalized;
}

function compactSummary(
	content: string,
	summary?: string,
	maxLength = 500,
): string {
	const candidate =
		summary?.trim() || content.split(/\r?\n/, 1)[0]?.trim() || content;
	return candidate.slice(0, maxLength);
}

function pruneExpiredProjectMessages(projectId: string, now: number): void {
	const cutoff = now - MESSAGE_RETENTION_MS;
	while (true) {
		const staleIds = localDb
			.select({ id: agentMessages.id })
			.from(agentMessages)
			.where(
				and(
					eq(agentMessages.projectId, projectId),
					lt(agentMessages.createdAt, cutoff),
				),
			)
			.limit(250)
			.all()
			.map((message) => message.id);
		if (staleIds.length === 0) return;
		localDb
			.delete(agentMessageReceipts)
			.where(inArray(agentMessageReceipts.messageId, staleIds))
			.run();
		localDb
			.delete(agentMessages)
			.where(inArray(agentMessages.id, staleIds))
			.run();
	}
}

function enforceProjectMessageQuota(projectId: string, now: number): void {
	pruneExpiredProjectMessages(projectId, now);
	const messageCount =
		localDb
			.select({ value: count() })
			.from(agentMessages)
			.where(eq(agentMessages.projectId, projectId))
			.get()?.value ?? 0;
	if (messageCount >= MAX_PROJECT_MESSAGES) {
		throw new CoordinationError(
			`Project coordination quota reached (${MAX_PROJECT_MESSAGES} messages)`,
			"BAD_REQUEST",
		);
	}
}

export function listProjectPeers(workspaceId: string) {
	const workspace = requireWorkspace(workspaceId);
	return localDb
		.select({
			id: workspaces.id,
			name: workspaces.name,
			runtime: workspaces.runtime,
			branch: workspaces.branch,
		})
		.from(workspaces)
		.where(
			and(
				eq(workspaces.projectId, workspace.projectId),
				isNull(workspaces.deletingAt),
			),
		)
		.all()
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function sendCoordinationMessage(input: {
	senderWorkspaceId: string;
	recipientWorkspaceId?: string | null;
	kind: CoordinationMessageKind;
	content: string;
	summary?: string;
	metadata?: Record<string, unknown>;
	correlationId?: string;
	replyToId?: string;
}) {
	const sender = requireWorkspace(input.senderWorkspaceId);
	if (input.recipientWorkspaceId) {
		const recipient = requireWorkspace(input.recipientWorkspaceId);
		if (recipient.projectId !== sender.projectId) {
			throw new CoordinationError(
				"Messages cannot cross project boundaries",
				"FORBIDDEN",
			);
		}
	}

	const content = normalizedRequiredText(
		input.content,
		"content",
		MAX_MESSAGE_LENGTH,
	);
	if (!MESSAGE_KINDS.has(input.kind)) {
		throw new CoordinationError("Unknown message kind", "BAD_REQUEST");
	}
	const now = Date.now();
	enforceProjectMessageQuota(sender.projectId, now);
	return localDb
		.insert(agentMessages)
		.values({
			conversationId: `project:${sender.projectId}`,
			agentName: sender.name,
			workspaceId: sender.id,
			projectId: sender.projectId,
			recipientWorkspaceId: input.recipientWorkspaceId || null,
			kind: input.kind,
			status: "queued",
			content,
			summary: compactSummary(content, input.summary),
			tokenEstimate: estimateContextTokens(content),
			correlationId: input.correlationId?.trim() || null,
			replyToId: input.replyToId?.trim() || null,
			metadata: input.metadata,
			role: "assistant",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
}

export function listCoordinationInbox(input: {
	workspaceId: string;
	includeAcknowledged?: boolean;
	limit?: number;
}) {
	const workspace = requireWorkspace(input.workspaceId);
	const visibleToWorkspace = or(
		eq(agentMessages.recipientWorkspaceId, workspace.id),
		isNull(agentMessages.recipientWorkspaceId),
	);
	const requestedLimit = Number.isFinite(input.limit) ? input.limit : 100;
	const cappedLimit = Math.min(Math.max(requestedLimit ?? 100, 1), 250);
	const visibleMessages: Array<typeof agentMessages.$inferSelect> = [];
	let offset = 0;
	const batchSize = 250;
	while (visibleMessages.length < cappedLimit) {
		const messages = localDb
			.select()
			.from(agentMessages)
			.where(
				and(
					eq(agentMessages.projectId, workspace.projectId),
					visibleToWorkspace,
				),
			)
			.orderBy(desc(agentMessages.createdAt))
			.limit(batchSize)
			.offset(offset)
			.all();
		if (messages.length === 0) break;

		const broadcastIds = messages
			.filter((message) => !message.recipientWorkspaceId)
			.map((message) => message.id);
		const acknowledgedBroadcasts = new Map<string, number>();
		if (broadcastIds.length > 0) {
			const receipts = localDb
				.select()
				.from(agentMessageReceipts)
				.where(
					and(
						eq(agentMessageReceipts.workspaceId, workspace.id),
						inArray(agentMessageReceipts.messageId, broadcastIds),
					),
				)
				.all();
			for (const receipt of receipts) {
				acknowledgedBroadcasts.set(receipt.messageId, receipt.acknowledgedAt);
			}
		}

		for (const message of messages) {
			const acknowledgedAt = acknowledgedBroadcasts.get(message.id);
			const visibleMessage = acknowledgedAt
				? {
						...message,
						status: "acknowledged" as const,
						acknowledgedAt,
					}
				: message;
			if (
				input.includeAcknowledged ||
				visibleMessage.status !== "acknowledged"
			) {
				visibleMessages.push(visibleMessage);
				if (visibleMessages.length === cappedLimit) break;
			}
		}
		offset += messages.length;
		if (messages.length < batchSize) break;
	}

	return visibleMessages;
}

export function acknowledgeCoordinationMessage(input: {
	workspaceId: string;
	messageId: string;
}) {
	const workspace = requireWorkspace(input.workspaceId);
	const message = localDb
		.select()
		.from(agentMessages)
		.where(eq(agentMessages.id, input.messageId))
		.get();
	if (!message) {
		throw new CoordinationError("Message not found", "NOT_FOUND");
	}
	if (
		message.projectId !== workspace.projectId ||
		(message.recipientWorkspaceId &&
			message.recipientWorkspaceId !== workspace.id)
	) {
		throw new CoordinationError("Message is outside this inbox", "FORBIDDEN");
	}

	const now = Date.now();
	if (!message.recipientWorkspaceId) {
		localDb
			.insert(agentMessageReceipts)
			.values({
				messageId: message.id,
				workspaceId: workspace.id,
				acknowledgedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					agentMessageReceipts.messageId,
					agentMessageReceipts.workspaceId,
				],
				set: { acknowledgedAt: now },
			})
			.run();
		return {
			...message,
			status: "acknowledged" as const,
			acknowledgedAt: now,
		};
	}
	return localDb
		.update(agentMessages)
		.set({
			status: "acknowledged",
			acknowledgedAt: now,
			updatedAt: now,
		})
		.where(eq(agentMessages.id, message.id))
		.returning()
		.get();
}

export function listSharedMemories(workspaceId: string) {
	const workspace = requireWorkspace(workspaceId);
	return localDb
		.select()
		.from(sharedMemories)
		.where(
			and(
				eq(sharedMemories.projectId, workspace.projectId),
				or(
					and(
						eq(sharedMemories.scope, "project"),
						eq(sharedMemories.workspaceId, ""),
					),
					and(
						eq(sharedMemories.scope, "workspace"),
						eq(sharedMemories.workspaceId, workspace.id),
					),
				),
			),
		)
		.orderBy(desc(sharedMemories.updatedAt))
		.all();
}

export function upsertSharedMemory(input: {
	workspaceId: string;
	scope: "project" | "workspace";
	key: string;
	title: string;
	content: string;
	summary?: string;
}) {
	const workspace = requireWorkspace(input.workspaceId);
	const key = normalizedRequiredText(input.key, "key", 160);
	const title = normalizedRequiredText(input.title, "title", 300);
	const content = normalizedRequiredText(
		input.content,
		"content",
		MAX_MEMORY_LENGTH,
	);
	const targetWorkspaceId = input.scope === "workspace" ? workspace.id : "";
	const now = Date.now();
	const existingMemory = localDb
		.select({ id: sharedMemories.id })
		.from(sharedMemories)
		.where(
			and(
				eq(sharedMemories.projectId, workspace.projectId),
				eq(sharedMemories.scope, input.scope),
				eq(sharedMemories.workspaceId, targetWorkspaceId),
				eq(sharedMemories.key, key),
			),
		)
		.get();
	if (!existingMemory) {
		const memoryCount =
			localDb
				.select({ value: count() })
				.from(sharedMemories)
				.where(eq(sharedMemories.projectId, workspace.projectId))
				.get()?.value ?? 0;
		if (memoryCount >= MAX_PROJECT_MEMORIES) {
			throw new CoordinationError(
				`Project memory quota reached (${MAX_PROJECT_MEMORIES} entries)`,
				"BAD_REQUEST",
			);
		}
	}
	const values = {
		projectId: workspace.projectId,
		scope: input.scope,
		workspaceId: targetWorkspaceId,
		key,
		title,
		content,
		summary: compactSummary(content, input.summary),
		authorWorkspaceId: workspace.id,
		contentHash: createHash("sha256").update(content).digest("hex"),
		tokenEstimate: estimateContextTokens(content),
		updatedAt: now,
	};

	return localDb
		.insert(sharedMemories)
		.values({ ...values, createdAt: now })
		.onConflictDoUpdate({
			target: [
				sharedMemories.projectId,
				sharedMemories.scope,
				sharedMemories.workspaceId,
				sharedMemories.key,
			],
			set: values,
		})
		.returning()
		.get();
}

export function deleteSharedMemory(input: {
	workspaceId: string;
	memoryId: string;
}) {
	const workspace = requireWorkspace(input.workspaceId);
	const memory = localDb
		.select()
		.from(sharedMemories)
		.where(eq(sharedMemories.id, input.memoryId))
		.get();
	if (!memory) {
		throw new CoordinationError("Memory not found", "NOT_FOUND");
	}
	if (
		memory.projectId !== workspace.projectId ||
		(memory.scope === "workspace" && memory.workspaceId !== workspace.id)
	) {
		throw new CoordinationError(
			"Memory is outside this workspace",
			"FORBIDDEN",
		);
	}
	localDb.delete(sharedMemories).where(eq(sharedMemories.id, memory.id)).run();
	return { success: true } as const;
}

export function buildWorkspaceContextPacket(input: {
	workspaceId: string;
	objective?: string;
	maxEstimatedTokens?: number;
}): ContextPacket & {
	sourceEstimatedTokens: number;
	estimatedTokensAvoided: number;
} {
	const messages = listCoordinationInbox({
		workspaceId: input.workspaceId,
		limit: 40,
	});
	const memories = listSharedMemories(input.workspaceId).slice(0, 12);
	const byKind = (kind: CoordinationMessageKind) =>
		messages
			.filter((message) => message.kind === kind)
			.map(
				(message) =>
					`${message.agentName}: ${message.summary || compactSummary(message.content, undefined, 240)}`,
			);

	const packet = buildContextPacket(
		{
			objective: input.objective,
			summary:
				memories.length > 0
					? memories
							.map(
								(memory) =>
									`${memory.title}: ${memory.summary || compactSummary(memory.content, undefined, 240)}`,
							)
							.join("\n")
					: undefined,
			decisions: byKind("decision"),
			nextSteps: [...byKind("handoff"), ...byKind("message")],
			artifacts: byKind("artifact"),
		},
		{ maxEstimatedTokens: input.maxEstimatedTokens },
	);
	const sourceEstimatedTokens =
		messages.reduce(
			(total, message) =>
				total +
				(message.tokenEstimate ?? estimateContextTokens(message.content)),
			0,
		) + memories.reduce((total, memory) => total + memory.tokenEstimate, 0);
	return {
		...packet,
		sourceEstimatedTokens,
		estimatedTokensAvoided: Math.max(
			0,
			sourceEstimatedTokens - packet.estimatedTokens,
		),
	};
}
