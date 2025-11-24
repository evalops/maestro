import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "node:url";
import {
	getUsageFilePath,
	getUsageSummary,
} from "../../tracking/cost-tracker.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export function handleUsage(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	try {
		const parsedUrl = parse(req.url ?? "/", true);
		const { since, until } = parsedUrl.query;

		const options: { since?: number; until?: number } = {};
		if (since) options.since = Number.parseInt(String(since), 10);
		if (until) options.until = Number.parseInt(String(until), 10);

		const summary = getUsageSummary(options);
		const usageFile = getUsageFilePath();
		const hasData = existsSync(usageFile);
		const totals = summary.tokensDetailed || {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: summary.totalTokens,
		};

		const mapBreakdowns = <T extends Record<string, any>>(record: T) => {
			const mapped: Record<string, any> = {};
			for (const [key, value] of Object.entries(record)) {
				const detail = value as {
					cost: number;
					tokens: number;
					requests: number;
					tokensDetailed?: {
						input: number;
						output: number;
						cacheRead: number;
						cacheWrite: number;
						total: number;
					};
				};
				const tokenDetails = detail.tokensDetailed || {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: detail.tokens,
				};
				mapped[key] = {
					...detail,
					calls: detail.requests,
					tokensDetailed: tokenDetails,
					cachedTokens: tokenDetails.cacheRead + tokenDetails.cacheWrite,
				};
			}
			return mapped;
		};

		sendJson(
			res,
			200,
			{
				summary: {
					...summary,
					totalTokensDetailed: totals,
					totalTokensBreakdown: totals,
					totalCachedTokens: totals.cacheRead + totals.cacheWrite,
					byProvider: mapBreakdowns(summary.byProvider),
					byModel: mapBreakdowns(summary.byModel),
				},
				hasData,
			},
			cors,
			req,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}
