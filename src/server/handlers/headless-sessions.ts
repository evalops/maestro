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
					Type.Union([
						Type.Literal("approval"),
						Type.Literal("client_tool"),
						Type.Literal("user_input"),
					]),
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

const HeadlessSessionSubscribeSchema = Type.Object({
	protocolVersion: Type.Optional(Type.String()),
	clientInfo: Type.Optional(
		Type.Object({
			name: Type.String(),
			version: Type.Optional(Type.String()),
		}),
	),
	capabilities: Type.Optional(
		Type.Object({
			serverRequests: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("approval"),
						Type.Literal("client_tool"),
						Type.Literal("user_input"),
					]),
					{ uniqueItems: true },
				),
			),
		}),
	),
	role: Type.Optional(
		Type.Union([Type.Literal("viewer"), Type.Literal("controller")]),
	),
	takeControl: Type.Optional(Type.Boolean()),
});

const HeadlessSessionUnsubscribeSchema = Type.Object({
	subscriptionId: Type.String(),
});

type HeadlessSessionCreateInput = Static<typeof HeadlessSessionCreateSchema>;
type HeadlessSessionSubscribeInput = Static<
	typeof HeadlessSessionSubscribeSchema
>;
type HeadlessSessionUnsubscribeInput = Static<
	typeof HeadlessSessionUnsubscribeSchema
>;
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

function getHeadlessSubscriberId(req: IncomingMessage): string | undefined {
	return (
		getRequestHeader(
			req,
			"x-composer-headless-subscriber-id",
			"x-maestro-headless-subscriber-id",
		) ?? undefined
	);
}

function getScopeKey(req: IncomingMessage): string {
	return getAuthSubject(req);
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
	if (
		role === "viewer" &&
		input.capabilities?.serverRequests?.includes("user_input")
	) {
		throw new ApiError(
			400,
			"viewer headless connections cannot negotiate user_input requests",
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

export async function handleHeadlessSessionSubscribe(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessSessionSubscribeInput>(
		req,
		HeadlessSessionSubscribeSchema,
	);
	const role = getHeadlessRole(req, input.role);
	if (
		role === "viewer" &&
		input.capabilities?.serverRequests?.includes("user_input")
	) {
		throw new ApiError(
			400,
			"viewer headless connections cannot negotiate user_input requests",
		);
	}
	runtime.updateConnectionMetadata({
		clientProtocolVersion: input.protocolVersion,
		clientInfo: input.clientInfo,
		capabilities: input.capabilities
			? { server_requests: input.capabilities.serverRequests }
			: undefined,
		role,
	});
	try {
		sendJson(
			res,
			200,
			runtime.createSubscription({
				role,
				explicit: true,
				takeControl: input.takeControl,
			}),
			context.corsHeaders,
			req,
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Controller lease is already held by another subscriber"
		) {
			throw new ApiError(409, error.message);
		}
		throw error;
	}
}

export async function handleHeadlessSessionUnsubscribe(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessSessionUnsubscribeInput>(
		req,
		HeadlessSessionUnsubscribeSchema,
	);
	if (!runtime.unsubscribe(input.subscriptionId)) {
		throw new ApiError(404, "Headless subscriber not found");
	}
	sendJson(res, 200, { success: true }, context.corsHeaders, req);
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
	const subscriptionId =
		url.searchParams.get("subscriptionId") || getHeadlessSubscriberId(req);

	const stream = subscriptionId
		? runtime.attachSubscription(subscriptionId)
		: runtime.createImplicitStream({
				cursor,
				role: getHeadlessRole(req),
			});
	if (!stream) {
		throw new ApiError(404, "Headless subscriber not found");
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		...context.corsHeaders,
	});
	let flushing = false;

	const flush = () => {
		if (flushing || res.writableEnded) {
			return;
		}
		flushing = true;
		while (!res.writableEnded) {
			const next = stream.next();
			if (!next) {
				flushing = false;
				return;
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
	const stopListening = stream.onAvailable(flush);
	const heartbeat = setInterval(() => {
		if (!res.writableEnded) {
			stream.enqueue(runtime.heartbeat());
			flush();
		}
	}, 15000);
	heartbeat.unref();

	const cleanup = () => {
		clearInterval(heartbeat);
		stopListening();
		stream.close();
	};
	req.on("close", cleanup);
	res.on("close", cleanup);
	flush();
}

export async function handleHeadlessSessionMessage(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessMessageInput>(
		req,
		HeadlessMessageSchema,
	);
	try {
		runtime.assertCanSend(getHeadlessRole(req), getHeadlessSubscriberId(req));
	} catch (error) {
		if (!(error instanceof Error)) {
			throw error;
		}
		if (error.message === "Viewer headless connections cannot send messages") {
			throw new ApiError(403, error.message);
		}
		if (error.message === "Headless subscriber not found") {
			throw new ApiError(404, error.message);
		}
		if (error.message.includes("Controller lease")) {
			throw new ApiError(409, error.message);
		}
		throw new ApiError(403, error.message);
	}
	await runtime.send(input as HeadlessToAgentMessage);
	sendJson(res, 200, { success: true }, context.corsHeaders, req);
}
