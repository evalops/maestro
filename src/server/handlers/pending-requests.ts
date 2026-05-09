import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type ComposerPendingRequestKind,
	type ComposerPendingRequestPlatformOperation,
	type ComposerPendingRequestResolution,
	type ComposerPendingRequestResumeRequest,
	ComposerPendingRequestResumeRequestSchema,
	type ComposerPendingRequestResumeResponse,
} from "@evalops/contracts";
import { resumeAgentRuntimeRun } from "../../platform/agent-runtime-client.js";
import { isAbortError } from "../../utils/abort-error.js";
import type { WebServerContext } from "../app-context.js";
import { getAuthSubject } from "../authz.js";
import {
	type PendingServerRequestSnapshot,
	serverRequestManager,
} from "../server-request-manager.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

type PendingRequestRouteParams = {
	requestId?: string;
};

type PendingRequestPlatformResumeOperations = {
	resumeRun?: typeof resumeAgentRuntimeRun;
};

type PendingRequestResumeContext = WebServerContext & {
	platformPendingRequestResume?: PendingRequestPlatformResumeOperations;
};

type PlatformResumeRetry = {
	content: NonNullable<ComposerPendingRequestResumeRequest["content"]>;
	isError: boolean;
	request: PendingServerRequestSnapshot;
	resolution: ComposerPendingRequestResolution;
};

const RESOLVED_RESPONSE_CACHE_TTL_MS = 60_000;
const PLATFORM_RETRY_CACHE_TTL_MS = 30 * 60_000;
const resolvedResponseCache = new Map<
	string,
	{
		expiresAt: number;
		inputFingerprint: string;
		platformRetry?: PlatformResumeRetry;
		response: ComposerPendingRequestResumeResponse;
		subject: string;
	}
>();
const inFlightResumes = new Map<
	string,
	{
		inputFingerprint: string;
		promise: Promise<ComposerPendingRequestResumeResponse>;
		requestKind: ComposerPendingRequestKind;
		sessionId?: string;
		subject: string;
	}
>();

class PendingRequestResolvedPlatformError extends ApiError {
	constructor(
		message: string,
		readonly response: ComposerPendingRequestResumeResponse,
		readonly platformRetry: PlatformResumeRetry,
	) {
		super(502, message);
	}
}

function safeIdPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 96) || "unknown";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function pruneResolvedResponseCache(now = Date.now()): void {
	for (const [requestId, cached] of resolvedResponseCache) {
		if (cached.expiresAt <= now) {
			resolvedResponseCache.delete(requestId);
		}
	}
}

function rememberResolvedResponse(
	requestId: string,
	input: ComposerPendingRequestResumeRequest,
	response: ComposerPendingRequestResumeResponse,
	subject: string,
	platformRetry?: PlatformResumeRetry,
	now = Date.now(),
): void {
	pruneResolvedResponseCache(now);
	resolvedResponseCache.set(requestId, {
		expiresAt:
			now +
			(platformRetry
				? PLATFORM_RETRY_CACHE_TTL_MS
				: RESOLVED_RESPONSE_CACHE_TTL_MS),
		inputFingerprint: resumeInputFingerprint(input, response.request),
		platformRetry,
		response,
		subject,
	});
}

function getCachedResolvedEntry(
	requestId: string,
	input: ComposerPendingRequestResumeRequest,
	subject: string,
	now = Date.now(),
):
	| {
			expiresAt: number;
			inputFingerprint: string;
			platformRetry?: PlatformResumeRetry;
			response: ComposerPendingRequestResumeResponse;
			subject: string;
	  }
	| undefined {
	pruneResolvedResponseCache(now);
	const cached = resolvedResponseCache.get(requestId);
	if (!cached) {
		return undefined;
	}
	if (cached.subject !== subject) {
		return undefined;
	}
	if (input.kind && input.kind !== cached.response.request.kind) {
		return undefined;
	}
	if (!cachedResponseSessionMatchesInput(cached.response, input)) {
		return undefined;
	}
	if (
		cached.inputFingerprint !==
		resumeInputFingerprint(input, cached.response.request)
	) {
		return undefined;
	}
	return cached;
}

function cachedResponseSessionMatchesInput(
	response: ComposerPendingRequestResumeResponse,
	input: ComposerPendingRequestResumeRequest,
): boolean {
	if (!input.sessionId) {
		return true;
	}
	return response.request.sessionId === input.sessionId;
}

function resumeInputFingerprint(
	input: ComposerPendingRequestResumeRequest,
	request?: { kind?: ComposerPendingRequestKind; sessionId?: string },
): string {
	return JSON.stringify({
		kind: input.kind ?? request?.kind,
		sessionId: input.sessionId ?? request?.sessionId,
		decision: input.decision,
		action: input.action,
		content: input.content,
		isError: input.isError === true,
		reason: input.reason,
	});
}

