import type { IncomingMessage } from "node:http";
import type { AssistantMessage } from "../../agent/types.js";
import { getRegisteredModels } from "../../models/registry.js";
import { createLogger } from "../../utils/logger.js";
import { sanitizeWithStaticMask } from "../../utils/secret-redactor.js";
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

export function resolveIntelligentRouterTaskSummary(
	body: unknown,
): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	if ("taskSummary" in body) {
		const summary = (body as { taskSummary?: unknown }).taskSummary;
		if (typeof summary === "string" && summary.trim()) return summary.trim();
	}
	if (
		!("messages" in body) ||
		!Array.isArray((body as { messages?: unknown }).messages)
	) {
		return undefined;
	}
	const messages = (body as { messages: unknown[] }).messages;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object" || !("content" in message))
			continue;
		if ("role" in message && message.role !== "user") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string" && content.trim()) return content.trim();
		if (Array.isArray(content)) {
			const text = content
				.map((part) =>
					part &&
					typeof part === "object" &&
					"text" in part &&
					typeof part.text === "string"
						? part.text
						: "",
				)
				.filter(Boolean)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

function resolvePriorFailures(req: IncomingMessage, body: unknown): number {
	const header = firstHeader(req, [
		"x-maestro-prior-failures",
		"x-composer-prior-failures",
	]);
	const bodyValue =
		body && typeof body === "object"
			? ((body as { priorFailures?: unknown; prior_failures?: unknown })
					.priorFailures ??
				(body as { prior_failures?: unknown }).prior_failures)
			: undefined;
	const parsed = Number(header ?? bodyValue ?? 0);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function selectIntelligentRouterModel(params: {
	req: IncomingMessage;
	requestedModel?: string | null;
	body?: unknown;
}): RoutedModelSelection {
	const taskType = resolveIntelligentRouterTaskType(params.req, params.body);
	const modelHint = params.requestedModel ?? undefined;
	const strategy = resolveIntelligentRouterStrategy(params.req);
	const profileHint =
		firstHeader(params.req, [
			"x-maestro-agent-profile",
			"x-composer-agent-profile",
		]) ??
		(params.body &&
		typeof params.body === "object" &&
		"profile" in params.body &&
		typeof (params.body as { profile?: unknown }).profile === "string"
			? (params.body as { profile: string }).profile
			: undefined);
	const decision = getIntelligentRouterService().routeRequest({
		taskType,
		taskSummary: resolveIntelligentRouterTaskSummary(params.body),
		priorFailures: resolvePriorFailures(params.req, params.body),
		availableModels: registeredRoutingModels(),
		...(modelHint ? { modelHint } : {}),
		...(strategy ? { strategy } : {}),
		...(profileHint ? { profileHint } : {}),
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
				success: false,
				verified: false,
				occurredAt: new Date(params.message.timestamp),
				...(typeof costUsd === "number" ? { costUsd } : {}),
			});
		})
		.catch((error) => {
			logger.warn("Intelligent router metric recording failed", {
				error: sanitizeWithStaticMask(
					error instanceof Error ? error.message : String(error),
				),
				taskType: params.taskType,
				provider: params.provider,
				model: params.model,
			});
		});
}
