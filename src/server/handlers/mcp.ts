import type { IncomingMessage, ServerResponse } from "node:http";
import { mcpManager } from "../../mcp/index.js";
import { sendJson } from "../server-utils.js";

export async function handleMcpStatus(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	const url = new URL(req.url || "/api/mcp", `http://${req.headers.host}`);
	const action = url.searchParams.get("action") || "status";

	try {
		if (action === "status") {
			const status = mcpManager.getStatus();
			sendJson(res, 200, status, corsHeaders);
			return;
		}

		if (action === "read-resource") {
			const server = url.searchParams.get("server");
			const uri = url.searchParams.get("uri");

			if (!server || !uri) {
				sendJson(
					res,
					400,
					{ error: "Missing required query parameters: server and uri" },
					corsHeaders,
				);
				return;
			}

			const result = await mcpManager.readResource(server, uri);
			sendJson(res, 200, result, corsHeaders);
			return;
		}

		sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
	} catch (error) {
		sendJson(
			res,
			500,
			{
				error:
					action === "read-resource"
						? "Failed to read MCP resource"
						: "Failed to get MCP status",
				details: error instanceof Error ? error.message : String(error),
			},
			corsHeaders,
		);
	}
}