function getMatchingInFlightResume(
	requestId: string,
	input: ComposerPendingRequestResumeRequest,
	subject: string,
): Promise<ComposerPendingRequestResumeResponse> | undefined {
	const inFlight = inFlightResumes.get(requestId);
	if (!inFlight) {
		return undefined;
	}
	const inputFingerprint = resumeInputFingerprint(input, {
		kind: inFlight.requestKind,
		sessionId: inFlight.sessionId,
	});
	if (
		inFlight.subject === subject &&
		inFlight.inputFingerprint === inputFingerprint
	) {
		return inFlight.promise;
	}
	throw new ApiError(409, "Pending request resume already in progress");
}

function decodeRequestId(params: PendingRequestRouteParams): string {
	const raw = params.requestId?.trim();
	if (!raw) {
		throw new ApiError(400, "Pending request id is required");
	}
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new ApiError(400, "Pending request id is invalid");
	}
}

function assertRequestKind(
	actual: ComposerPendingRequestKind,
	expected: ComposerPendingRequestKind | undefined,
): void {
	if (expected && expected !== actual) {
		throw new ApiError(
			400,
			`Pending request ${expected} resolver cannot resume ${actual} request`,
		);
	}
}

function assertSessionMatch(
	request: PendingServerRequestSnapshot,
	sessionId: string | undefined,
): void {
	if (sessionId && request.sessionId && sessionId !== request.sessionId) {
		throw new ApiError(404, "Pending request not found for session");
	}
}

function requireApprovalDecision(
	input: ComposerPendingRequestResumeRequest,
): "approved" | "denied" {
	if (input.decision !== "approved" && input.decision !== "denied") {
		throw new ApiError(400, "Approval resume requires decision");
	}
	return input.decision;
}

function requireRetryAction(
	input: ComposerPendingRequestResumeRequest,
): "retry" | "skip" | "abort" {
	if (
		input.action !== "retry" &&
		input.action !== "skip" &&
		input.action !== "abort"
	) {
		throw new ApiError(400, "Tool retry resume requires action");
	}
	return input.action;
}

function requireClientToolContent(
	input: ComposerPendingRequestResumeRequest,
): NonNullable<ComposerPendingRequestResumeRequest["content"]> {
	if (!Array.isArray(input.content)) {
		throw new ApiError(400, "Client request resume requires content");
	}
	return input.content;
}

function resolutionForClientRequest(
	kind: PendingServerRequestSnapshot["kind"],
	isError: boolean,
): ComposerPendingRequestResolution {
	if (isError) {
		return "failed";
	}
	if (kind === "mcp_elicitation" || kind === "user_input") {
		return "answered";
	}
	return "completed";
}

function platformOperationFor(
	request: PendingServerRequestSnapshot,
): ComposerPendingRequestPlatformOperation | undefined {
	if (!request.platform) {
		return undefined;
	}
	if (request.kind === "approval") {
		return request.platform.source === "approvals_service"
			? "ResolveApproval"
			: undefined;
	}
	if (
		request.kind === "client_tool" ||
		request.kind === "mcp_elicitation" ||
		request.kind === "user_input"
	) {
		return "ResumeRun";
	}
	return undefined;
}

function responseFor(
	request: PendingServerRequestSnapshot,
	resolution: ComposerPendingRequestResolution,
	platformOperation?: ComposerPendingRequestPlatformOperation,
): ComposerPendingRequestResumeResponse {
	const operation = platformOperation ?? platformOperationFor(request);
	return {
		success: true,
		request: {
			id: request.id,
			kind: request.kind,
			sessionId: request.sessionId,
			resolution,
			source:
				Boolean(request.platform) || operation === "ResumeRun"
					? "platform"
					: "local",
			platform: request.platform,
			platformOperation: operation,
		},
	};
}

function isAgentRuntimeWaitKind(
	kind: PendingServerRequestSnapshot["kind"],
): kind is "client_tool" | "mcp_elicitation" | "user_input" {
	return (
		kind === "client_tool" ||
		kind === "mcp_elicitation" ||
		kind === "user_input"
	);
}

function hostedSessionIdForRequest(
	request: PendingServerRequestSnapshot,
	context: PendingRequestResumeContext,
): string | undefined {
	return (
		nonEmptyString(request.sessionId) ??
		nonEmptyString(context.hostedRunner?.activeMaestroSessionId) ??
		nonEmptyString(context.hostedRunner?.configuredMaestroSessionId)
	);
}

