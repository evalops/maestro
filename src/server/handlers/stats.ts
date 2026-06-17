import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeWithStaticMask } from "../../utils/secret-redactor.js";
import { sendJson } from "../server-utils.js";
import { getStatusSnapshot } from "./status.js";
import { getUsageSnapshot } from "./usage.js";

export async function handleStats(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	try {
		const status = await getStatusSnapshot();
		const usage = getUsageSnapshot();
		sendJson(
			res,
			200,
			{
				status,
				usage,
				updatedAt: Date.now(),
			},
			corsHeaders,
			req,
		);
	} catch (error) {
		sendJson(
			res,
			500,
			{
				error: sanitizeWithStaticMask(
					error instanceof Error ? error.message : String(error),
				),
			},
			corsHeaders,
			req,
		);
	}
}
