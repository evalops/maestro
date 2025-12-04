import type { IncomingMessage, ServerResponse } from "node:http";
import { mcpManager } from "../../mcp/index.js";
import { getAllMcpTools } from "../../mcp/tool-bridge.js";
import { codingTools, toolRegistry, vscodeTools } from "../../tools/index.js";
import { sendJson } from "../server-utils.js";

export async function handleTools(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	const url = new URL(req.url || "/api/tools", `http://${req.headers.host}`);
	const action = url.searchParams.get("action") || "list";

	if (action === "list") {
		const allTools = [
			...codingTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				category: "coding",
			})),
			...vscodeTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				category: "vscode",
			})),
			...getAllMcpTools().map((tool) => ({
				name: tool.name,
				description: tool.description,
				category: "mcp",
			})),
		];

		sendJson(
			res,
			200,
			{
				tools: allTools,
				total: allTools.length,
				byCategory: {
					coding: codingTools.length,
					vscode: vscodeTools.length,
					mcp: getAllMcpTools().length,
				},
			},
			corsHeaders,
		);
		return;
	}

	if (action === "mcp") {
		const status = mcpManager.getStatus();
		sendJson(
			res,
			200,
			{
				servers: status.servers.map((s) => ({
					name: s.name,
					connected: s.connected,
					tools: s.tools?.length ?? 0,
				})),
			},
			corsHeaders,
		);
		return;
	}

	sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
}
