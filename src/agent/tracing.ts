/**
 * Agent-level tracing for OpenTelemetry integration.
 *
 * This module provides tracing capabilities for agent turns, tool calls,
 * and LLM requests to enable observability into agent execution.
 */

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import {
	getTelemetryTracer,
	isOpenTelemetryEnabled,
} from "../opentelemetry.js";
import type { AgentTool, Api, Model, ThinkingLevel, Usage } from "./types.js";

export interface AgentTurnContext {
	modelId: string;
	modelProvider: string;
	thinkingLevel: ThinkingLevel;
	toolCount: number;
	messageCount: number;
	userId?: string;
	sessionId?: string;
}

export interface ToolCallContext {
	toolName: string;
	toolCallId: string;
	inputSize: number;
}

export interface LlmRequestContext {
	modelId: string;
	provider: string;
	inputTokens?: number;
	outputTokens?: number;
	thinkingTokens?: number;
}

/**
 * Wraps an async operation in an OpenTelemetry span.
 * If OpenTelemetry is not enabled, executes the operation directly.
 */
async function withSpan<T>(
	spanName: string,
	attributes: Record<string, string | number | boolean | undefined>,
	operation: (span: Span | null) => Promise<T>,
): Promise<T> {
	if (!isOpenTelemetryEnabled()) {
		return operation(null);
	}

	const tracer = getTelemetryTracer();
	return tracer.startActiveSpan(spanName, async (span: Span) => {
		// Filter out undefined values
		const filteredAttrs: Record<string, string | number | boolean> = {};
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined) {
				filteredAttrs[key] = value;
			}
		}
		span.setAttributes(filteredAttrs);

		try {
			const result = await operation(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			span.end();
		}
	});
}

/**
 * Creates a span for an agent turn (user message → assistant response cycle).
 *
 * @example
 * ```typescript
 * await traceAgentTurn(
 *   { modelId: "claude-3", toolCount: 5, messageCount: 10 },
 *   async (span) => {
 *     // Execute the turn
 *     await agent.prompt(userMessage);
 *   }
 * );
 * ```
 */
export async function traceAgentTurn<T>(
	context: AgentTurnContext,
	operation: (span: Span | null) => Promise<T>,
): Promise<T> {
	return withSpan(
		"agent.turn",
		{
			"agent.model.id": context.modelId,
			"agent.model.provider": context.modelProvider,
			"agent.thinking_level": context.thinkingLevel,
			"agent.tools.count": context.toolCount,
			"agent.messages.count": context.messageCount,
			"agent.user.id": context.userId,
			"agent.session.id": context.sessionId,
		},
		operation,
	);
}

/**
 * Creates a span for a tool execution.
 *
 * @example
 * ```typescript
 * const result = await traceToolCall(
 *   { toolName: "bash", toolCallId: "123", inputSize: 50 },
 *   async (span) => {
 *     return await tool.execute(args);
 *   }
 * );
 * ```
 */
export async function traceToolCall<T>(
	context: ToolCallContext,
	operation: (span: Span | null) => Promise<T>,
): Promise<T> {
	const startTime = performance.now();

	return withSpan(
		`tool.${context.toolName}`,
		{
			"tool.name": context.toolName,
			"tool.call_id": context.toolCallId,
			"tool.input_size": context.inputSize,
		},
		async (span) => {
			const result = await operation(span);

			if (span) {
				span.setAttribute("tool.duration_ms", performance.now() - startTime);
			}

			return result;
		},
	);
}

/**
 * Creates a span for an LLM API request.
 *
 * @example
 * ```typescript
 * const response = await traceLlmRequest(
 *   { modelId: "claude-3", provider: "anthropic" },
 *   async (span) => {
 *     const response = await client.complete(messages);
 *     // Add token counts after response
 *     if (span) {
 *       span.setAttribute("llm.input_tokens", response.usage.input);
 *       span.setAttribute("llm.output_tokens", response.usage.output);
 *     }
 *     return response;
 *   }
 * );
 * ```
 */
