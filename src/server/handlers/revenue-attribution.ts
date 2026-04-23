import type { IncomingMessage, ServerResponse } from "node:http";
import {
	RevenueAttributionUnavailableError,
	RevenueAttributionValidationError,
	type RevenueOutcomeInput,
	getRevenueAttributionService,
	normalizeRevenueAttributionRoiQuery,
} from "../../services/revenue-attribution/index.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

function optionalSearchParam(
	params: URLSearchParams,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = params.get(name)?.trim();
		if (value) return value;
	}
	return undefined;
}

export async function handleRevenueAttribution(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	params: Record<string, string> = {},
): Promise<void> {
	try {
		const url = new URL(
			req.url || "/api/attribution",
			`http://${req.headers.host || "localhost"}`,
		);
		const service = getRevenueAttributionService();

		if (req.method === "POST") {
			const body = await readJsonBody<RevenueOutcomeInput>(req);
			const outcome = await service.recordOutcome(body);
			sendJson(res, 201, { outcome }, cors, req);
			return;
		}

		if (req.method === "GET" && params.agentId) {
			const report = await service.queryRoi(
				normalizeRevenueAttributionRoiQuery({
					agentId: decodeURIComponent(params.agentId),
					workspaceId: optionalSearchParam(
						url.searchParams,
						"workspace_id",
						"workspaceId",
					),
					from: optionalSearchParam(url.searchParams, "from"),
					to: optionalSearchParam(url.searchParams, "to"),
				}),
			);
			sendJson(res, 200, { roi: report }, cors, req);
			return;
		}

		sendJson(res, 405, { error: "Method not allowed" }, cors, req);
	} catch (error) {
		if (error instanceof RevenueAttributionValidationError) {
			sendJson(res, 400, { error: error.message }, cors, req);
			return;
		}
		if (error instanceof RevenueAttributionUnavailableError) {
			sendJson(res, 503, { error: error.message }, cors, req);
			return;
		}
		respondWithApiError(res, error, 500, cors, req);
	}
}
