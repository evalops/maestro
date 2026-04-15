import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import type { WebServerContext } from "../app-context.js";
import { serverRequestManager } from "../server-request-manager.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

const ToolRetryDecisionSchema = Type.Object({
	requestId: Type.String(),
	action: Type.Union([
		Type.Literal("retry"),
		Type.Literal("skip"),
		Type.Literal("abort"),
	]),
	reason: Type.Optional(Type.String()),
});

type ToolRetryDecisionInput = Static<typeof ToolRetryDecisionSchema>;

export async function handleToolRetry(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const { corsHeaders } = context;

	try {
		if (req.method !== "POST") {
			res.writeHead(405, corsHeaders);
			res.end();
			return;
		}

		const body = await parseAndValidateJson<ToolRetryDecisionInput>(
			req,
			ToolRetryDecisionSchema,
		);

		const resolved = serverRequestManager.resolveToolRetry(body.requestId, {
			action: body.action,
			reason: body.reason,
			resolvedBy: "user",
		});

		if (!resolved) {
			sendJson(
				res,
				404,
				{ error: "Tool retry request not found or already resolved" },
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
