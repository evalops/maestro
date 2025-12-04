import type { IncomingMessage, ServerResponse } from "node:http";
import { isDatabaseConfigured } from "../../db/client.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleQuota(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/quota",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "status";

		try {
			if (action === "status") {
				if (!isDatabaseConfigured()) {
					sendJson(
						res,
						200,
						{
							enterprise: false,
							message:
								"Enterprise quota features require database configuration",
						},
						corsHeaders,
					);
					return;
				}

				// Enterprise quota status would require auth
				// For now, return placeholder
				sendJson(
					res,
					200,
					{
						enterprise: true,
						message: "Enterprise quota status (requires authentication)",
					},
					corsHeaders,
				);
			} else if (action === "detailed") {
				if (!isDatabaseConfigured()) {
					sendJson(
						res,
						400,
						{
							error:
								"Detailed quota view requires enterprise database configuration",
						},
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					200,
					{
						message: "Detailed quota breakdown (requires authentication)",
					},
					corsHeaders,
				);
			} else if (action === "models") {
				if (!isDatabaseConfigured()) {
					sendJson(
						res,
						400,
						{
							error:
								"Model usage breakdown requires enterprise database configuration",
						},
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					200,
					{
						message: "Model usage breakdown (requires authentication)",
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use status, detailed, or models." },
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
			const data = await readJsonBody<{ action: string; limit?: number }>(req);
			const { action, limit } = data;

			if (action === "limit") {
				if (limit === undefined || limit === null) {
					sendJson(res, 400, { error: "Limit value is required" }, corsHeaders);
					return;
				}
				if (limit <= 0) {
					sendJson(
						res,
						400,
						{ error: "Limit must be a positive number" },
						corsHeaders,
					);
					return;
				}
				// In production, this would be stored per-session
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Session token limit set to ${limit}`,
						limit,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use limit." },
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
