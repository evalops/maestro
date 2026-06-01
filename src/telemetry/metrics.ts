import {
	type Counter,
	type Histogram,
	metrics as otelMetrics,
} from "@opentelemetry/api";

export type MaestroMetricDefinition = {
	key: string;
	name: string;
	kind: "counter" | "histogram";
	description: string;
	unit?: string;
};

export const MAESTRO_OTEL_METRIC_DEFINITIONS = [
	{
		key: "toolInvocationCount",
		name: "tool_service.invocation_count",
		kind: "counter",
		description: "Number of tool invocations",
	},
	{
		key: "toolInvocationLatency",
		name: "tool_service.invocation_latency",
		kind: "histogram",
		description: "Latency of tool invocations",
		unit: "ms",
	},
	{
		key: "skillInvocationCount",
		name: "tool_service.skill.invocation_count",
		kind: "counter",
		description: "Skill tool invocations by skill name",
	},
	{
		key: "agentTurnCount",
		name: "agent.turn_count",
		kind: "counter",
		description: "Agent turns by mode and outcome",
	},
	{
		key: "agentTurnLatency",
		name: "agent.turn_latency",
		kind: "histogram",
		description: "Wall-clock duration per agent turn",
		unit: "ms",
	},
	{
		key: "subagentDispatchCount",
		name: "agent.subagent.dispatch_count",
		kind: "counter",
		description:
			"Subagent dispatch decisions by mode, type, provider, and outcome",
	},
	{
		key: "subagentDispatchLatency",
		name: "agent.subagent.dispatch_latency",
		kind: "histogram",
		description: "Latency of subagent dispatch resolution",
		unit: "ms",
	},
	{
		key: "compactionTriggered",
		name: "compaction.triggered",
		kind: "counter",
		description: "Auto-compaction triggers",
	},
	{
		key: "llmRequestCount",
		name: "llm.request_count",
		kind: "counter",
		description: "LLM requests by provider, model, mode",
	},
	{
		key: "llmTokenUsage",
		name: "llm.tokens_used",
		kind: "counter",
		description: "Tokens consumed by direction",
	},
	{
		key: "a2aDelegationCount",
		name: "agent.a2a.delegation_count",
		kind: "counter",
		description: "A2A delegation lifecycle observations by phase and outcome",
	},
	{
		key: "a2aDispatchLatency",
		name: "agent.a2a.dispatch_latency",
		kind: "histogram",
		description: "A2A dispatch latency",
		unit: "ms",
	},
	{
		key: "a2aTaskDuration",
		name: "agent.a2a.task_duration",
		kind: "histogram",
		description: "A2A delegated task duration",
		unit: "ms",
	},
	{
		key: "a2aPushLag",
		name: "agent.a2a.push_lag",
		kind: "histogram",
		description: "Lag between A2A task completion and push receipt",
		unit: "ms",
	},
	{
		key: "a2aPolicyDenialCount",
		name: "agent.a2a.policy_denial_count",
		kind: "counter",
		description: "A2A capability policy denials by source and reason",
	},
	{
		key: "a2aPeerExclusionCount",
		name: "agent.a2a.peer_exclusion_count",
		kind: "counter",
		description: "A2A peer exclusions by source and reason",
	},
] as const satisfies readonly MaestroMetricDefinition[];

type MetricKey = (typeof MAESTRO_OTEL_METRIC_DEFINITIONS)[number]["key"];
type MetricDefinitionByKey = Record<MetricKey, MaestroMetricDefinition>;

const definitionsByKey = Object.fromEntries(
	MAESTRO_OTEL_METRIC_DEFINITIONS.map((definition) => [
		definition.key,
		definition,
	]),
) as MetricDefinitionByKey;

const meter = otelMetrics.getMeter(
	"evalops.maestro",
	process.env.MAESTRO_VERSION ?? "unknown",
);