export async function traceLlmRequest<T>(
	context: LlmRequestContext,
	operation: (span: Span | null) => Promise<T>,
): Promise<T> {
	const startTime = performance.now();

	return withSpan(
		"llm.request",
		{
			"llm.model.id": context.modelId,
			"llm.model.provider": context.provider,
			"llm.input_tokens": context.inputTokens,
			"llm.output_tokens": context.outputTokens,
			"llm.thinking_tokens": context.thinkingTokens,
		},
		async (span) => {
			const result = await operation(span);

			if (span) {
				span.setAttribute("llm.duration_ms", performance.now() - startTime);
			}

			return result;
		},
	);
}

/**
 * Records usage metrics on an existing span.
 */
export function recordUsageOnSpan(span: Span | null, usage: Usage): void {
	if (!span) return;

	span.setAttributes({
		"llm.usage.input_tokens": usage.input,
		"llm.usage.output_tokens": usage.output,
		"llm.usage.cache_read_tokens": usage.cacheRead,
		"llm.usage.cache_write_tokens": usage.cacheWrite,
		"llm.usage.cost_total": usage.cost.total,
	});
}

/**
 * Creates a span for approval flow (when user approval is required).
 */
export async function traceApprovalFlow<T>(
	context: {
		toolName: string;
		ruleId?: string;
		actionType: string;
	},
	operation: (span: Span | null) => Promise<T>,
): Promise<T> {
	const startTime = performance.now();

	return withSpan(
		"agent.approval",
		{
			"approval.tool_name": context.toolName,
			"approval.rule_id": context.ruleId,
			"approval.action_type": context.actionType,
		},
		async (span) => {
			const result = await operation(span);

			if (span) {
				span.setAttribute(
					"approval.wait_duration_ms",
					performance.now() - startTime,
				);
			}

			return result;
		},
	);
}

/**
 * Records an approval decision on a span.
 */
export function recordApprovalDecision(
	span: Span | null,
	decision: "approved" | "denied" | "auto",
): void {
	if (!span) return;
	span.setAttribute("approval.decision", decision);
}

/**
 * Creates a simple event span (non-async, immediate recording).
 */
export function recordAgentEvent(
	eventType: string,
	attributes: Record<string, string | number | boolean | undefined>,
): void {
	if (!isOpenTelemetryEnabled()) return;

	const tracer = getTelemetryTracer();
	tracer.startActiveSpan(`agent.event.${eventType}`, (span: Span) => {
		const filteredAttrs: Record<string, string | number | boolean> = {};
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined) {
				filteredAttrs[key] = value;
			}
		}
		span.setAttributes({
			"agent.event.type": eventType,
			...filteredAttrs,
		});
		span.setStatus({ code: SpanStatusCode.OK });
		span.end();
	});
}

/**
 * Records a model switch event.
 */
export function recordModelSwitch(
	previousModel: string | undefined,
	newModel: string,
	provider: string,
): void {
	recordAgentEvent("model_switch", {
		"agent.model.previous": previousModel,
		"agent.model.new": newModel,
		"agent.model.provider": provider,
	});
}

/**
 * Records a thinking level change event.
 */
export function recordThinkingLevelChange(
	previousLevel: ThinkingLevel,
	newLevel: ThinkingLevel,
): void {
	recordAgentEvent("thinking_level_change", {
		"agent.thinking.previous": previousLevel,
		"agent.thinking.new": newLevel,
	});
}

/**
 * Records a session start event.
 */
export function recordSessionStart(
	sessionId: string,
	modelId: string,
	provider: string,
): void {
	recordAgentEvent("session_start", {
		"agent.session.id": sessionId,
		"agent.model.id": modelId,
		"agent.model.provider": provider,
	});
}

/**
 * Records a session end event.
 */
export function recordSessionEnd(
	sessionId: string,
	messageCount: number,
	totalCost: number,
): void {
	recordAgentEvent("session_end", {
		"agent.session.id": sessionId,
		"agent.session.message_count": messageCount,
		"agent.session.total_cost": totalCost,
	});
}
