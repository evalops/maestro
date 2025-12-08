import type { IncomingMessage, ServerResponse } from "node:http";
import { FEATURES } from "../../config/constants.js";
import { detectLspServers } from "../../lsp/autodetect.js";
import { autostartLspServers } from "../../lsp/autostart.js";
import { getClients } from "../../lsp/index.js";
import { lspManager } from "../../lsp/manager.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleLsp(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/lsp",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "status";

		try {
			if (action === "status") {
				const clients = await getClients();
				const status = {
					enabled: FEATURES.LSP_ENABLED,
					autostart: FEATURES.LSP_AUTOSTART,
					servers: clients.map((client) => ({
						id: client.id,
						root: client.root,
						initialized: client.initialized,
						fileCount: client.openFiles.size,
						diagnosticCount: Array.from(client.diagnostics.values()).reduce(
							(sum, d) => sum + d.length,
							0,
						),
					})),
				};
				sendJson(res, 200, status, corsHeaders);
			} else if (action === "detect") {
				const detections = await detectLspServers(process.cwd());
				sendJson(
					res,
					200,
					{
						detections: detections.map((d) => ({
							serverId: d.serverId,
							root: d.root,
						})),
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use status or detect." },
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
			const data = await readJsonBody<{ action: string }>(req);
			const { action } = data;

			if (!FEATURES.LSP_ENABLED) {
				sendJson(
					res,
					400,
					{
						error: "LSP is disabled. Set COMPOSER_LSP_ENABLED=1 to enable.",
					},
					corsHeaders,
				);
				return;
			}

			if (action === "start") {
				await autostartLspServers(process.cwd());
				const clients = await getClients();
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Started ${clients.length} LSP server(s)`,
						servers: clients.map((c) => c.id),
					},
					corsHeaders,
				);
			} else if (action === "stop") {
				const clients = await getClients();
				if (clients.length === 0) {
					sendJson(
						res,
						200,
						{ success: true, message: "No active LSP servers to stop." },
						corsHeaders,
					);
					return;
				}
				await lspManager.shutdownAll();
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Stopped ${clients.length} LSP server(s)`,
					},
					corsHeaders,
				);
			} else if (action === "restart") {
				const clientsBefore = await getClients();
				if (clientsBefore.length > 0) {
					await lspManager.shutdownAll();
				}
				await autostartLspServers(process.cwd());
				const clientsAfter = await getClients();
				sendJson(
					res,
					200,
					{
						success: true,
						message: "LSP servers restarted",
						servers: clientsAfter.map((c) => c.id),
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use start, stop, or restart." },
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
