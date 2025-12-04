import type { IncomingMessage, ServerResponse } from "node:http";
import { isDatabaseConfigured } from "../../db/client.js";
import { mcpManager } from "../../mcp/index.js";
import { getTelemetryStatus } from "../../telemetry.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";
import { getTrainingStatus } from "../../training.js";
import { sendJson } from "../server-utils.js";

export async function handleDiagnostics(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	const url = new URL(
		req.url || "/api/diagnostics",
		`http://${req.headers.host}`,
	);
	const subcommand = url.searchParams.get("subcommand") || "status";

	try {
		switch (subcommand) {
			case "status":
			case "health": {
				// Simplified health snapshot
				const snapshot = {
					toolFailures: 0, // Would need tool status view
					gitStatus: null, // Would need git view
					planGoals: 0,
					planPendingTasks: 0,
					backgroundTasks: backgroundTaskManager.getHealthSnapshot({
						maxEntries: 3,
						logLines: 2,
					}),
				};
				sendJson(res, 200, snapshot, corsHeaders);
				return;
			}

			case "about":
			case "version":
			case "info": {
				sendJson(
					res,
					200,
					{
						version: process.env.npm_package_version || "unknown",
						nodeVersion: process.version,
						platform: process.platform,
						arch: process.arch,
					},
					corsHeaders,
				);
				return;
			}

			case "mcp": {
				const status = mcpManager.getStatus();
				sendJson(res, 200, status, corsHeaders);
				return;
			}

			case "telemetry":
			case "telem": {
				const status = getTelemetryStatus();
				sendJson(res, 200, status, corsHeaders);
				return;
			}

			case "training":
			case "train": {
				const status = getTrainingStatus();
				sendJson(res, 200, status, corsHeaders);
				return;
			}

			case "config":
			case "cfg": {
				// Return config validation info
				sendJson(
					res,
					200,
					{
						database: {
							configured: isDatabaseConfigured(),
						},
					},
					corsHeaders,
				);
				return;
			}

			default:
				sendJson(
					res,
					400,
					{
						error: `Unknown subcommand: ${subcommand}`,
						availableSubcommands: [
							"status",
							"about",
							"mcp",
							"telemetry",
							"training",
							"config",
						],
					},
					corsHeaders,
				);
		}
	} catch (error) {
		sendJson(
			res,
			500,
			{
				error: "Failed to get diagnostics",
				details: error instanceof Error ? error.message : String(error),
			},
			corsHeaders,
		);
	}
}
