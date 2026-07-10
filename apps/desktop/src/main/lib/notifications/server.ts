import { EventEmitter } from "node:events";
import express from "express";
import { isValidAgentSessionId } from "shared/agent-session-recovery";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { env } from "shared/env.shared";
import type {
	AgentInvokeEvent,
	AgentLifecycleEvent,
	AgentMessageEvent,
	CoordinationChangedEvent,
} from "shared/notification-types";
import { getAgentEntry } from "../agent-config/registry";
import { appState } from "../app-state";
import {
	isValidInternalCoordinationToken,
	isValidWorkspaceCoordinationToken,
} from "../coordination/auth";
import {
	acknowledgeCoordinationMessage,
	buildWorkspaceContextPacket,
	CoordinationError,
	listCoordinationInbox,
	listProjectPeers,
	listSharedMemories,
	sendCoordinationMessage,
	upsertSharedMemory,
} from "../coordination/service";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import { getServiceTerminalManager } from "../terminal/service";
import { mapEventType } from "./map-event-type";
import {
	isWorkspaceTargetAllowed,
	resolveWorkspacePaneId,
} from "./workspace-target";

// Re-export types for backwards compatibility
export type {
	AgentLifecycleEvent,
	NotificationIds,
} from "shared/notification-types";

/**
 * The environment this server is running in.
 * Used to validate incoming hook requests and detect cross-environment issues.
 */
const SERVER_ENV =
	env.NODE_ENV === "development" ? "development" : "production";
const debugHooksOverride = process.env.SUPERSET_DEBUG_HOOKS?.trim();
const DEBUG_HOOKS_ENABLED =
	debugHooksOverride === undefined
		? SERVER_ENV === "development"
		: !/^(0|false)$/i.test(debugHooksOverride);

export const notificationsEmitter = new EventEmitter();

const app = express();

// Parse JSON request bodies
app.use(express.json());

// The server is a loopback capability endpoint, not a browser API. Rejecting
// browser origins prevents a malicious website from driving ADE through the
// user's localhost even if it guesses the port.
app.use((req, res, next) => {
	if (req.headers.origin || req.method === "OPTIONS") {
		return res
			.status(403)
			.json({ success: false, error: "Browser access denied" });
	}
	next();
});

function requestToken(req: express.Request): string | undefined {
	const value = req.header("x-ade-token");
	return typeof value === "string" ? value.trim() : undefined;
}

function authorizeInternal(
	req: express.Request,
	res: express.Response,
): boolean {
	if (isValidInternalCoordinationToken(requestToken(req))) return true;
	res.status(401).json({ success: false, error: "Invalid ADE capability" });
	return false;
}

function authorizeWorkspace(
	req: express.Request,
	res: express.Response,
	workspaceId: string,
): boolean {
	const token = requestToken(req);
	if (
		isValidInternalCoordinationToken(token) ||
		isValidWorkspaceCoordinationToken(workspaceId, token)
	) {
		return true;
	}
	res
		.status(401)
		.json({ success: false, error: "Invalid workspace capability" });
	return false;
}

function coordinationFailure(res: express.Response, error: unknown): void {
	if (error instanceof CoordinationError) {
		const status =
			error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 400;
		res.status(status).json({ success: false, error: error.message });
		return;
	}
	console.error("[coordination] request failed:", error);
	res
		.status(500)
		.json({ success: false, error: "Coordination request failed" });
}

function emitCoordinationMessage(
	message: ReturnType<typeof sendCoordinationMessage>,
): void {
	const event: AgentMessageEvent = {
		id: message.id,
		conversationId: message.conversationId,
		agentName: message.agentName,
		workspaceId: message.workspaceId ?? undefined,
		projectId: message.projectId ?? undefined,
		recipientWorkspaceId: message.recipientWorkspaceId ?? undefined,
		kind: message.kind,
		status: message.status,
		content: message.content,
		summary: message.summary ?? undefined,
		tokenEstimate: message.tokenEstimate ?? undefined,
		role: message.role === "user" ? "user" : "assistant",
		metadata: message.metadata ?? undefined,
		createdAt: message.createdAt,
	};
	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_MESSAGE, event);
}

function emitCoordinationChanged(event: CoordinationChangedEvent): void {
	notificationsEmitter.emit(NOTIFICATION_EVENTS.COORDINATION_CHANGED, event);
}

