import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	getBackgroundSettingsPath,
	getBackgroundTaskSettings,
	updateBackgroundTaskSettings,
} from "../../runtime/background-settings.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";
import { sendJson } from "../server-utils.js";
import {
	type BackgroundUpdateRequestInput,
	BackgroundUpdateRequestSchema,
	parseAndValidateJson,
} from "../validation.js";

export async function handleBackground(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		// GET /api/background?action=status|history|path
		const url = new URL(
			req.url || "/api/background",
			`http://${req.headers.host}`,
		);
		const action = url.searchParams.get("action") || "status";
		const limitParam = url.searchParams.get("limit");

		if (action === "status") {
			const settings = getBackgroundTaskSettings();
			const snapshot = backgroundTaskManager.getHealthSnapshot({
				maxEntries: 1,
				logLines: 1,
				historyLimit: 3,
			});

			sendJson(
				res,
				200,
				{
					settings: {
						notificationsEnabled: settings.notificationsEnabled,
						statusDetailsEnabled: settings.statusDetailsEnabled,
					},
					snapshot: snapshot
						? {
								running: snapshot.running,
								total: snapshot.total,
								failed: snapshot.failed,
								detailsRedacted: snapshot.detailsRedacted,
							}
						: null,
				},
				corsHeaders,
			);
			return;
		}

		if (action === "history") {
			const settings = getBackgroundTaskSettings();
			if (!settings.statusDetailsEnabled) {
				sendJson(
					res,
					403,
					{
						error:
							"Enable status details with POST /api/background?action=details&enabled=true",
					},
					corsHeaders,
				);
				return;
			}

			const limitArg = limitParam ? Number.parseInt(limitParam, 10) : 10;
			const limit = Number.isFinite(limitArg)
				? Math.min(Math.max(limitArg, 1), 50)
				: 10;

			const snapshot = backgroundTaskManager.getHealthSnapshot({
				maxEntries: 1,
				logLines: 1,
				historyLimit: limit,
			});
			const history = snapshot?.history ?? [];

			sendJson(
				res,
				200,
				{
					history: history.map((entry) => ({
						timestamp: entry.timestamp,
						event: entry.event,
						taskId: entry.taskId,
						command: entry.command,
						failureReason: entry.failureReason,
						limitBreach: entry.limitBreach,
					})),
					truncated: snapshot?.historyTruncated ?? false,
				},
				corsHeaders,
			);
			return;
		}

		if (action === "path") {
			const path = getBackgroundSettingsPath();
			const exists = existsSync(path);
			sendJson(
				res,
				200,
				{
					path,
					exists,
					overridden: Boolean(process.env.COMPOSER_BACKGROUND_SETTINGS),
				},
				corsHeaders,
			);
			return;
		}

		sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
		return;
	}

	if (req.method === "POST") {
		try {
			const url = new URL(
				req.url || "/api/background",
				`http://${req.headers.host}`,
			);
			const action = url.searchParams.get("action") || "notify";

			if (action === "notify" || action === "details") {
				const data = await parseAndValidateJson<BackgroundUpdateRequestInput>(
					req,
					BackgroundUpdateRequestSchema,
				);
				const { enabled } = data;

				updateBackgroundTaskSettings(
					action === "notify"
						? { notificationsEnabled: enabled }
						: { statusDetailsEnabled: enabled },
				);

				sendJson(
					res,
					200,
					{
						success: true,
						message: `Background task ${action} ${enabled ? "enabled" : "disabled"}`,
					},
					corsHeaders,
				);
				return;
			}

			sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) {
				sendJson(
					res,
					(error as { statusCode: number }).statusCode,
					{ error: error.message },
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					500,
					{
						error: "Failed to update background settings",
						details: error instanceof Error ? error.message : String(error),
					},
					corsHeaders,
				);
			}
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
