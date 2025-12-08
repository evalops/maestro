import type { IncomingMessage, ServerResponse } from "node:http";
import {
	getTrainingStatus,
	optIntoTraining,
	optOutOfTraining,
	resetTrainingRuntimeOverride,
} from "../../training.js";
import { readJsonBody, sendJson } from "../server-utils.js";

export async function handleTraining(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const status = getTrainingStatus();
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
				optIntoTraining("enabled via /api/training");
			} else if (action === "off") {
				optOutOfTraining("disabled via /api/training");
			} else if (action === "reset") {
				resetTrainingRuntimeOverride();
			}

			const status = getTrainingStatus();
			sendJson(
				res,
				200,
				{
					success: true,
					status,
					message: `Training preference ${action === "on" ? "opted-in" : action === "off" ? "opted-out" : "reset"}`,
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
						error: "Failed to update training preference",
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