function counter(key: MetricKey): Counter {
	const definition = definitionsByKey[key];
	return meter.createCounter(definition.name, {
		description: definition.description,
		unit: definition.unit,
	});
}

function histogram(key: MetricKey): Histogram {
	const definition = definitionsByKey[key];
	return meter.createHistogram(definition.name, {
		description: definition.description,
		unit: definition.unit,
	});
}

export const maestroOtelMetrics = {
	toolInvocationCount: counter("toolInvocationCount"),
	toolInvocationLatency: histogram("toolInvocationLatency"),
	skillInvocationCount: counter("skillInvocationCount"),
	agentTurnCount: counter("agentTurnCount"),
	agentTurnLatency: histogram("agentTurnLatency"),
	subagentDispatchCount: counter("subagentDispatchCount"),
	subagentDispatchLatency: histogram("subagentDispatchLatency"),
	a2aDelegationCount: counter("a2aDelegationCount"),
	a2aDispatchLatency: histogram("a2aDispatchLatency"),
	a2aTaskDuration: histogram("a2aTaskDuration"),
	a2aPushLag: histogram("a2aPushLag"),
	a2aPolicyDenialCount: counter("a2aPolicyDenialCount"),
	a2aPeerExclusionCount: counter("a2aPeerExclusionCount"),
	compactionTriggered: counter("compactionTriggered"),
	llmRequestCount: counter("llmRequestCount"),
	llmTokenUsage: counter("llmTokenUsage"),
};

function compactAttributes(
	attributes: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(attributes).filter(
			(entry): entry is [string, string | number | boolean] =>
				entry[1] !== undefined,
		),
	);
}

export function recordToolInvocationMetric(input: {
	toolName: string;
	durationMs?: number;
	success?: boolean;
	surface?: string;
	agentRunId?: string;
	skillName?: string;
}): void {
	const attributes = compactAttributes({
		"tool.name": input.toolName,
		"tool.success": input.success,
		"maestro.surface": input.surface,
		"maestro.agent_run_id": input.agentRunId,
	});
	maestroOtelMetrics.toolInvocationCount.add(1, attributes);
	if (
		typeof input.durationMs === "number" &&
		Number.isFinite(input.durationMs)
	) {
		maestroOtelMetrics.toolInvocationLatency.record(
			input.durationMs,
			attributes,
		);
	}
	if (input.skillName) {
		maestroOtelMetrics.skillInvocationCount.add(
			1,
			compactAttributes({
				...attributes,
				"skill.name": input.skillName,
			}),
		);
	}
}

export function recordAgentTurnMetric(input: {
	durationMs?: number;
	status?: string;
	mode?: string;
	modelId?: string;
	modelProvider?: string;
	surface?: string;
	agentRunId?: string;
}): void {
	const attributes = compactAttributes({
		"agent.turn.status": input.status,
		"agent.turn.mode": input.mode,
		"llm.model.id": input.modelId,
		"llm.model.provider": input.modelProvider,
		"maestro.surface": input.surface,
		"maestro.agent_run_id": input.agentRunId,
	});
	maestroOtelMetrics.agentTurnCount.add(1, attributes);
	if (
		typeof input.durationMs === "number" &&
		Number.isFinite(input.durationMs)
	) {
		maestroOtelMetrics.agentTurnLatency.record(input.durationMs, attributes);
	}
}

export function recordSubagentDispatchMetric(input: {
	mode: string;
	subagentType: string;
	provider: string;
	model: string;
	reasoningEffort: string;
	source?: string;
	success: boolean;
	latencyMs?: number;
	agentRunId?: string;
}): void {
	const attributes = compactAttributes({
		"maestro.subagent.mode": input.mode,
		"maestro.subagent.type": input.subagentType,
		"maestro.subagent.reasoning_effort": input.reasoningEffort,
		"maestro.subagent.source": input.source,
		"maestro.subagent.success": input.success,
		"llm.model.provider": input.provider,
		"llm.model.id": input.model,
		"maestro.agent_run_id": input.agentRunId,
	});
	maestroOtelMetrics.subagentDispatchCount.add(1, attributes);
	if (typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs)) {
		maestroOtelMetrics.subagentDispatchLatency.record(
			input.latencyMs,
			attributes,
		);
	}
}

