import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type ComplianceFramework,
	type ComplianceReportRequest,
	ComplianceValidationError,
	getComplianceService,
	normalizeComplianceEvidenceQuery,
	parseComplianceFrameworks,
} from "../../services/compliance/index.js";
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

function frameworksFromQuery(
	params: URLSearchParams,
): ComplianceFramework[] | undefined {
	const raw = optionalSearchParam(params, "frameworks", "framework");
	return raw ? parseComplianceFrameworks(raw) : undefined;
}

export async function handleCompliance(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	params: Record<string, string> = {},
): Promise<void> {
	try {
		const url = new URL(
			req.url || "/api/compliance",
			`http://${req.headers.host || "localhost"}`,
		);
		const service = getComplianceService();

		if (req.method === "POST") {
			const body = await readJsonBody<ComplianceReportRequest>(req, 2_000_000);
			const report = await service.generateReport(body);
			sendJson(res, 200, { report }, cors, req);
			return;
		}

		if (req.method === "GET" && params.controlId) {
			const result = await service.getEvidenceForControl(
				decodeURIComponent(params.controlId),
				normalizeComplianceEvidenceQuery({
					workspaceId: optionalSearchParam(
						url.searchParams,
						"workspace_id",
						"workspaceId",
					),
					from: optionalSearchParam(url.searchParams, "from"),
					to: optionalSearchParam(url.searchParams, "to"),
				}),
			);
			if (!result) {
				sendJson(
					res,
					404,
					{ error: "Compliance control not found." },
					cors,
					req,
				);
				return;
			}
			sendJson(res, 200, result, cors, req);
			return;
		}

		if (req.method === "GET") {
			const controls = service.listControls(
				frameworksFromQuery(url.searchParams),
			);
			sendJson(res, 200, { controls }, cors, req);
			return;
		}

		sendJson(res, 405, { error: "Method not allowed" }, cors, req);
	} catch (error) {
		if (error instanceof ComplianceValidationError) {
			sendJson(res, 400, { error: error.message }, cors, req);
			return;
		}
		respondWithApiError(res, error, 500, cors, req);
	}
}
