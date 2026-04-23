import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type HeadlessConnectionRole,
	headlessApprovalModes,
	headlessConnectionRoles,
	headlessNotificationTypes,
	headlessServerRequestTypes,
	headlessThinkingLevels,
	headlessToAgentMessageSchemasByType,
	headlessToAgentMessageTypes,
	headlessUtilityOperations,
} from "@evalops/contracts";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { ThinkingLevel } from "../../agent/types.js";
import type { HeadlessToAgentMessage } from "../../cli/headless-protocol.js";
import type { WebServerContext } from "../app-context.js";
import {
	normalizeApprovalMode,
	resolveApprovalModeForRequest,
} from "../approval-mode-store.js";
import { getAuthSubject } from "../authz.js";
import type {
	HeadlessRuntimeConnectionSnapshot,
	HeadlessRuntimeHeartbeatSnapshot,
	HeadlessRuntimeStreamEnvelope,
	HeadlessSessionRuntime,
} from "../headless-runtime-service.js";
import {
	ApiError,
	getRequestHeader,
	readRequestBody,
	sendJson,
} from "../server-utils.js";
import { createSessionManagerForRequest } from "../session-scope.js";
import { parseAndValidateJson, validatePayload } from "../validation.js";

function stringLiteralUnion<const T extends readonly string[]>(values: T) {
	return Type.Unsafe<T[number]>(
		Type.Union(
			values.map((value) => Type.Literal(value)) as unknown as [
				TSchema,
				...TSchema[],
			],
		),
	);
}

const HeadlessOptOutNotificationsSchema = Type.Array(
	stringLiteralUnion(headlessNotificationTypes),
	{
		uniqueItems: true,
	},
);

const HeadlessCreateBaseProperties = {
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
				Type.Array(stringLiteralUnion(headlessServerRequestTypes), {
					uniqueItems: true,
				}),
			),
			utilityOperations: Type.Optional(
				Type.Array(stringLiteralUnion(headlessUtilityOperations), {
					uniqueItems: true,
				}),
			),
			rawAgentEvents: Type.Optional(Type.Boolean()),
		}),
	),
	optOutNotifications: Type.Optional(HeadlessOptOutNotificationsSchema),
	role: Type.Optional(stringLiteralUnion(headlessConnectionRoles)),
	client: Type.Optional(
		Type.Union([
			Type.Literal("generic"),
			Type.Literal("vscode"),
			Type.Literal("jetbrains"),
			Type.Literal("conductor"),
		]),
	),
	thinkingLevel: Type.Optional(stringLiteralUnion(headlessThinkingLevels)),
	approvalMode: Type.Optional(stringLiteralUnion(headlessApprovalModes)),
} as const;

const HeadlessSessionCreateSchema = Type.Object(HeadlessCreateBaseProperties);

const HeadlessConnectionCreateSchema = Type.Object({
	...HeadlessCreateBaseProperties,
	connectionId: Type.Optional(Type.String()),
	takeControl: Type.Optional(Type.Boolean()),
});

const HeadlessMessageTypeSchema = Type.Object(
	{
		type: stringLiteralUnion(headlessToAgentMessageTypes),
	},
	{ additionalProperties: true },
);

const HeadlessSessionSubscribeSchema = Type.Object({
	connectionId: Type.Optional(Type.String()),
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
				Type.Array(stringLiteralUnion(headlessServerRequestTypes), {
					uniqueItems: true,
				}),
			),
			utilityOperations: Type.Optional(
				Type.Array(stringLiteralUnion(headlessUtilityOperations), {
					uniqueItems: true,
				}),
			),
			rawAgentEvents: Type.Optional(Type.Boolean()),
		}),
	),
	optOutNotifications: Type.Optional(HeadlessOptOutNotificationsSchema),
	role: Type.Optional(stringLiteralUnion(headlessConnectionRoles)),
	takeControl: Type.Optional(Type.Boolean()),
});

const HeadlessSessionUnsubscribeSchema = Type.Object({
	subscriptionId: Type.String(),
});

