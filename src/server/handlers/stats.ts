import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../server-utils.js";
import { handleStatus } from "./status.js";
import { handleUsage } from "./usage.js";

export async function handleStats(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	// Combine status and usage data
	// In a real implementation, we'd call the handlers and combine results
	// For now, return a structure indicating this combines status + usage
	sendJson(
		res,
		200,
		{
			message:
				"Stats combines /api/status and /api/usage. Call those endpoints separately and combine client-side.",
			endpoints: {
				status: "/api/status",
				usage: "/api/usage",
			},
		},
		corsHeaders,
	);
}