function hostedAgentRunIdForRequest(
	request: PendingServerRequestSnapshot,
	context: PendingRequestResumeContext,
): string | undefined {
	const hosted = context.hostedRunner;
	const runId = nonEmptyString(hosted?.agentRunId);
	if (!hosted?.enabled || !runId) {
		return undefined;
	}
	const hostedSessionId =
		nonEmptyString(hosted.activeMaestroSessionId) ??
		nonEmptyString(hosted.configuredMaestroSessionId);
	if (
		hostedSessionId &&
		request.sessionId &&
		hostedSessionId !== request.sessionId
	) {
		return undefined;
	}
	return runId;
}

function hostedWaitId(sessionId: string, requestId: string): string {
	return `maestro:${safeIdPart(sessionId)}:wait:${safeIdPart(requestId)}`;
}

function hostedResumeEventId(sessionId: string, requestId: string): string {
	return `maestro:${safeIdPart(sessionId)}:resume:${safeIdPart(requestId)}`;
}

function platformResumeError(message: string): ApiError {
	return new ApiError(502, `${message}; local pending request was resolved`);
}

async function resumePlatformAgentRuntimeWait(
	request: PendingServerRequestSnapshot,
	resolution: ComposerPendingRequestResolution,
	content: NonNullable<ComposerPendingRequestResumeRequest["content"]>,
	isError: boolean,
	context: PendingRequestResumeContext,
): Promise<ComposerPendingRequestPlatformOperation | undefined> {
	if (!isAgentRuntimeWaitKind(request.kind)) {
		return undefined;
	}
	const runId = hostedAgentRunIdForRequest(request, context);
	const sessionId = hostedSessionIdForRequest(request, context);
	if (!runId || !sessionId) {
		return undefined;
	}
	const resumeRun =
		context.platformPendingRequestResume?.resumeRun ?? resumeAgentRuntimeRun;
	try {
		await resumeRun({
			runId,
			waitId: hostedWaitId(sessionId, request.id),
			resumeEventId: hostedResumeEventId(sessionId, request.id),
			payload: {
				maestro_session_id: sessionId,
				request_id: request.id,
				request_type: request.kind,
				call_id: request.callId,
				tool_name: request.toolName,
				resolution,
				resolved_by: "user",
				is_error: isError,
				content,
			},
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		throw platformResumeError("Platform AgentRuntime resume failed");
	}
	return "ResumeRun";
}

async function resolvePendingRequest(
	requestId: string,
	input: ComposerPendingRequestResumeRequest,
	pendingRequest: PendingServerRequestSnapshot,
	context: PendingRequestResumeContext,
): Promise<ComposerPendingRequestResumeResponse> {
	assertRequestKind(pendingRequest.kind, input.kind);
	assertSessionMatch(pendingRequest, input.sessionId);

	let resolved = false;
	let resolution: ComposerPendingRequestResolution;
	let platformOperation: ComposerPendingRequestPlatformOperation | undefined;

	switch (pendingRequest.kind) {
		case "approval": {
			const decision = requireApprovalDecision(input);
			resolved = serverRequestManager.resolveApproval(requestId, {
				approved: decision === "approved",
				reason: input.reason,
				resolvedBy: "user",
			});
			resolution = decision;
			break;
		}
		case "tool_retry": {
			const action = requireRetryAction(input);
			resolved = serverRequestManager.resolveToolRetry(requestId, {
				action,
				reason: input.reason,
				resolvedBy: "user",
			});
			resolution =
				action === "retry"
					? "retried"
					: action === "skip"
						? "skipped"
						: "aborted";
			break;
		}
		case "client_tool":
		case "mcp_elicitation":
		case "user_input": {
			const content = requireClientToolContent(input);
			const isError = input.isError === true;
			resolution = resolutionForClientRequest(pendingRequest.kind, isError);
			const claimed = serverRequestManager.claimClientTool(requestId);
			if (!claimed) {
				break;
			}
			resolved = claimed.resolve(content, isError);
			if (!resolved) {
				break;
			}
			try {
				platformOperation = await resumePlatformAgentRuntimeWait(
					claimed.request,
					resolution,
					content,
					isError,
					context,
				);
			} catch (error) {
				const localResponse = responseFor(claimed.request, resolution);
				if (isAbortError(error)) {
					return localResponse;
				}
				const message =
					error instanceof Error
						? error.message
						: "Platform AgentRuntime resume failed";
				throw new PendingRequestResolvedPlatformError(message, localResponse, {
					content,
					isError,
					request: claimed.request,
					resolution,
				});
			}
			break;
		}
	}

	if (!resolved) {
		throw new ApiError(404, "Pending request not found or already resolved");
	}

	return responseFor(pendingRequest, resolution, platformOperation);
}

async function replayCachedPlatformRetry(
	requestId: string,
	input: ComposerPendingRequestResumeRequest,
	cached: {
		platformRetry: PlatformResumeRetry;
		response: ComposerPendingRequestResumeResponse;
	},
	subject: string,
	context: PendingRequestResumeContext,
): Promise<ComposerPendingRequestResumeResponse> {
	const retry = cached.platformRetry;
	try {
		const platformOperation = await resumePlatformAgentRuntimeWait(
			retry.request,
			retry.resolution,
			retry.content,
			retry.isError,
			context,
		);
		const response = responseFor(
			retry.request,
			retry.resolution,
			platformOperation,
		);
		rememberResolvedResponse(requestId, input, response, subject);
		return response;
	} catch (error) {
		if (isAbortError(error)) {
			return cached.response;
		}
		rememberResolvedResponse(requestId, input, cached.response, subject, retry);
		throw error;
	}
}

export async function handlePendingRequestResume(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params: PendingRequestRouteParams,
) {
	const { corsHeaders } = context;
	let requestId: string | undefined;
	let input: ComposerPendingRequestResumeRequest | undefined;
	let subject: string | undefined;

	try {
		if (req.method !== "POST") {
			res.writeHead(405, corsHeaders);
			res.end();
			return;
		}

		requestId = decodeRequestId(params);
		input = await parseAndValidateJson<ComposerPendingRequestResumeRequest>(
			req,
			ComposerPendingRequestResumeRequestSchema,
		);
		subject = getAuthSubject(req);
		const currentRequestId = requestId;
		const currentInput = input;
		const currentSubject = subject;
		const inFlight = getMatchingInFlightResume(
			currentRequestId,
			currentInput,
			currentSubject,
		);
		if (inFlight) {
			sendJson(res, 200, await inFlight, corsHeaders, req);
			return;
		}

		const pendingRequest = serverRequestManager.get(currentRequestId);
		if (!pendingRequest) {
			const cached = getCachedResolvedEntry(
				currentRequestId,
				currentInput,
				currentSubject,
			);
			if (cached) {
				if (cached.platformRetry) {
					const retryPromise = replayCachedPlatformRetry(
						currentRequestId,
						currentInput,
						{
							platformRetry: cached.platformRetry,
							response: cached.response,
						},
						currentSubject,
						context as PendingRequestResumeContext,
					);
					inFlightResumes.set(currentRequestId, {
						inputFingerprint: cached.inputFingerprint,
						promise: retryPromise,
						requestKind: cached.response.request.kind,
						sessionId: cached.response.request.sessionId,
						subject: currentSubject,
					});
					try {
						const response = await retryPromise;
						sendJson(res, 200, response, corsHeaders, req);
						return;
					} catch (error) {
						respondWithApiError(res, error, 400, corsHeaders, req);
						return;
					} finally {
						if (
							inFlightResumes.get(currentRequestId)?.promise === retryPromise
						) {
							inFlightResumes.delete(currentRequestId);
						}
					}
				}
				sendJson(res, 200, cached.response, corsHeaders, req);
				return;
			}
			throw new ApiError(404, "Pending request not found or already resolved");
		}

		const inputFingerprint = resumeInputFingerprint(input, pendingRequest);
		const resumeContext = context as PendingRequestResumeContext;
		const resumePromise = resolvePendingRequest(
			currentRequestId,
			currentInput,
			pendingRequest,
			resumeContext,
		).then((response) => {
			rememberResolvedResponse(
				currentRequestId,
				currentInput,
				response,
				currentSubject,
			);
			return response;
		});
		inFlightResumes.set(currentRequestId, {
			inputFingerprint,
			promise: resumePromise,
			requestKind: pendingRequest.kind,
			sessionId: pendingRequest.sessionId,
			subject: currentSubject,
		});
		let response: ComposerPendingRequestResumeResponse;
		try {
			response = await resumePromise;
		} finally {
			if (inFlightResumes.get(currentRequestId)?.promise === resumePromise) {
				inFlightResumes.delete(currentRequestId);
			}
		}
		sendJson(res, 200, response, corsHeaders, req);
	} catch (error) {
		if (
			error instanceof PendingRequestResolvedPlatformError &&
			requestId &&
			input &&
			subject
		) {
			rememberResolvedResponse(
				requestId,
				input,
				error.response,
				subject,
				error.platformRetry,
			);
		}
		respondWithApiError(res, error, 400, corsHeaders, req);
	}
}
