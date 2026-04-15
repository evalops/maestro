import type { IncomingMessage, ServerResponse } from "node:http";
import {
	getTelemetryStatus,
	setTelemetryRuntimeOverride,
} from "../../telemetry.js";
import { readJsonBody, sendJson } from "../server-utils.js";

export async function handleTelemetry(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const status = getTelemetryStatus();
		sendJson(res, 200, status, corsHeaders);
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{
				action?: "on" | "off" | "reset";
			}>(req);

			const action = data.action || "status";

			if (action === "on") {
				setTelemetryRuntimeOverride(true, "enabled via /api/telemetry");
			} else if (action === "off") {
				setTelemetryRuntimeOverride(false, "disabled via /api/telemetry");
			} else if (action === "reset") {
				setTelemetryRuntimeOverride(null, undefined);
			}

			const status = getTelemetryStatus();
			sendJson(
				res,
				200,
				{
					success: true,
					status,
					message: `Telemetry ${action === "on" ? "enabled" : action === "off" ? "disabled" : "reset"}`,
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
						error: "Failed to update telemetry settings",
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
