import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebServerContext } from "../app-context.js";
import { sendJson } from "../server-utils.js";

export function handleFleet(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
): void {
	if (req.method !== "GET") {
		sendJson(
			res,
			405,
			{ error: "Method not allowed" },
			context.corsHeaders,
			req,
		);
		return;
	}

	sendJson(
		res,
		200,
		context.headlessRuntimeService.getFleetDashboardSnapshot(),
		context.corsHeaders,
		req,
	);
}
