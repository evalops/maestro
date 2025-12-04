import type { IncomingMessage, ServerResponse } from "node:http";
import { loadUiState, saveUiState } from "../../tui/ui-state.js";
import { requireApiAuth, requireCsrf } from "../authz.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import {
	getSessionUiState,
	loadWebUiState,
	saveWebUiState,
} from "../stores/ui-store.js";

function parseCleanMode(value: string): "off" | "soft" | "aggressive" | null {
	const normalized = value.toLowerCase();
	if (normalized === "off" || normalized === "none") return "off";
	if (normalized === "soft" || normalized === "light") return "soft";
	if (normalized === "aggressive" || normalized === "aggressive")
		return "aggressive";
	return null;
}

function parseFooterMode(value: string): "ensemble" | "solo" | null {
	const normalized = value.toLowerCase();
	if (["ensemble", "rich", "classic", "full"].includes(normalized)) {
		return "ensemble";
	}
	if (["solo", "minimal", "lean", "lite"].includes(normalized)) {
		return "solo";
	}
	return null;
}

export async function handleUI(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	const url = new URL(
		req.url || "/api/ui",
		`http://${req.headers.host || "localhost"}`,
	);
	const sessionId = url.searchParams.get("sessionId");
	if (!sessionId) {
		sendJson(
			res,
			400,
			{ error: "sessionId query parameter is required" },
			corsHeaders,
		);
		return;
	}

	if (req.method === "GET") {
		if (!requireApiAuth(req, res, corsHeaders)) return;
		const action = url.searchParams.get("action") || "status";

		try {
			if (action === "status") {
				const state = loadUiState();
				const webState = loadWebUiState();
				const sessionState = getSessionUiState(webState, sessionId);
				sendJson(
					res,
					200,
					{
						zenMode: sessionState.zenMode ?? state.zenMode ?? false,
						cleanMode: sessionState.cleanMode ?? state.cleanMode ?? "off",
						footerMode:
							sessionState.footerMode ?? state.footerMode ?? "ensemble",
						compactTools:
							sessionState.compactTools ?? state.compactTools ?? false,
						queueMode: sessionState.queueMode ?? state.queueMode ?? "all",
					},
					corsHeaders,
				);
			} else if (action === "theme") {
				sendJson(
					res,
					200,
					{
						available: true,
						message: "Theme selection handled by frontend UI component",
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use status or theme." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		if (!requireApiAuth(req, res, corsHeaders)) return;
		if (!requireCsrf(req, res, corsHeaders)) return;
		try {
			const data = await readJsonBody<{
				action: string;
				cleanMode?: "off" | "soft" | "aggressive";
				footerMode?: "ensemble" | "solo";
				compactTools?: boolean;
			}>(req);
			const { action } = data;
			const baseState = loadUiState();
			const webState = loadWebUiState();
			const sessionState = getSessionUiState(webState, sessionId);

			if (action === "clean" && data.cleanMode) {
				const parsed = parseCleanMode(data.cleanMode);
				if (!parsed) {
					sendJson(
						res,
						400,
						{ error: "Invalid cleanMode. Use off, soft, or aggressive." },
						corsHeaders,
					);
					return;
				}
				sessionState.cleanMode = parsed;
				saveWebUiState(webState);
				saveUiState({ cleanMode: parsed });
				sendJson(
					res,
					200,
					{
						success: true,
						cleanMode: parsed,
						message: `Clean mode set to ${parsed}`,
					},
					corsHeaders,
				);
			} else if (action === "footer" && data.footerMode) {
				const parsed = parseFooterMode(data.footerMode);
				if (!parsed) {
					sendJson(
						res,
						400,
						{ error: "Invalid footerMode. Use ensemble or solo." },
						corsHeaders,
					);
					return;
				}
				sessionState.footerMode = parsed;
				saveWebUiState(webState);
				saveUiState({ footerMode: parsed });
				sendJson(
					res,
					200,
					{
						success: true,
						footerMode: parsed,
						message: `Footer mode set to ${parsed}`,
					},
					corsHeaders,
				);
			} else if (
				action === "compact" &&
				typeof data.compactTools === "boolean"
			) {
				sessionState.compactTools = data.compactTools;
				saveWebUiState(webState);
				saveUiState({ compactTools: data.compactTools });
				sendJson(
					res,
					200,
					{
						success: true,
						compactTools: data.compactTools,
						message: `Compact tools ${data.compactTools ? "enabled" : "disabled"}`,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{
						error:
							"Invalid action. Use clean, footer, or compact with appropriate parameters.",
					},
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
