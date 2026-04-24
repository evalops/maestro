import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type ComposerPendingRequestKind,
	type ComposerPendingRequestPlatformOperation,
	type ComposerPendingRequestResolution,
	type ComposerPendingRequestResumeRequest,
	ComposerPendingRequestResumeRequestSchema,
	type ComposerPendingRequestResumeResponse,
} from "@evalops/contracts";
import type { WebServerContext } from "../app-context.js";
import {
	type PendingServerRequestSnapshot,
	serverRequestManager,
} from "../server-request-manager.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

type PendingRequestRouteParams = {
	requestId?: string;
};

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
		return request.platform.source === "tool_execution"
			? "ResumeToolExecution"
			: "ResolveApproval";
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
): ComposerPendingRequestResumeResponse {
	return {
		success: true,
		request: {
			id: request.id,
			kind: request.kind,
			sessionId: request.sessionId,
			resolution,
			source: request.platform ? "platform" : "local",
			platform: request.platform,
			platformOperation: platformOperationFor(request),
		},
	};
}

export async function handlePendingRequestResume(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params: PendingRequestRouteParams,
) {
	const { corsHeaders } = context;

	try {
		if (req.method !== "POST") {
			res.writeHead(405, corsHeaders);
			res.end();
			return;
		}

		const requestId = decodeRequestId(params);
		const input =
			await parseAndValidateJson<ComposerPendingRequestResumeRequest>(
				req,
				ComposerPendingRequestResumeRequestSchema,
			);
		const pendingRequest = serverRequestManager.get(requestId);
		if (!pendingRequest) {
			throw new ApiError(404, "Pending request not found or already resolved");
		}

		assertRequestKind(pendingRequest.kind, input.kind);
		assertSessionMatch(pendingRequest, input.sessionId);

		let resolved = false;
		let resolution: ComposerPendingRequestResolution;

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
				resolved = serverRequestManager.resolveClientTool(
					requestId,
					content,
					isError,
				);
				resolution = resolutionForClientRequest(pendingRequest.kind, isError);
				break;
			}
		}

		if (!resolved) {
			throw new ApiError(404, "Pending request not found or already resolved");
		}

		sendJson(
			res,
			200,
			responseFor(pendingRequest, resolution),
			corsHeaders,
			req,
		);
	} catch (error) {
		respondWithApiError(res, error, 400, corsHeaders, req);
	}
}