const HeadlessSessionHeartbeatSchema = Type.Object({
	connectionId: Type.Optional(Type.String()),
	subscriptionId: Type.Optional(Type.String()),
});

const HeadlessSessionDisconnectSchema = Type.Object({
	connectionId: Type.Optional(Type.String()),
	subscriptionId: Type.Optional(Type.String()),
});

type HeadlessSessionCreateInput = Static<typeof HeadlessSessionCreateSchema>;
type HeadlessConnectionCreateInput = Static<
	typeof HeadlessConnectionCreateSchema
>;
type HeadlessSessionSubscribeInput = Static<
	typeof HeadlessSessionSubscribeSchema
>;
type HeadlessSessionUnsubscribeInput = Static<
	typeof HeadlessSessionUnsubscribeSchema
>;
type HeadlessSessionHeartbeatInput = Static<
	typeof HeadlessSessionHeartbeatSchema
>;
type HeadlessSessionDisconnectInput = Static<
	typeof HeadlessSessionDisconnectSchema
>;
type HeadlessMessageTypeInput = Static<typeof HeadlessMessageTypeSchema>;

async function parseHeadlessMessage(
	req: IncomingMessage,
): Promise<HeadlessToAgentMessage> {
	const raw = await readRequestBody(req);
	if (!raw.length) {
		throw new ApiError(400, "Request body required");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString());
	} catch {
		throw new ApiError(400, "Invalid JSON payload");
	}
	const envelope = validatePayload<HeadlessMessageTypeInput>(
		parsed,
		HeadlessMessageTypeSchema,
		"body",
	);
	return validatePayload<HeadlessToAgentMessage>(
		parsed,
		headlessToAgentMessageSchemasByType[envelope.type],
		"body",
	);
}