export function recordA2ADelegationMetric(input: {
	phase: string;
	source?: string;
	status?: string;
	success?: boolean;
	skillId?: string;
	taskClass?: string;
	latencyMs?: number;
	taskDurationMs?: number;
	pushLagMs?: number;
}): void {
	const attributes = compactAttributes({
		"maestro.a2a.phase": input.phase,
		"maestro.a2a.source": input.source,
		"maestro.a2a.status": input.status,
		"maestro.a2a.success": input.success,
		"maestro.a2a.skill_id": input.skillId,
		"maestro.a2a.task_class": input.taskClass,
	});
	maestroOtelMetrics.a2aDelegationCount.add(1, attributes);
	if (isFiniteNumber(input.latencyMs)) {
		maestroOtelMetrics.a2aDispatchLatency.record(input.latencyMs, attributes);
	}
	if (isFiniteNumber(input.taskDurationMs)) {
		maestroOtelMetrics.a2aTaskDuration.record(input.taskDurationMs, attributes);
	}
	if (isFiniteNumber(input.pushLagMs)) {
		maestroOtelMetrics.a2aPushLag.record(input.pushLagMs, attributes);
	}
}

export function recordA2APolicyDenialMetric(input: {
	source?: string;
	reason: string;
	taskClass?: string;
	skillId?: string;
}): void {
	maestroOtelMetrics.a2aPolicyDenialCount.add(
		1,
		compactAttributes({
			"maestro.a2a.source": input.source,
			"maestro.a2a.reason": input.reason,
			"maestro.a2a.task_class": input.taskClass,
			"maestro.a2a.skill_id": input.skillId,
		}),
	);
}

export function recordA2APeerExclusionMetric(input: {
	source?: string;
	reason: string;
	taskClass?: string;
	skillId?: string;
}): void {
	maestroOtelMetrics.a2aPeerExclusionCount.add(
		1,
		compactAttributes({
			"maestro.a2a.source": input.source,
			"maestro.a2a.reason": input.reason,
			"maestro.a2a.task_class": input.taskClass,
			"maestro.a2a.skill_id": input.skillId,
		}),
	);
}

export function recordCompactionMetric(
	attributes: Record<string, string | number | boolean | undefined> = {},
): void {
	maestroOtelMetrics.compactionTriggered.add(1, compactAttributes(attributes));
}

export function recordLlmTokenUsageMetric(
	tokens: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	},
	attributes: Record<string, string | number | boolean | undefined> = {},
): void {
	const compactedAttributes = compactAttributes(attributes);
	const tokenEntries = [
		["input", tokens.input],
		["output", tokens.output],
		["cache_read", tokens.cacheRead],
		["cache_write", tokens.cacheWrite],
	] as const;
	for (const [direction, value] of tokenEntries) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			maestroOtelMetrics.llmTokenUsage.add(
				value,
				compactAttributes({
					...compactedAttributes,
					"llm.token.direction": direction,
				}),
			);
		}
	}
}

function isFiniteNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function recordLlmRequestMetric(input: {
	provider?: string;
	modelId?: string;
	mode?: string;
	surface?: string;
	agentRunId?: string;
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}): void {
	const attributes = compactAttributes({
		"llm.model.provider": input.provider,
		"llm.model.id": input.modelId,
		"llm.request.mode": input.mode,
		"maestro.surface": input.surface,
		"maestro.agent_run_id": input.agentRunId,
	});
	maestroOtelMetrics.llmRequestCount.add(1, attributes);
	if (input.tokens) {
		recordLlmTokenUsageMetric(input.tokens, attributes);
	}
}
