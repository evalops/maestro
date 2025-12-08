import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import type { WebServerContext } from "../app-context.js";
import { clientToolService } from "../client-tools-service.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

// Define content item schema matching TextContent | ImageContent
const ContentItemSchema = Type.Union([
	Type.Object({
		type: Type.Literal("text"),
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("image"),
		data: Type.String(),
		mimeType: Type.String(),
	}),
]);

const ClientToolResultSchema = Type.Object({
	toolCallId: Type.String(),
	content: Type.Array(ContentItemSchema),
	isError: Type.Boolean(),
});

type ClientToolResultInput = Static<typeof ClientToolResultSchema>;

export async function handleClientToolResult(
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

		const body = await parseAndValidateJson<ClientToolResultInput>(
			req,
			ClientToolResultSchema,
		);

		const resolved = clientToolService.resolve(
			body.toolCallId,
			body.content,
			body.isError,
		);

		if (resolved) {
			sendJson(res, 200, { success: true }, corsHeaders, req);
		} else {
			sendJson(
				res,
				404,
				{ error: "Tool call not found or timed out" },
				corsHeaders,
				req,
			);
		}
	} catch (error) {
		respondWithApiError(res, error, 400, corsHeaders, req);
	}
}