/**
 * Resolves paneId from tabId or workspaceId using synced tabs state.
 * Falls back to focused pane in active tab.
 *
 * If a paneId is provided but doesn't exist in state (stale reference),
 * we fall through to tabId/workspaceId resolution instead of returning
 * an invalid paneId that would corrupt the store.
 */
function resolvePaneId(
	paneId: string | undefined,
	tabId: string | undefined,
	workspaceId: string,
): string | undefined {
	try {
		const tabsState = appState.data.tabsState;
		if (!tabsState) return undefined;
		return resolveWorkspacePaneId(tabsState, { paneId, tabId, workspaceId });
	} catch {
		// App state not initialized yet, ignore
	}

	return undefined;
}

function targetBelongsToWorkspace(
	paneId: string | undefined,
	tabId: string | undefined,
	workspaceId: string,
): boolean {
	try {
		const tabsState = appState.data.tabsState;
		if (!tabsState) return true;
		return isWorkspaceTargetAllowed(tabsState, {
			paneId,
			tabId,
			workspaceId,
		});
	} catch {
		// If state has not initialized, there cannot be a known conflicting target.
		return true;
	}
}

function queryId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

// Agent lifecycle hook
app.get("/hook/complete", (req, res) => {
	const {
		paneId,
		tabId,
		workspaceId,
		sessionId,
		eventType,
		env: clientEnv,
		version,
	} = req.query;
	const authorizationWorkspaceId =
		typeof workspaceId === "string" ? workspaceId.trim() : "";
	if (
		!authorizationWorkspaceId ||
		!authorizeWorkspace(req, res, authorizationWorkspaceId)
	) {
		return;
	}
	const normalizedPaneId = queryId(paneId);
	const normalizedTabId = queryId(tabId);
	if (
		!targetBelongsToWorkspace(
			normalizedPaneId,
			normalizedTabId,
			authorizationWorkspaceId,
		)
	) {
		return res.status(403).json({
			success: false,
			error: "Notification target belongs to another workspace",
		});
	}

	// Environment validation: detect dev/prod cross-talk
	// We still return success to not block the agent, but log a warning
	if (clientEnv && clientEnv !== SERVER_ENV) {
		console.warn(
			`[notifications] Environment mismatch: received ${clientEnv} request on ${SERVER_ENV} server. ` +
				`This may indicate a stale hook or misconfigured terminal. Ignoring request.`,
		);
		return res.json({ success: true, ignored: true, reason: "env_mismatch" });
	}

	// Log version for debugging (helpful when troubleshooting hook issues)
	if (version && version !== HOOK_PROTOCOL_VERSION) {
		console.log(
			`[notifications] Received hook v${version} request (server expects v${HOOK_PROTOCOL_VERSION})`,
		);
	}

	const mappedEventType = mapEventType(eventType as string | undefined);

	// Unknown or missing eventType: return success but don't process
	// This ensures forward compatibility and doesn't block the agent
	if (!mappedEventType) {
		if (eventType) {
			console.log("[notifications] Ignoring unknown eventType:", eventType);
		}
		return res.json({ success: true, ignored: true });
	}

	const resolvedPaneId = resolvePaneId(
		normalizedPaneId,
		normalizedTabId,
		authorizationWorkspaceId,
	);
	const resolvedTabId = resolvedPaneId
		? appState.data.tabsState.panes?.[resolvedPaneId]?.tabId
		: undefined;

	const event: AgentLifecycleEvent = {
		paneId: resolvedPaneId,
		tabId: resolvedTabId,
		workspaceId: authorizationWorkspaceId,
		eventType: mappedEventType,
	};

	const normalizedSessionId =
		typeof sessionId === "string" ? sessionId.trim() : "";
	const runtime = resolvedPaneId
		? appState.data.tabsState.panes?.[resolvedPaneId]?.agentRuntime
		: undefined;
	if (
		resolvedPaneId &&
		normalizedSessionId &&
		runtime &&
		isValidAgentSessionId(runtime, normalizedSessionId)
	) {
		void getServiceTerminalManager()
			.persistAgentSessionFromHook({
				workspaceId: authorizationWorkspaceId,
				paneId: resolvedPaneId,
				runtime,
				sessionId: normalizedSessionId,
			})
			.catch((error) => {
				console.warn(
					"[notifications] Failed to persist agent session id:",
					error,
				);
			});
	}

	if (DEBUG_HOOKS_ENABLED) {
		console.log("[notifications] hook event received", {
			eventType,
			mappedEventType,
			paneId: normalizedPaneId,
			tabId: normalizedTabId,
			workspaceId: authorizationWorkspaceId,
			sessionId: sessionId as string | undefined,
			resolvedPaneId,
		});
	}

	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);

	res.json({ success: true, paneId: resolvedPaneId, tabId: resolvedTabId });
});

