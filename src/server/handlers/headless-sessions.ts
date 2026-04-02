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
import { ApiError, getRequestHeader, sendJson } from "../server-utils.js";
import { createSessionManagerForRequest } from "../session-scope.js";
import { parseAndValidateJson } from "../validation.js";

const HeadlessSessionCreateSchema = Type.Object({
	sessionId: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
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

type HeadlessSessionCreateInput = Static<typeof HeadlessSessionCreateSchema>;
type HeadlessMessageInput = Static<typeof HeadlessMessageSchema>;

function writeSse(res: ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
		registeredModel,
		thinkingLevel: (input.thinkingLevel ?? "off") as ThinkingLevel,
		approvalMode: effectiveApproval,
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

	if (cursor !== null && Number.isFinite(cursor)) {
		const replay = runtime.replayFrom(cursor);
		if (replay) {
			for (const envelope of replay) {
				writeSse(res, envelope);
			}
		} else {
			writeSse(res, {
				type: "snapshot",
				snapshot: runtime.getSnapshot(),
			});
		}
	} else {
		writeSse(res, {
			type: "snapshot",
			snapshot: runtime.getSnapshot(),
		});
	}

	const unsubscribe = runtime.subscribe((envelope) => {
		if (!res.writableEnded) {
			writeSse(res, envelope);
		}
	});
	const heartbeat = setInterval(() => {
		if (!res.writableEnded) {
			writeSse(res, runtime.heartbeat());
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
	const runtime = getRuntime(req, context, params?.id);
	const input = await parseAndValidateJson<HeadlessMessageInput>(
		req,
		HeadlessMessageSchema,
	);
	await runtime.send(input as HeadlessToAgentMessage);
	sendJson(res, 200, { success: true }, context.corsHeaders, req);
}
