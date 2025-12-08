import type { IncomingMessage, ServerResponse } from "node:http";
import { clearUsage, getUsageSummary } from "../../tracking/cost-tracker.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function resolvePeriod(arg?: string): {
	label: string;
	since?: number;
	until?: number;
} {
	const now = Date.now();
	if (!arg) {
		return { label: "All Time" };
	}
	const normalized = arg.toLowerCase();
	switch (normalized) {
		case "today": {
			const since = new Date().setHours(0, 0, 0, 0);
			return { label: "Today", since };
		}
		case "yesterday": {
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			const since = yesterday.setHours(0, 0, 0, 0);
			const until = new Date().setHours(0, 0, 0, 0);
			return { label: "Yesterday", since, until };
		}
		case "week":
		case "7d":
			return { label: "Last 7 Days", since: now - 7 * ONE_DAY_MS };
		case "month":
		case "30d":
			return { label: "Last 30 Days", since: now - 30 * ONE_DAY_MS };
		default:
			return { label: "All Time" };
	}
}

export async function handleCost(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/cost",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "summary";
		const period = url.searchParams.get("period");

		try {
			if (action === "summary") {
				const periodConfig = resolvePeriod(period || undefined);
				const summary = getUsageSummary({
					since: periodConfig.since,
					until: periodConfig.until,
				});
				sendJson(
					res,
					200,
					{
						period: periodConfig.label,
						summary,
					},
					corsHeaders,
				);
			} else if (action === "breakdown") {
				const periodConfig = resolvePeriod(period || undefined);
				const summary = getUsageSummary({
					since: periodConfig.since,
					until: periodConfig.until,
				});
				sendJson(
					res,
					200,
					{
						period: periodConfig.label,
						breakdown: {
							byProvider: summary.byProvider,
							byModel: summary.byModel,
						},
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use summary or breakdown." },
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

			if (action === "clear") {
				clearUsage();
				sendJson(
					res,
					200,
					{ success: true, message: "Cost tracking data cleared" },
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use clear." },
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
