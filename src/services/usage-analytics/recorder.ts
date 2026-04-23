import type { IncomingMessage } from "node:http";
import type { AssistantMessage } from "../../agent/types.js";
import { createLogger } from "../../utils/logger.js";
import { getUsageAnalyticsService } from "./service.js";

const logger = createLogger("usage-analytics:recorder");
const RECENT_USAGE_EVENT_TTL_MS = 10 * 60 * 1000;
const RECENT_USAGE_EVENT_LIMIT = 2_000;
const recentUsageEvents = new Map<string, number>();

function pruneRecentUsageEvents(now: number): void {
	for (const [key, seenAt] of recentUsageEvents) {
		if (now - seenAt <= RECENT_USAGE_EVENT_TTL_MS) {
			break;
		}
		recentUsageEvents.delete(key);
	}

	while (recentUsageEvents.size > RECENT_USAGE_EVENT_LIMIT) {
		const oldestKey = recentUsageEvents.keys().next().value;
		if (!oldestKey) break;
		recentUsageEvents.delete(oldestKey);
	}
}

function rememberUsageEvent(key: string, now = Date.now()): boolean {
	pruneRecentUsageEvents(now);
	if (recentUsageEvents.has(key)) {
		return false;
	}
	recentUsageEvents.set(key, now);
	return true;
}

function forgetUsageEvent(key: string): void {
	recentUsageEvents.delete(key);
}

function createUsageEventKey(params: {
	workspaceId: string;
	agentId: string;
	sessionId?: string;
	message: AssistantMessage;
	occurredAt: Date;
}): string {
	const { message, occurredAt } = params;
	const usage = message.usage;
	return [
		params.workspaceId,
		params.agentId,
		params.sessionId ?? "",
		message.provider,
		message.model,
		occurredAt.getTime().toString(),
		usage.input.toString(),
		usage.output.toString(),
		usage.cacheRead.toString(),
		usage.cacheWrite.toString(),
		typeof usage.cost?.total === "number" ? usage.cost.total.toString() : "",
	].join("\u001f");
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

export function resolveUsageWorkspaceId(req: IncomingMessage): string {
	return (
		firstHeader(req, [
			"x-maestro-workspace-id",
			"x-composer-workspace-id",
			"x-maestro-workspace",
			"x-composer-workspace",
		]) ?? process.cwd()
	);
}

export function resolveUsageAgentId(params: {
	req: IncomingMessage;
	sessionId?: string;
	subject?: string;
}): string {
	return (
		firstHeader(params.req, ["x-maestro-agent-id", "x-composer-agent-id"]) ??
		params.sessionId ??
		params.subject ??
		"web"
	);
}

export function recordAssistantUsageMetric(params: {
	req: IncomingMessage;
	message: AssistantMessage;
	sessionId?: string;
	subject?: string;
}): void {
	const { message } = params;
	const usage = message.usage;
	if (!usage) {
		return;
	}

	const occurredAt =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
			? new Date(message.timestamp)
			: new Date();
	const workspaceId = resolveUsageWorkspaceId(params.req);
	const agentId = resolveUsageAgentId(params);
	const eventKey = createUsageEventKey({
		workspaceId,
		agentId,
		sessionId: params.sessionId,
		message,
		occurredAt,
	});

	if (!rememberUsageEvent(eventKey)) {
		logger.debug("Skipped duplicate usage analytics event", {
			workspaceId,
			agentId,
			sessionId: params.sessionId,
			provider: message.provider,
			model: message.model,
		});
		return;
	}

	void getUsageAnalyticsService()
		.recordLlmCall({
			workspaceId,
			agentId,
			sessionId: params.sessionId,
			provider: message.provider,
			model: message.model,
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			costUsd: usage.cost?.total,
			occurredAt,
		})
		.catch((error) => {
			forgetUsageEvent(eventKey);
			logger.warn("Usage analytics recording failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionId: params.sessionId,
				provider: message.provider,
				model: message.model,
			});
		});
}

export function resetUsageAnalyticsRecorderForTest(): void {
	recentUsageEvents.clear();
}
