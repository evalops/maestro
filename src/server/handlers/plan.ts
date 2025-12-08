import type { IncomingMessage, ServerResponse } from "node:http";
import {
	enterPlanMode,
	exitPlanMode,
	loadPlanModeState,
	readPlanFile,
	writePlanFile,
} from "../../agent/plan-mode.js";
import { readJsonBody, sendJson } from "../server-utils.js";

export async function handlePlan(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const state = loadPlanModeState();
		const content = readPlanFile();

		sendJson(
			res,
			200,
			{
				state,
				content,
			},
			corsHeaders,
		);
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{
				action?: string;
				name?: string;
				sessionId?: string;
				content?: string;
			}>(req);
			const { action } = data;

			if (action === "enter") {
				const state = enterPlanMode({
					name: data.name,
					sessionId: data.sessionId,
				});
				sendJson(res, 200, { success: true, state }, corsHeaders);
			} else if (action === "exit") {
				const state = exitPlanMode();
				sendJson(res, 200, { success: true, state }, corsHeaders);
			} else if (action === "update") {
				if (typeof data.content !== "string") {
					sendJson(
						res,
						400,
						{ error: "Content is required for update" },
						corsHeaders,
					);
					return;
				}
				const success = writePlanFile(data.content);
				if (success) {
					sendJson(res, 200, { success: true }, corsHeaders);
				} else {
					sendJson(
						res,
						400,
						{
							error: "Failed to write plan file (plan mode might be inactive)",
						},
						corsHeaders,
					);
				}
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use 'enter', 'exit', or 'update'" },
					corsHeaders,
				);
			}
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) {
				// ApiError from readJsonBody
				sendJson(
					res,
					(error as { statusCode: number }).statusCode,
					{
						error: error.message,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					500,
					{
						error: "Failed to process plan request",
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
