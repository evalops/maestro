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

		if (action === "get-prompt") {
			const server = url.searchParams.get("server");
			const promptName = url.searchParams.get("name");

			if (!server || !promptName) {
				sendJson(
					res,
					400,
					{ error: "Missing required query parameters: server and name" },
					corsHeaders,
				);
				return;
			}

			const args: Record<string, string> = {};
			for (const [key, value] of url.searchParams.entries()) {
				if (key.startsWith("arg:")) {
					args[key.slice(4)] = value;
				}
			}

			const result = await mcpManager.getPrompt(
				server,
				promptName,
				Object.keys(args).length > 0 ? args : undefined,
			);
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
						: action === "get-prompt"
							? "Failed to get MCP prompt"
							: "Failed to get MCP status",
				details: error instanceof Error ? error.message : String(error),
			},
			corsHeaders,
		);
	}
}