/**
 * Autonomous agent invocation. A cron/watcher (or external trigger) POSTs here;
 * we start the agent turn server-side on the Claude subscription (mastracode
 * runtime, identity+skills+MCP read from the agent's folder) and open/focus that
 * agent's chat-mastra tab in ADE so the user watches it work.
 *
 *   POST /agent/invoke  { agent, prompt, model? }
 */
app.post("/agent/invoke", async (req, res) => {
	if (!authorizeInternal(req, res)) return;
	const { agent, prompt, tab, claudeSessionId, fresh } = (req.body ?? {}) as {
		agent?: string;
		prompt?: string;
		tab?: string;
		claudeSessionId?: string;
		fresh?: boolean;
	};

	if (!agent || !prompt) {
		return res
			.status(400)
			.json({ success: false, error: "agent and prompt are required" });
	}

	const entry = getAgentEntry(agent);
	if (!entry) {
		return res
			.status(404)
			.json({ success: false, error: `Unknown agent: ${agent}` });
	}

	try {
		// Tell the renderer to open a terminal in the agent's folder and run
		// `claude` with the prompt. The agent works live in the terminal on Pat's
		// subscription; claude's own hooks fire Start/Stop (dot + review toast)
		// and its terminal title auto-names the tab.
		const invokeEvent: AgentInvokeEvent = {
			agentName: agent,
			sessionId: entry.sessionId,
			workspaceId: entry.workspaceId,
			prompt,
			cwd: entry.cwd,
			tabTitle: typeof tab === "string" && tab.trim() ? tab.trim() : undefined,
			claudeSessionId:
				typeof claudeSessionId === "string" && claudeSessionId.trim()
					? claudeSessionId.trim()
					: undefined,
			fresh: fresh !== false,
		};
		notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_INVOKE, invokeEvent);

		// Intentionally do NOT foreground ADE or steal focus — invokes are
		// background (cron/watcher). The agent's terminal opens + runs silently;
		// claude's hooks light the rail dot + fire the review toast, and the user
		// clicks in when they're ready.

		res.json({ success: true, agent, sessionId: entry.sessionId });
	} catch (error) {
		console.error("[notifications] /agent/invoke failed:", error);
		res.status(500).json({ success: false, error: String(error) });
	}
});

/**
 * Agent feed message. An agent (from its terminal, via the post-to-feed skill)
 * or any trigger POSTs a finding here; we persist it to `agent_messages` and
 * broadcast it so the feed pane updates live. This is ADE's local "Convex":
 * research streams in and shows up in a persistent channel.
 *
 *   POST /agent/message  { agent, content, conversation?, role?, metadata? }
 */
