import type { IncomingMessage, ServerResponse } from "node:http";
import { mcpManager } from "../../mcp/index.js";
import { sendJson } from "../server-utils.js";

export async function handleMcpStatus(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	try {
		const status = mcpManager.getStatus();
		sendJson(res, 200, status, corsHeaders);
	} catch (error) {
		sendJson(
			res,
			500,
			{
				error: "Failed to get MCP status",
				details: error instanceof Error ? error.message : String(error),
			},
			corsHeaders,
		);
	}
}
