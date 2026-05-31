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
import { resolveMaestroEventBusConfig } from "../telemetry/maestro-event-bus.js";
import type { AgentTool, Api, Model, ThinkingLevel, Usage } from "./types.js";

export interface MaestroTraceIdentityContext {
	organizationId?: string;
	workspaceId?: string;
	userId?: string;
	sessionId?: string;
	agentId?: string;
	agentRunId?: string;
	agentRunStepId?: string;
	traceId?: string;
	requestId?: string;
	surface?: string;
}

export interface AgentTurnContext extends MaestroTraceIdentityContext {
	modelId: string;
	modelProvider: string;
	thinkingLevel: ThinkingLevel;
	toolCount: number;
	messageCount: number;
}

export interface ToolCallContext extends MaestroTraceIdentityContext {
	toolName: string;
	toolCallId: string;
	inputSize: number;
}

export interface LlmRequestContext extends MaestroTraceIdentityContext {
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

export function maestroTraceIdentityAttributes(
	context: MaestroTraceIdentityContext = {},
): Record<string, string | undefined> {
	const eventBusConfig = resolveMaestroEventBusConfig();
	const correlation = eventBusConfig.defaultCorrelation;
	const principal = eventBusConfig.defaultPrincipal;
	const organizationId = traceIdentityValue(
		context.organizationId ??
			correlation.organization_id ??
			principal?.organization_id,
	);
	const workspaceId = traceIdentityValue(
		context.workspaceId ?? correlation.workspace_id ?? principal?.workspace_id,
	);
	const userId = traceIdentityValue(
		context.userId ?? correlation.user_id ?? principal?.user_id,
	);
	const sessionId = traceIdentityValue(
		context.sessionId ?? correlation.session_id,
	);
	const agentId = traceIdentityValue(context.agentId ?? correlation.agent_id);
	const agentRunId = traceIdentityValue(
		context.agentRunId ?? correlation.agent_run_id,
	);
	const agentRunStepId = traceIdentityValue(
		context.agentRunStepId ?? correlation.agent_run_step_id,
	);
	const traceId = traceIdentityValue(context.traceId ?? correlation.trace_id);
	const requestId = traceIdentityValue(
		context.requestId ?? correlation.request_id,
	);
	const surface = context.surface ?? eventBusConfig.defaultSurface;

	return {
		"enduser.id": userId,
		"user.id": userId,
		"agent.user.id": userId,
		"organization.id": organizationId,
		"evalops.organization_id": organizationId,
		"workspace.id": workspaceId,
		"evalops.workspace_id": workspaceId,
		"agent.session.id": sessionId,
		"maestro.session_id": sessionId,
		"agent.id": agentId,
		"maestro.agent_run_id": agentRunId,
		"maestro.agent_run_step_id": agentRunStepId,
		"trace.id": traceId,
		"request.id": requestId,
		"maestro.surface": surface,
	};
}

function traceIdentityValue(value: string | undefined): string | undefined {
	if (value === undefined || value === "" || value === "unknown") {
		return undefined;
	}
	return value;
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
			...maestroTraceIdentityAttributes(context),
			"agent.model.id": context.modelId,
			"agent.model.provider": context.modelProvider,
			"agent.thinking_level": context.thinkingLevel,
			"agent.tools.count": context.toolCount,
			"agent.messages.count": context.messageCount,
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
			...maestroTraceIdentityAttributes(context),
			"tool.name": context.toolName,
			"tool.call_id": context.toolCallId,
			"tool.input_size": context.inputSize,
		},
		async (span) => {
			try {
				const result = await operation(span);
				return result;
			} finally {
				const durationMs = performance.now() - startTime;
				if (span) {
					span.setAttribute("tool.duration_ms", durationMs);
				}
			}
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
			...maestroTraceIdentityAttributes(context),
			"llm.model.id": context.modelId,
			"llm.model.provider": context.provider,
			"llm.input_tokens": context.inputTokens,
			"llm.output_tokens": context.outputTokens,
			"llm.thinking_tokens": context.thinkingTokens,
		},
		async (span) => {
			try {
				return await operation(span);
			} finally {
				if (span) {
					span.setAttribute("llm.duration_ms", performance.now() - startTime);
				}
			}
		},
	);
}

/**
 * Records usage attributes on an existing span.
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