function getHeadlessRole(
	req: IncomingMessage,
	explicitRole?: HeadlessConnectionRole,
): HeadlessConnectionRole {
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

function getViewerDisallowedServerRequest(
	serverRequests?: Static<
		typeof HeadlessCreateBaseProperties.capabilities
	>["serverRequests"],
): "mcp_elicitation" | "user_input" | undefined {
	if (serverRequests?.includes("mcp_elicitation")) {
		return "mcp_elicitation";
	}
	if (serverRequests?.includes("user_input")) {
		return "user_input";
	}
	return undefined;
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

function getHeadlessConnectionId(req: IncomingMessage): string | undefined {
	return (
		getRequestHeader(
			req,
			"x-composer-headless-connection-id",
			"x-maestro-headless-connection-id",
		) ?? undefined
	);
}

function parseOptOutNotifications(
	req: IncomingMessage,
): HeadlessSessionSubscribeInput["optOutNotifications"] {
	const url = new URL(
		req.url || "/",
		`http://${req.headers.host || "localhost"}`,
	);
	const raw = url.searchParams.get("optOutNotifications");
	if (!raw) {
		return undefined;
	}
	const notifications = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (notifications.length === 0) {
		return undefined;
	}
	return validatePayload<
		NonNullable<HeadlessSessionSubscribeInput["optOutNotifications"]>
	>(
		notifications,
		HeadlessOptOutNotificationsSchema,
		"query.optOutNotifications",
	);
}

function getScopeKey(req: IncomingMessage): string {
	return getAuthSubject(req);
}

function ensureHostedRunnerCanUseSession(
	context: WebServerContext,
	requestedSessionId: string | undefined,
): void {
	const hostedRunner = context.hostedRunner;
	if (!hostedRunner) {
		return;
	}
	const activeSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	if (!activeSessionId) {
		return;
	}
	if (!requestedSessionId) {
		throw new ApiError(
			409,
			`Hosted runner is already bound to Maestro session ${activeSessionId}`,
		);
	}
	if (requestedSessionId !== activeSessionId) {
		throw new ApiError(
			409,
			`Hosted runner is bound to Maestro session ${activeSessionId}`,
		);
	}
}

function claimHostedRunnerSession(
	context: WebServerContext,
	sessionId: string,
): void {
	const hostedRunner = context.hostedRunner;
	if (!hostedRunner) {
		return;
	}
	const activeSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	if (activeSessionId && activeSessionId !== sessionId) {
		throw new ApiError(
			409,
			`Hosted runner is bound to Maestro session ${activeSessionId}`,
		);
	}
	hostedRunner.activeMaestroSessionId = sessionId;
}

function rethrowHeadlessMessageError(error: unknown): never {
	if (!(error instanceof Error)) {
		throw error;
	}
	if (error.message === "Viewer headless connections cannot send messages") {
		throw new ApiError(403, error.message);
	}
	if (error.message === "Headless subscriber not found") {
		throw new ApiError(404, error.message);
	}
	if (
		error.message === "Headless connection not found" ||
		error.message === "Headless connection does not have controller access" ||
		error.message.includes("is owned by another connection")
	) {
		throw new ApiError(403, error.message);
	}
	if (error.message.includes("Controller lease")) {
		throw new ApiError(409, error.message);
	}
	throw new ApiError(403, error.message);
}

function rethrowHeadlessConnectionLifecycleError(error: unknown): never {
	if (!(error instanceof Error)) {
		throw error;
	}
	if (error.message === "Headless connection not found") {
		throw new ApiError(404, error.message);
	}
	if (
		error.message.includes("Controller lease") ||
		error.message ===
			"Headless connection role does not match subscription role"
	) {
		throw new ApiError(409, error.message);
	}
	throw error;
}

async function ensureRuntime(
	req: IncomingMessage,
	context: WebServerContext,
	input: HeadlessSessionCreateInput & { registerConnection?: boolean },
) {
	const sessionManager = createSessionManagerForRequest(req, false);
	const role = getHeadlessRole(req, input.role);
	const requestedSessionId = input.sessionId?.trim() || undefined;
	ensureHostedRunnerCanUseSession(context, requestedSessionId);
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
	const disallowedViewerRequest = getViewerDisallowedServerRequest(
		input.capabilities?.serverRequests,
	);
	if (role === "viewer" && disallowedViewerRequest) {
		throw new ApiError(
			400,
			`viewer headless connections cannot negotiate ${disallowedViewerRequest} requests`,
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

	const runtime = await context.headlessRuntimeService.ensureRuntime({
		scope_key: getScopeKey(req),
		sessionId: requestedSessionId,
		subject,
		clientProtocolVersion: input.protocolVersion,
		clientInfo: input.clientInfo,
		capabilities: input.capabilities
			? {
					server_requests: input.capabilities.serverRequests,
					utility_operations: input.capabilities.utilityOperations,
					raw_agent_events: input.capabilities.rawAgentEvents,
				}
			: undefined,
		optOutNotifications: input.optOutNotifications,
		role,
		registeredModel,
		thinkingLevel: (input.thinkingLevel ?? "off") as ThinkingLevel,
		approvalMode: effectiveApproval,
		enableClientTools: input.enableClientTools,
		client: input.client,
		registerConnection: input.registerConnection ?? true,
		context,
		sessionManager,
	});
	claimHostedRunnerSession(context, runtime.getSnapshot().session_id);
	return runtime;
}

async function ensureConnection(
	req: IncomingMessage,
	context: WebServerContext,
	input: HeadlessConnectionCreateInput,
): Promise<HeadlessRuntimeConnectionSnapshot> {
	const runtime = await ensureRuntime(req, context, {
		...input,
		registerConnection: false,
	});
	const role = getHeadlessRole(req, input.role);
	const heartbeat = runtime.registerConnection({
		connectionId: input.connectionId,
		clientProtocolVersion: input.protocolVersion,
		clientInfo: input.clientInfo,
		capabilities: input.capabilities
			? {
					server_requests: input.capabilities.serverRequests,
					utility_operations: input.capabilities.utilityOperations,
					raw_agent_events: input.capabilities.rawAgentEvents,
				}
			: undefined,
		optOutNotifications: input.optOutNotifications,
		role,
		takeControl: input.takeControl,
	});
	const snapshot = runtime.getSnapshot();
	return {
		...heartbeat,
		session_id: snapshot.session_id,
		role,
		opt_out_notifications: input.optOutNotifications,
		snapshot,
	};
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
	claimHostedRunnerSession(context, runtime.getSnapshot().session_id);
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

export async function handleHeadlessConnectionCreate(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const input = await parseAndValidateJson<HeadlessConnectionCreateInput>(
		req,
		HeadlessConnectionCreateSchema,
	);
	let connection: HeadlessRuntimeConnectionSnapshot;
	try {
		connection = await ensureConnection(req, context, input);
	} catch (error) {
		rethrowHeadlessConnectionLifecycleError(error);
	}
	sendJson(res, 200, connection, context.corsHeaders, req);
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
	const disallowedViewerRequest = getViewerDisallowedServerRequest(
		input.capabilities?.serverRequests,
	);
	if (role === "viewer" && disallowedViewerRequest) {
		throw new ApiError(
			400,
			`viewer headless connections cannot negotiate ${disallowedViewerRequest} requests`,
		);
	}
	try {
		sendJson(
			res,
			200,
			runtime.createSubscription({
				connectionId: input.connectionId,
				role,
				explicit: true,
				takeControl: input.takeControl,
				clientProtocolVersion: input.protocolVersion,
				clientInfo: input.clientInfo,
				capabilities: input.capabilities
					? {
							server_requests: input.capabilities.serverRequests,
							utility_operations: input.capabilities.utilityOperations,
							raw_agent_events: input.capabilities.rawAgentEvents,
						}
					: undefined,
				optOutNotifications: input.optOutNotifications,
			}),
			context.corsHeaders,
			req,
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Controller lease is already held by another connection"
		) {
			throw new ApiError(409, error.message);
		}
		if (
			error instanceof Error &&
			(error.message === "Headless connection not found" ||
				error.message ===
					"Headless connection role does not match subscription role")
		) {
			throw new ApiError(400, error.message);
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
	if (!(await runtime.unsubscribe(input.subscriptionId))) {
		throw new ApiError(404, "Headless subscriber not found");
	}
	sendJson(res, 200, { success: true }, context.corsHeaders, req);
}

export async function handleHeadlessSessionHeartbeat(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessSessionHeartbeatInput>(
		req,
		HeadlessSessionHeartbeatSchema,
	);
	let heartbeat: HeadlessRuntimeHeartbeatSnapshot;
	try {
		heartbeat = runtime.heartbeatConnection({
			connectionId: input.connectionId ?? getHeadlessConnectionId(req),
			subscriptionId: input.subscriptionId ?? getHeadlessSubscriberId(req),
		});
	} catch (error) {
		rethrowHeadlessConnectionLifecycleError(error);
	}
	sendJson(res, 200, heartbeat, context.corsHeaders, req);
}

export async function handleHeadlessSessionDisconnect(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessSessionDisconnectInput>(
		req,
		HeadlessSessionDisconnectSchema,
	);
	try {
		sendJson(
			res,
			200,
			await runtime.disconnectConnection({
				connectionId: input.connectionId ?? getHeadlessConnectionId(req),
				subscriptionId: input.subscriptionId ?? getHeadlessSubscriberId(req),
			}),
			context.corsHeaders,
			req,
		);
	} catch (error) {
		rethrowHeadlessConnectionLifecycleError(error);
	}
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
				optOutNotifications: parseOptOutNotifications(req),
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
	const input = await parseHeadlessMessage(req);
	try {
		runtime.assertCanSend(
			getHeadlessRole(req),
			getHeadlessSubscriberId(req),
			getHeadlessConnectionId(req),
		);
	} catch (error) {
		rethrowHeadlessMessageError(error);
	}
	try {
		await runtime.send(input as HeadlessToAgentMessage, {
			connectionId: getHeadlessConnectionId(req),
			subscriptionId: getHeadlessSubscriberId(req),
		});
	} catch (error) {
		rethrowHeadlessMessageError(error);
	}
	sendJson(res, 200, { success: true }, context.corsHeaders, req);
}
