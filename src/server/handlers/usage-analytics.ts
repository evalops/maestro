import type { IncomingMessage, ServerResponse } from "node:http";
import {
	UsageAnalyticsValidationError,
	parseOptionalDate,
	parseUsageAnalyticsPeriod,
} from "../../services/usage-analytics/aggregation.js";
import {
	UsageAnalyticsUnavailableError,
	getUsageAnalyticsService,
} from "../../services/usage-analytics/service.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

function optionalSearchParam(
	params: URLSearchParams,
	name: string,
): string | undefined {
	const value = params.get(name)?.trim();
	return value ? value : undefined;
}

export async function handleUsageAnalytics(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	params: Record<string, string> = {},
): Promise<void> {
	try {
		const url = new URL(
			req.url || "/api/usage/analytics",
			`http://${req.headers.host || "localhost"}`,
		);
		const period = parseUsageAnalyticsPeriod(
			params.period ?? url.searchParams.get("period"),
		);
		const from = parseOptionalDate(url.searchParams.get("from"), "from");
		const to = parseOptionalDate(url.searchParams.get("to"), "to");

		if (from && to && from.getTime() > to.getTime()) {
			throw new UsageAnalyticsValidationError(
				"from must be before or equal to to.",
			);
		}

		const report = await getUsageAnalyticsService().queryUsage({
			period,
			workspaceId: optionalSearchParam(url.searchParams, "workspaceId"),
			agentId: optionalSearchParam(url.searchParams, "agentId"),
			provider: optionalSearchParam(url.searchParams, "provider"),
			model: optionalSearchParam(url.searchParams, "model"),
			from,
			to,
		});

		sendJson(res, 200, { analytics: report }, cors, req);
	} catch (error) {
		if (error instanceof UsageAnalyticsValidationError) {
			sendJson(res, 400, { error: error.message }, cors, req);
			return;
		}
		if (error instanceof UsageAnalyticsUnavailableError) {
			sendJson(res, 503, { error: error.message }, cors, req);
			return;
		}
		respondWithApiError(res, error, 500, cors, req);
	}
}
