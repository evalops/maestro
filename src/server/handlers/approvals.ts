import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalMode } from "../../agent/action-approval.js";
import type { WebServerContext } from "../app-context.js";
import {
	getApprovalModeForSession,
	normalizeApprovalSessionId,
	setApprovalModeForSession,
} from "../approval-mode-store.js";
import { getAuthSubject } from "../authz.js";
import { ApiError, sendJson } from "../server-utils.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import {
	type ApprovalsUpdateRequestInput,
	ApprovalsUpdateRequestSchema,
	parseAndValidateJson,
} from "../validation.js";

const approvalSessionIdPattern = /^[A-Za-z0-9._-]+$/;

function verifySessionOwnership(
	session: { owner?: unknown; subject?: unknown },
	subject: string,
): boolean {
	if (typeof session.owner === "string" && session.owner) {
		return session.owner === subject;
	}
	if (typeof session.subject === "string" && session.subject) {
		return session.subject === subject;
	}
	const strictMode = process.env.MAESTRO_STRICT_SESSION_ACCESS !== "false";
	return !strictMode;
}

function assertApprovalSessionId(sessionId: string): void {
	if (!approvalSessionIdPattern.test(sessionId)) {
		throw new ApiError(400, "Invalid session id");
	}
}

async function ensureApprovalSessionAccess(
	req: IncomingMessage,
	sessionId: string,
	subject: string,
): Promise<{ statusCode: number; error: string } | null> {
	if (sessionId === "default") {
		return null;
	}

	const sessionManager = createWebSessionManagerForRequest(req, false);
	const session = await sessionManager.loadSession(sessionId);
	if (!session) {
		return null;
	}

	if (!verifySessionOwnership(session, subject)) {
		return {
			statusCode: 403,
			error: "Access denied: session belongs to another user",
		};
	}

	return null;
}

export async function handleApprovals(
	req: IncomingMessage,
	res: ServerResponse,
	context: Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
) {
	const { corsHeaders, defaultApprovalMode } = context;
	const subject = getAuthSubject(req);
	const url = new URL(
		req.url || "/api/approvals",
		`http://${req.headers.host}`,
	);
	const querySessionId = url.searchParams.get("sessionId");

	if (req.method === "GET") {
		try {
			const sessionId = normalizeApprovalSessionId(querySessionId);
			assertApprovalSessionId(sessionId);
			const accessError = await ensureApprovalSessionAccess(
				req,
				sessionId,
				subject,
			);
			if (accessError) {
				sendJson(
					res,
					accessError.statusCode,
					{ error: accessError.error },
					corsHeaders,
				);
				return;
			}
			const mode = getApprovalModeForSession(
				sessionId,
				defaultApprovalMode,
				subject,
			);

			sendJson(
				res,
				200,
				{
					mode,
					availableModes: ["auto", "prompt", "fail"],
				},
				corsHeaders,
			);
		} catch (error) {
			sendJson(
				res,
				400,
				{ error: error instanceof Error ? error.message : String(error) },
				corsHeaders,
			);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await parseAndValidateJson<ApprovalsUpdateRequestInput>(
				req,
				ApprovalsUpdateRequestSchema,
			);
			const sessionId = normalizeApprovalSessionId(
				data.sessionId ?? querySessionId,
			);
			assertApprovalSessionId(sessionId);
			const accessError = await ensureApprovalSessionAccess(
				req,
				sessionId,
				subject,
			);
			if (accessError) {
				sendJson(
					res,
					accessError.statusCode,
					{ error: accessError.error },
					corsHeaders,
				);
				return;
			}
			const mode = data.mode;
			const effectiveMode = setApprovalModeForSession(
				sessionId,
				mode as ApprovalMode,
				{
					subject,
					defaultApprovalMode,
				},
			);

			sendJson(
				res,
				200,
				{
					success: true,
					mode: effectiveMode,
					message:
						effectiveMode === mode
							? `Approval mode set to ${mode}`
							: `Approval mode resolved to ${effectiveMode} because the server default is stricter`,
				},
				corsHeaders,
			);
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) {
				sendJson(
					res,
					(error as { statusCode: number }).statusCode,
					{ error: error.message },
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					500,
					{
						error: "Failed to update approval mode",
						details: error instanceof Error ? error.message : String(error),
					},
					corsHeaders,
				);
			}
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
