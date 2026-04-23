import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type ExecutionTraceInput,
	TracesUnavailableError,
	TracesValidationError,
	exportTraceToOpenTelemetry,
	getTracesService,
	normalizeTraceListQuery,
} from "../../services/traces/index.js";
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

function wantsOpenTelemetryExport(params: URLSearchParams): boolean {
	const format = params.get("format")?.trim().toLowerCase();
	const exportFormat = params.get("export")?.trim().toLowerCase();
	return (
		format === "otel" || format === "opentelemetry" || exportFormat === "otel"
	);
}

export async function handleTraces(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	params: Record<string, string> = {},
): Promise<void> {
	try {
		const url = new URL(
			req.url || "/api/traces",
			`http://${req.headers.host || "localhost"}`,
		);
		const service = getTracesService();

		if (req.method === "POST") {
			const body = await readJsonBody<ExecutionTraceInput>(req, 2_000_000);
			const trace = await service.recordTrace(body);
			sendJson(res, 201, { trace }, cors, req);
			return;
		}

		if (params.id) {
			const trace = await service.getTrace(decodeURIComponent(params.id));
			if (!trace) {
				sendJson(res, 404, { error: "Trace not found." }, cors, req);
				return;
			}
			if (wantsOpenTelemetryExport(url.searchParams)) {
				sendJson(res, 200, exportTraceToOpenTelemetry(trace), cors, req);
				return;
			}
			sendJson(res, 200, { trace }, cors, req);
			return;
		}

		const result = await service.listTraces(
			normalizeTraceListQuery({
				workspaceId: optionalSearchParam(
					url.searchParams,
					"workspace_id",
					"workspaceId",
				),
				agentId: optionalSearchParam(url.searchParams, "agent_id", "agentId"),
				status: optionalSearchParam(url.searchParams, "status"),
				limit: url.searchParams.get("limit"),
				offset: url.searchParams.get("offset"),
			}),
		);
		sendJson(res, 200, result, cors, req);
	} catch (error) {
		if (error instanceof TracesValidationError) {
			sendJson(res, 400, { error: error.message }, cors, req);
			return;
		}
		if (error instanceof TracesUnavailableError) {
			sendJson(res, 503, { error: error.message }, cors, req);
			return;
		}
		respondWithApiError(res, error, 500, cors, req);
	}
}
