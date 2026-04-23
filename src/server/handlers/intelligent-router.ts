import type { IncomingMessage, ServerResponse } from "node:http";
import {
	IntelligentRouterValidationError,
	type ModelPerformanceMetricInput,
	type RoutingOverrideInput,
	type RoutingRequestInput,
	getIntelligentRouterService,
	registeredRoutingModels,
} from "../../services/intelligent-router/index.js";
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

function parseLimit(value: string | null): number {
	if (!value) return 20;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return 20;
	return Math.min(100, Math.floor(parsed));
}

type RouterResource = "metrics" | "overrides" | "decisions";

function splitPath(pathname: string): string[] {
	return pathname
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
}

function intelligentRouterResource(
	pathname: string,
	params: Record<string, string>,
): RouterResource | undefined {
	const segments = splitPath(pathname);
	if (segments[0] !== "api" || segments[1] !== "intelligent-router") {
		return undefined;
	}
	const resource = segments[2];
	if (
		resource !== "metrics" &&
		resource !== "overrides" &&
		resource !== "decisions"
	) {
		return undefined;
	}
	const isCollectionRoute = segments.length === 3;
	const isOverrideDeleteRoute =
		resource === "overrides" &&
		segments.length === 4 &&
		Boolean(params.taskType || segments[3]);
	return isCollectionRoute || isOverrideDeleteRoute ? resource : undefined;
}

function overrideTaskType(
	pathname: string,
	params: Record<string, string>,
): string | undefined {
	if (params.taskType) return params.taskType;
	const segments = splitPath(pathname);
	return segments[2] === "overrides" && segments.length === 4
		? segments[3]
		: undefined;
}

function decisionRequestFromQuery(
	params: URLSearchParams,
): RoutingRequestInput {
	const taskType = optionalSearchParam(params, "task_type", "taskType");
	const modelHint = optionalSearchParam(params, "model_hint", "modelHint");
	const strategy = optionalSearchParam(params, "strategy");
	const unavailableModels = optionalSearchParam(
		params,
		"unavailable_models",
		"unavailableModels",
	);
	return {
		availableModels: registeredRoutingModels(),
		...(taskType ? { taskType } : {}),
		...(modelHint ? { modelHint } : {}),
		...(strategy ? { strategy } : {}),
		...(unavailableModels ? { unavailableModels } : {}),
	};
}

export async function handleIntelligentRouter(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	params: Record<string, string> = {},
): Promise<void> {
	try {
		const url = new URL(
			req.url || "/api/intelligent-router",
			`http://${req.headers.host || "localhost"}`,
		);
		const service = getIntelligentRouterService();
		const resource = intelligentRouterResource(url.pathname, params);

		if (resource === "metrics") {
			if (req.method === "POST") {
				const body = await readJsonBody<ModelPerformanceMetricInput>(req);
				const metric = service.recordPerformanceMetric(body);
				sendJson(res, 201, { metric }, cors, req);
				return;
			}
			if (req.method === "GET") {
				const metrics = service.listMetrics(
					optionalSearchParam(url.searchParams, "task_type", "taskType"),
				);
				sendJson(res, 200, { metrics }, cors, req);
				return;
			}
		}

		if (resource === "overrides") {
			if (req.method === "POST") {
				const body = await readJsonBody<RoutingOverrideInput>(req);
				const override = service.setOverride(body);
				sendJson(res, 201, { override }, cors, req);
				return;
			}
			if (req.method === "DELETE") {
				const taskTypeParam = overrideTaskType(url.pathname, params);
				if (!taskTypeParam) {
					sendJson(res, 405, { error: "Method not allowed" }, cors, req);
					return;
				}
				const taskType = decodeURIComponent(taskTypeParam);
				const deleted = service.deleteOverride(taskType);
				if (!deleted) {
					sendJson(
						res,
						404,
						{ error: "Routing override not found." },
						cors,
						req,
					);
					return;
				}
				sendJson(res, 200, { deleted: true, taskType }, cors, req);
				return;
			}
			if (req.method === "GET") {
				sendJson(res, 200, { overrides: service.listOverrides() }, cors, req);
				return;
			}
		}

		if (resource === "decisions") {
			if (req.method === "POST") {
				const body = await readJsonBody<RoutingRequestInput>(req);
				const decision = service.routeRequest({
					...body,
					availableModels: body.availableModels ?? registeredRoutingModels(),
				});
				sendJson(res, 200, { decision }, cors, req);
				return;
			}
			if (req.method === "GET") {
				const taskType = optionalSearchParam(
					url.searchParams,
					"task_type",
					"taskType",
				);
				if (taskType) {
					const decision = service.routeRequest(
						decisionRequestFromQuery(url.searchParams),
					);
					sendJson(res, 200, { decision }, cors, req);
					return;
				}
				sendJson(
					res,
					200,
					{
						decisions: service.listDecisions(
							parseLimit(url.searchParams.get("limit")),
						),
					},
					cors,
					req,
				);
				return;
			}
		}

		sendJson(res, 405, { error: "Method not allowed" }, cors, req);
	} catch (error) {
		if (error instanceof IntelligentRouterValidationError) {
			sendJson(res, 400, { error: error.message }, cors, req);
			return;
		}
		respondWithApiError(res, error, 500, cors, req);
	}
}
