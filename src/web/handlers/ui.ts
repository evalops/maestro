import type { IncomingMessage, ServerResponse } from "node:http";
import { loadUiState, saveUiState } from "../../tui/ui-state.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

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
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/ui",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "status";

		try {
			if (action === "status") {
				const state = loadUiState();
				sendJson(
					res,
					200,
					{
						zenMode: state.zenMode ?? false,
						cleanMode: state.cleanMode ?? "off",
						footerMode: state.footerMode ?? "ensemble",
						compactTools: state.compactTools ?? false,
						queueMode: state.queueMode ?? "all",
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
		try {
			const data = await readJsonBody<{
				action: string;
				cleanMode?: "off" | "soft" | "aggressive";
				footerMode?: "ensemble" | "solo";
				compactTools?: boolean;
			}>(req);
			const { action } = data;

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
