import type { IncomingMessage } from "node:http";
import type { AssistantMessage } from "../../agent/types.js";
import { getRegisteredModels } from "../../models/registry.js";
import { createLogger } from "../../utils/logger.js";
import { getIntelligentRouterService } from "./service.js";
import { ROUTING_STRATEGIES } from "./types.js";
import type {
	RoutedModel,
	RoutingDecision,
	RoutingModelCandidate,
	RoutingStrategy,
} from "./types.js";

const logger = createLogger("intelligent-router:recorder");

export interface RoutedModelSelection {
	taskType: string;
	decision: RoutingDecision;
	modelInputs: string[];
}

function modelInput(model: RoutedModel): string {
	return `${model.provider}/${model.model}`;
}

function firstHeader(
	req: IncomingMessage,
	names: string[],
): string | undefined {
	for (const name of names) {
		const raw = req.headers[name.toLowerCase()];
		const value = Array.isArray(raw) ? raw[0] : raw;
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

export function registeredRoutingModels(): RoutingModelCandidate[] {
	return getRegisteredModels().map((model) => ({
		provider: model.provider,
		model: model.id,
		name: model.name || model.id,
		cost: model.cost,
		available: true,
	}));
}

export function resolveIntelligentRouterTaskType(
	req: IncomingMessage,
	body?: unknown,
): string {
	const header = firstHeader(req, [
		"x-maestro-task-type",
		"x-composer-task-type",
	]);
	if (header?.trim()) return header.trim();
	if (body && typeof body === "object" && "taskType" in body) {
		const taskType = (body as { taskType?: unknown }).taskType;
		if (typeof taskType === "string" && taskType.trim()) {
			return taskType.trim();
		}
	}
	return "chat";
}

export function resolveIntelligentRouterStrategy(
	req: IncomingMessage,
): RoutingStrategy | undefined {
	const header = firstHeader(req, [
		"x-maestro-routing-strategy",
		"x-composer-routing-strategy",
	]);
	if (!header?.trim()) return undefined;
	const strategy = header.trim().toLowerCase();
	return ROUTING_STRATEGIES.includes(strategy as RoutingStrategy)
		? (strategy as RoutingStrategy)
		: undefined;
}

export function selectIntelligentRouterModel(params: {
	req: IncomingMessage;
	requestedModel?: string | null;
	body?: unknown;
}): RoutedModelSelection {
	const taskType = resolveIntelligentRouterTaskType(params.req, params.body);
	const modelHint = params.requestedModel ?? undefined;
	const strategy = resolveIntelligentRouterStrategy(params.req);
	const decision = getIntelligentRouterService().routeRequest({
		taskType,
		availableModels: registeredRoutingModels(),
		...(modelHint ? { modelHint } : {}),
		...(strategy ? { strategy } : {}),
	});
	return {
		taskType,
		decision,
		modelInputs: [
			modelInput(decision.selectedModel),
			...decision.fallbackChain.map(modelInput),
		],
	};
}

export function recordIntelligentRouterChatMetric(params: {
	taskType: string;
	provider: string;
	model: string;
	startedAt: number;
	message: AssistantMessage;
}): void {
	const usage = params.message.usage;
	void Promise.resolve()
		.then(() => {
			const costUsd = usage.cost?.total;
			getIntelligentRouterService().recordPerformanceMetric({
				taskType: params.taskType,
				provider: params.provider,
				model: params.model,
				latencyMs: Date.now() - params.startedAt,
				success: params.message.stopReason !== "error",
				occurredAt: new Date(params.message.timestamp),
				...(typeof costUsd === "number" ? { costUsd } : {}),
			});
		})
		.catch((error) => {
			logger.warn("Intelligent router metric recording failed", {
				error: error instanceof Error ? error.message : String(error),
				taskType: params.taskType,
				provider: params.provider,
				model: params.model,
			});
		});
}
