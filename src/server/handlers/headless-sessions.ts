import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import type { ThinkingLevel } from "../../agent/types.js";
import type { HeadlessToAgentMessage } from "../../cli/headless-protocol.js";
import type { WebServerContext } from "../app-context.js";
import {
	normalizeApprovalMode,
	resolveApprovalModeForRequest,
} from "../approval-mode-store.js";
import { getAuthSubject } from "../authz.js";
import type {
	HeadlessRuntimeResetEnvelope,
	HeadlessRuntimeStreamEnvelope,
	HeadlessSessionRuntime,
} from "../headless-runtime-service.js";
import { ApiError, getRequestHeader, sendJson } from "../server-utils.js";
import { createSessionManagerForRequest } from "../session-scope.js";
import { parseAndValidateJson } from "../validation.js";

const HeadlessSessionCreateSchema = Type.Object({
	sessionId: Type.Optional(Type.String()),
	protocolVersion: Type.Optional(Type.String()),
	clientInfo: Type.Optional(
		Type.Object({
			name: Type.String(),
			version: Type.Optional(Type.String()),
		}),
	),
	model: Type.Optional(Type.String()),
	enableClientTools: Type.Optional(Type.Boolean()),
	capabilities: Type.Optional(
		Type.Object({
			serverRequests: Type.Optional(
				Type.Array(
					Type.Union([Type.Literal("approval"), Type.Literal("client_tool")]),
					{ uniqueItems: true },
				),
			),
		}),
	),
	role: Type.Optional(
		Type.Union([Type.Literal("viewer"), Type.Literal("controller")]),
	),
	client: Type.Optional(
		Type.Union([
			Type.Literal("generic"),
			Type.Literal("vscode"),
			Type.Literal("jetbrains"),
			Type.Literal("conductor"),
		]),
	),
	thinkingLevel: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("ultra"),
		]),
	),
	approvalMode: Type.Optional(
		Type.Union([
			Type.Literal("auto"),
			Type.Literal("prompt"),
			Type.Literal("fail"),
		]),
	),
});

const HeadlessMessageSchema = Type.Object(
	{
		type: Type.String(),
	},
	{ additionalProperties: true },
);

const MAX_HEADLESS_SUBSCRIBER_QUEUE =
	Number.parseInt(process.env.MAESTRO_HEADLESS_SUBSCRIBER_QUEUE || "", 10) ||
	128;

type HeadlessSessionCreateInput = Static<typeof HeadlessSessionCreateSchema>;
type HeadlessMessageInput = Static<typeof HeadlessMessageSchema>;

function getHeadlessRole(
	req: IncomingMessage,
	explicitRole?: "viewer" | "controller",
): "viewer" | "controller" {
	if (explicitRole) {
		return explicitRole;
	}
	const headerRole = getRequestHeader(
		req,
		"x-composer-headless-role",
		"x-maestro-headless-role",
	);
	return headerRole === "viewer" ? "viewer" : "controller";
}

