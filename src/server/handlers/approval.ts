import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import type { WebServerContext } from "../app-context.js";
import { serverRequestManager } from "../server-request-manager.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

const ApprovalSchema = Type.Object({
	requestId: Type.String(),
	decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
	reason: Type.Optional(Type.String()),
});

type ApprovalInput = Static<typeof ApprovalSchema>;

export async function handleApproval(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const { corsHeaders } = context;

	try {
		const body = await parseAndValidateJson<ApprovalInput>(req, ApprovalSchema);
		const resolved = serverRequestManager.resolveApproval(body.requestId, {
			approved: body.decision === "approved",
			reason: body.reason,
			resolvedBy: "user",
		});

		if (!resolved) {
			sendJson(
				res,
				404,
				{ error: "Approval request not found or already resolved" },
				corsHeaders,
				req,
			);
			return;
		}

		sendJson(res, 200, { success: true }, corsHeaders, req);
	} catch (error) {
		respondWithApiError(res, error, 400, corsHeaders, req);
	}
}
