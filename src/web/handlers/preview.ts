import type { IncomingMessage, ServerResponse } from "node:http";
import { respondWithApiError, sendJson } from "../server-utils.js";

export async function handlePreview(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/preview",
			`http://${req.headers.host || "localhost"}`,
		);

		try {
			// Git preview functionality would require git integration
			// This is a placeholder that returns a message
			sendJson(
				res,
				200,
				{
					message: "Git preview functionality (placeholder)",
					note: "This endpoint requires git integration",
				},
				corsHeaders,
			);
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