function writeSse(res: ServerResponse, payload: unknown): boolean {
	return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getScopeKey(req: IncomingMessage): string {
	return getAuthSubject(req);
}

function buildResetEnvelope(
	runtime: Pick<HeadlessSessionRuntime, "getSnapshot">,
	reason: HeadlessRuntimeResetEnvelope["reason"],
): HeadlessRuntimeResetEnvelope {
	return {
		type: "reset",
		reason,
		snapshot: runtime.getSnapshot(),
	};
}

async function ensureRuntime(
	req: IncomingMessage,
	context: WebServerContext,
	input: HeadlessSessionCreateInput,
) {
	const sessionManager = createSessionManagerForRequest(req, false);
	const role = getHeadlessRole(req, input.role);
	const requestedSessionId = input.sessionId?.trim() || undefined;
	if (requestedSessionId) {
		const sessionFile = sessionManager.getSessionFileById(requestedSessionId);
		if (!sessionFile) {
			throw new ApiError(404, "Session not found");
		}
		sessionManager.setSessionFile(sessionFile);
	}

	const registeredModel = await context.getRegisteredModel(input.model);
	const subject = getAuthSubject(req);
	if (
		input.enableClientTools &&
		!input.capabilities?.serverRequests?.includes("client_tool")
	) {
		throw new ApiError(
			400,
			"client_tool capability is required when enableClientTools is true",
		);
	}
	if (role === "viewer" && input.enableClientTools) {
		throw new ApiError(
			400,
			"viewer headless connections cannot enable client-side tools",
		);
	}
	const headerApproval = normalizeApprovalMode(
		getRequestHeader(
			req,
			"x-composer-approval-mode",
			"x-maestro-approval-mode",
		) ?? undefined,
	);
	const effectiveApproval = resolveApprovalModeForRequest({
		sessionId: requestedSessionId ?? sessionManager.getSessionId(),
		subject,
		headerApprovalMode: input.approvalMode ?? headerApproval,
		defaultApprovalMode: context.defaultApprovalMode,
	});

	return context.headlessRuntimeService.ensureRuntime({
		scope_key: getScopeKey(req),
		sessionId: requestedSessionId,
		subject,
		clientProtocolVersion: input.protocolVersion,
		clientInfo: input.clientInfo,
		capabilities: input.capabilities
			? { server_requests: input.capabilities.serverRequests }
			: undefined,
		role,
		registeredModel,
		thinkingLevel: (input.thinkingLevel ?? "off") as ThinkingLevel,
		approvalMode: effectiveApproval,
		enableClientTools: input.enableClientTools,
		client: input.client,
		context,
		sessionManager,
	});
}

function getRuntime(
	req: IncomingMessage,
	context: WebServerContext,
	sessionId: string | undefined,
) {
	if (!sessionId) {
		throw new ApiError(400, "Missing headless session id");
	}
	const runtime = context.headlessRuntimeService.getRuntime(
		getScopeKey(req),
		sessionId,
	);
	if (!runtime) {
		throw new ApiError(404, "Headless session not found");
	}
	return runtime;
}

export async function handleHeadlessSessionCreate(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const input = await parseAndValidateJson<HeadlessSessionCreateInput>(
		req,
		HeadlessSessionCreateSchema,
	);
	const runtime = await ensureRuntime(req, context, input);
	sendJson(res, 200, runtime.getSnapshot(), context.corsHeaders, req);
}

export function handleHeadlessSessionState(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	sendJson(res, 200, runtime.getSnapshot(), context.corsHeaders, req);
}

export function handleHeadlessSessionEvents(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	const url = new URL(
		req.url || `/api/headless/sessions/${params?.id}/events`,
		`http://${req.headers.host || "localhost"}`,
	);
	const cursorParam = url.searchParams.get("cursor");
	const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : null;

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		...context.corsHeaders,
	});

	const queue: HeadlessRuntimeStreamEnvelope[] = [];
	let queuedReset: HeadlessRuntimeResetEnvelope | null = null;
	let flushing = false;

	const flush = () => {
		if (flushing || res.writableEnded) {
			return;
		}
		flushing = true;
		while (!res.writableEnded) {
			const next = queuedReset ?? queue.shift();
			if (!next) {
				flushing = false;
				return;
			}
			if (next.type === "reset") {
				queuedReset = null;
			}
			const wrote = writeSse(res, next);
			if (!wrote) {
				res.once("drain", () => {
					flushing = false;
					flush();
				});
				return;
			}
		}
		flushing = false;
	};

	const enqueue = (envelope: HeadlessRuntimeStreamEnvelope) => {
		if (res.writableEnded) {
			return;
		}
		queue.push(envelope);
		if (queue.length > MAX_HEADLESS_SUBSCRIBER_QUEUE) {
			queue.length = 0;
			queuedReset = buildResetEnvelope(runtime, "lagged");
		}
		flush();
	};

	if (cursor !== null && Number.isFinite(cursor)) {
		const replay = runtime.replayFrom(cursor);
		if (replay) {
			for (const envelope of replay) {
				enqueue(envelope);
			}
		} else {
			enqueue(buildResetEnvelope(runtime, "replay_gap"));
		}
	} else {
		enqueue({
			type: "snapshot",
			snapshot: runtime.getSnapshot(),
		});
	}

	const unsubscribe = runtime.subscribe((envelope) => {
		enqueue(envelope);
	});
	const heartbeat = setInterval(() => {
		if (!res.writableEnded) {
			enqueue(runtime.heartbeat());
		}
	}, 15000);
	heartbeat.unref();

	const cleanup = () => {
		clearInterval(heartbeat);
		unsubscribe();
	};
	req.on("close", cleanup);
	res.on("close", cleanup);
}

export async function handleHeadlessSessionMessage(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	if (getHeadlessRole(req) === "viewer") {
		throw new ApiError(403, "Viewer headless connections cannot send messages");
	}
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessMessageInput>(
		req,
		HeadlessMessageSchema,
	);
	await runtime.send(input as HeadlessToAgentMessage);
	sendJson(res, 200, { success: true }, context.corsHeaders, req);
}