app.post("/agent/message", (req, res) => {
	const { agent, content, conversation, role, metadata, workspaceId } =
		(req.body ?? {}) as {
			agent?: string;
			content?: string;
			conversation?: string;
			role?: "assistant" | "user";
			metadata?: Record<string, unknown>;
			workspaceId?: string;
		};

	if (!agent || !content) {
		return res
			.status(400)
			.json({ success: false, error: "agent and content are required" });
	}

	// Resolve the agent's workspace (for avatar/role in the feed). Optional —
	// an unknown agent name still posts (workspaceId stays undefined).
	const entry = getAgentEntry(agent);
	const senderWorkspaceId = entry?.workspaceId || workspaceId?.trim() || "";
	if (!senderWorkspaceId || !authorizeWorkspace(req, res, senderWorkspaceId)) {
		return;
	}

	try {
		const inserted = sendCoordinationMessage({
			senderWorkspaceId,
			kind: "message",
			content,
			metadata: {
				...metadata,
				legacyConversation: (conversation ?? "main").trim() || "main",
				legacyRole: role === "user" ? "user" : "assistant",
			},
		});
		emitCoordinationMessage(inserted);
		res.json({ success: true, id: inserted.id });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.get("/coordination/peers", (req, res) => {
	const workspaceId =
		typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
	if (!workspaceId || !authorizeWorkspace(req, res, workspaceId)) return;
	try {
		res.json({ success: true, peers: listProjectPeers(workspaceId) });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.get("/coordination/inbox", (req, res) => {
	const workspaceId =
		typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
	if (!workspaceId || !authorizeWorkspace(req, res, workspaceId)) return;
	try {
		const messages = listCoordinationInbox({
			workspaceId,
			includeAcknowledged: req.query.includeAcknowledged === "true",
			limit:
				typeof req.query.limit === "string"
					? Number.parseInt(req.query.limit, 10)
					: undefined,
		});
		res.json({ success: true, messages });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.post("/coordination/message", (req, res) => {
	const senderWorkspaceId =
		typeof req.body?.senderWorkspaceId === "string"
			? req.body.senderWorkspaceId.trim()
			: "";
	if (!senderWorkspaceId || !authorizeWorkspace(req, res, senderWorkspaceId))
		return;
	try {
		const message = sendCoordinationMessage({
			senderWorkspaceId,
			recipientWorkspaceId: req.body?.recipientWorkspaceId,
			kind: req.body?.kind || "handoff",
			content: req.body?.content,
			summary: req.body?.summary,
			metadata: req.body?.metadata,
			correlationId: req.body?.correlationId,
			replyToId: req.body?.replyToId,
		});
		emitCoordinationMessage(message);
		res.json({ success: true, message });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.post("/coordination/message/:messageId/ack", (req, res) => {
	const workspaceId =
		typeof req.body?.workspaceId === "string"
			? req.body.workspaceId.trim()
			: "";
	if (!workspaceId || !authorizeWorkspace(req, res, workspaceId)) return;
	try {
		const message = acknowledgeCoordinationMessage({
			workspaceId,
			messageId: req.params.messageId,
		});
		emitCoordinationChanged({
			workspaceId,
			resources: ["inbox", "context"],
		});
		res.json({ success: true, message });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.get("/coordination/memories", (req, res) => {
	const workspaceId =
		typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
	if (!workspaceId || !authorizeWorkspace(req, res, workspaceId)) return;
	try {
		res.json({ success: true, memories: listSharedMemories(workspaceId) });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.post("/coordination/memory", (req, res) => {
	const workspaceId =
		typeof req.body?.workspaceId === "string"
			? req.body.workspaceId.trim()
			: "";
	if (!workspaceId || !authorizeWorkspace(req, res, workspaceId)) return;
	try {
		const memory = upsertSharedMemory({
			workspaceId,
			scope: req.body?.scope === "workspace" ? "workspace" : "project",
			key: req.body?.key,
			title: req.body?.title,
			content: req.body?.content,
			summary: req.body?.summary,
		});
		const affectedWorkspaceIds =
			memory.scope === "project"
				? listProjectPeers(workspaceId).map((peer) => peer.id)
				: [workspaceId];
		for (const affectedWorkspaceId of affectedWorkspaceIds) {
			emitCoordinationChanged({
				workspaceId: affectedWorkspaceId,
				resources: ["memories", "context"],
			});
		}
		res.json({ success: true, memory });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

app.get("/coordination/context", (req, res) => {
	const workspaceId =
		typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
	if (!workspaceId || !authorizeWorkspace(req, res, workspaceId)) return;
	try {
		const packet = buildWorkspaceContextPacket({
			workspaceId,
			objective:
				typeof req.query.objective === "string"
					? req.query.objective
					: undefined,
			maxEstimatedTokens:
				typeof req.query.maxEstimatedTokens === "string"
					? Number.parseInt(req.query.maxEstimatedTokens, 10)
					: undefined,
		});
		res.json({ success: true, packet });
	} catch (error) {
		coordinationFailure(res, error);
	}
});

// Health check
app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

// 404
app.use((_req, res) => {
	res.status(404).json({ error: "Not found" });
});

export const notificationsApp = app;
