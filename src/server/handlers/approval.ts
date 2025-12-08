import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import type { WebServerContext } from "../app-context.js";
import { approvalStore } from "../approval-store.js";
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
		const service = approvalStore.get(body.requestId);

		if (!service) {
			sendJson(
				res,
				404,
				{ error: "Approval request not found or already resolved" },
				corsHeaders,
				req,
			);
			return;
		}

		if (body.decision === "approved") {
			service.approve(body.requestId, body.reason);
		} else {
			service.deny(body.requestId, body.reason);
		}

		sendJson(res, 200, { success: true }, corsHeaders, req);
	} catch (error) {
		respondWithApiError(res, error, 400, corsHeaders, req);
	}
}
