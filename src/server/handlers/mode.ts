import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type AgentMode,
	getAllModes,
	getCurrentMode,
	getModeConfig,
	getModelForMode,
	parseMode,
	setCurrentMode,
	suggestMode,
} from "../../agent/modes.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleMode(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/mode",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "current";
		const task = url.searchParams.get("task");

		try {
			if (action === "current") {
				const mode = getCurrentMode();
				const config = getModeConfig(mode);
				const model = getModelForMode(mode);
				sendJson(
					res,
					200,
					{
						mode,
						config,
						model,
					},
					corsHeaders,
				);
			} else if (action === "list") {
				const modes = getAllModes();
				sendJson(res, 200, { modes }, corsHeaders);
			} else if (action === "suggest") {
				const suggested = suggestMode(task || "");
				const config = getModeConfig(suggested);
				const model = getModelForMode(suggested);
				sendJson(
					res,
					200,
					{
						suggested,
						config,
						model,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use current, list, or suggest." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{ mode: string }>(req);
			const { mode } = data;

			if (!mode) {
				sendJson(res, 400, { error: "Mode is required" }, corsHeaders);
				return;
			}

			const parsedMode = parseMode(mode);
			if (!parsedMode) {
				sendJson(res, 400, { error: `Unknown mode: ${mode}` }, corsHeaders);
				return;
			}

			setCurrentMode(parsedMode);
			const config = getModeConfig(parsedMode);
			const model = getModelForMode(parsedMode);

			sendJson(
				res,
				200,
				{
					success: true,
					mode: parsedMode,
					config,
					model,
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
