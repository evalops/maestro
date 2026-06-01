/**
 * Wide Events Telemetry - Canonical Turn Events
 *
 * Implements the "wide events" pattern from loggingsucks.com:
 * Instead of scattered log statements, emit ONE rich event per agent turn
 * with comprehensive context for analytics-style querying.
 *
 * Key principles:
 * - One event per turn, not N log lines
 * - High-cardinality fields for queryability
 * - Tail sampling: always keep errors/slow, sample successes
 * - Optimized for querying, not writing
 */

import { randomUUID } from "node:crypto";
import type {
	ToolPhaseDecisionOutcome,
	ToolPhaseSummary,
	ToolSchedulingDecision,
} from "../agent/types.js";
import { isOpenTelemetryEnabled } from "../opentelemetry.js";
import type { PromptMetadata } from "../prompts/types.js";
import type { SkillArtifactMetadata } from "../skills/artifact-metadata.js";
import {
	recordAgentTurnMetric,
	recordLlmRequestMetric,
	recordLlmTokenUsageMetric,
} from "./metrics.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecution {
	name: string;
	callId: string;
	durationMs: number;
	success: boolean;
	errorCode?: string;
	inputSizeBytes?: number;
	outputSizeBytes?: number;
	scheduling?: ToolSchedulingDecision;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	thinking?: number;
}

export interface ModelInfo {
	id: string;
	provider: string;
	thinkingLevel:
		| "off"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "max"
		| "ultra";
}

export interface SerializationReasonCount {
	reason: string;
	count: number;
}

export interface ToolSchedulingSummary {
	modelToolCallCount: number;
	modelEmittedToolCallCount: number;
	schedulableWaveCount: number;
	parallelizedCallCount: number;
	actuallyParallelizedCallCount: number;
	serializedCallCount: number;
	delayedCallCount: number;
	blockedByMutationCount: number;
	mcpOptInCallCount: number;
	mcpOptInUseCount: number;
	cacheHitCount: number;
	totalToolWaitMs: number;
	toolWaitTimeMs: number;
	serializationReasons: Record<string, number>;
	topSerializationReasons: SerializationReasonCount[];
}

/**
 * Canonical Turn Event - One wide event per agent turn
 *
 * Contains all context needed to debug and analyze any turn without
 * correlating multiple log lines. Designed for high-cardinality querying.
 */
export interface CanonicalTurnEvent {
	type: "canonical-turn";
	timestamp: string;

	// ─── Identity ───────────────────────────────────────────────────────────
	sessionId: string;
	turnId: string;
	turnNumber: number;
	traceId?: string;

	// ─── Model Context ──────────────────────────────────────────────────────
	model: ModelInfo;
	promptMetadata?: PromptMetadata;
	skillMetadata?: SkillArtifactMetadata[];

	// ─── Timing ─────────────────────────────────────────────────────────────
	totalDurationMs: number;
	llmDurationMs: number;
	toolDurationMs: number;
	queueWaitMs?: number;

	// ─── Tool Executions ────────────────────────────────────────────────────
	tools: ToolExecution[];
	toolCount: number;
	toolSuccessCount: number;
	toolFailureCount: number;
	toolScheduling?: ToolSchedulingSummary;

	// ─── Token Economics ────────────────────────────────────────────────────
	tokens: TokenUsage;
	costUsd: number;

	// ─── Business Context (high cardinality = queryable) ────────────────────
	sandboxMode: "docker" | "local" | "none";
	approvalMode: "auto" | "prompt" | "fail";
	mcpServerCount: number;
	mcpServers?: string[];
	contextSourceCount: number;
	messageCount: number;
	inputSizeBytes: number;
	outputSizeBytes: number;

	// ─── Feature Flags ──────────────────────────────────────────────────────
	features: {
		safeMode: boolean;
		guardianEnabled: boolean;
		compactionEnabled: boolean;
		hookCount: number;
	};

	// ─── Outcome ────────────────────────────────────────────────────────────
	status: "success" | "error" | "aborted" | "rate_limited";
	errorCategory?: string;
	errorMessage?: string;
	abortReason?: "user" | "timeout" | "context_overflow" | "rate_limit";

	// ─── Sampling Metadata ──────────────────────────────────────────────────
	sampled: boolean;
	sampleReason: "always" | "error" | "slow" | "first_turn" | "random";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tail Sampling Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface TailSamplingConfig {
	/** Sample rate for successful fast turns (0.0 to 1.0) */
	successSampleRate: number;
	/** Threshold in ms above which a turn is considered "slow" */
	slowThresholdMs: number;
	/** Always sample first N turns of a session */
	alwaysSampleFirstN: number;
}

const DEFAULT_SAMPLING_CONFIG: TailSamplingConfig = {
	successSampleRate: 0.05, // 5% of successful fast turns
	slowThresholdMs: 5000, // 5 seconds
	alwaysSampleFirstN: 1, // Always sample first turn
};

/**
 * Telemetry recorder function type.
 * Injected to break circular dependency with telemetry.ts.
 */
export type TelemetryRecorder = (event: CanonicalTurnEvent) => Promise<void>;

// Default recorder - imported lazily to break circular dependency
let defaultRecorder: TelemetryRecorder | undefined;

/**
 * Set the default telemetry recorder.
 * Called once during initialization to inject the recordTelemetry function.
 */
export function setDefaultTelemetryRecorder(recorder: TelemetryRecorder): void {
	defaultRecorder = recorder;
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn Collector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collects context during a turn and emits a single wide event at completion.
 *
 * Usage:
 * ```typescript
 * const turn = new TurnCollector(sessionId, turnNumber);
 * turn.setModel({ id: "claude-opus-4-6", provider: "anthropic", thinkingLevel: "medium" });
 *
 * // During tool execution
 * turn.recordToolStart("bash", "call-123");
 * // ... execute tool ...
 * turn.recordToolEnd("call-123", true, 150);
 *
 * // At turn end
 * turn.complete("success", tokens, costUsd);
 * ```
 */
export class TurnCollector {
	private readonly turnId: string;
	private readonly startTime: number;
	private llmStartTime?: number;
	private accumulatedLlmDurationMs = 0;
	private llmRequestCount = 0;
	private queueStartTime?: number;

	private model: ModelInfo = {
		id: "unknown",
		provider: "unknown",
		thinkingLevel: "off",
	};
	private promptMetadata?: PromptMetadata;
	private readonly skillMetadata = new Map<string, SkillArtifactMetadata>();
	private tools: Map<
		string,
		{ name: string; callId: string; startTime: number; inputSizeBytes?: number }
	> = new Map();
	private readonly toolSchedulingDecisions = new Map<
		string,
		ToolSchedulingDecision
	>();
	private readonly toolPhaseSummaries: ToolPhaseSummary[] = [];
	private completedTools: ToolExecution[] = [];

	// Context fields
	private sandboxMode: CanonicalTurnEvent["sandboxMode"] = "none";
	private approvalMode: CanonicalTurnEvent["approvalMode"] = "prompt";
	private mcpServers: string[] = [];
	private contextSourceCount = 0;
	private messageCount = 0;
	private inputSizeBytes = 0;
	private outputSizeBytes = 0;
	private features = {
		safeMode: false,
		guardianEnabled: true,
		compactionEnabled: true,
		hookCount: 0,
	};

	private samplingConfig: TailSamplingConfig;
	private traceId?: string;
	private recorder?: TelemetryRecorder;

	constructor(
		private readonly sessionId: string,
		private readonly turnNumber: number,
		samplingConfig?: Partial<TailSamplingConfig>,
		recorder?: TelemetryRecorder,
	) {
		this.turnId = randomUUID();
		this.startTime = performance.now();
		this.samplingConfig = { ...DEFAULT_SAMPLING_CONFIG, ...samplingConfig };
		this.recorder = recorder;
	}

	// ─── Setters ──────────────────────────────────────────────────────────────

	setModel(model: ModelInfo): this {
		this.model = model;
		return this;
	}

	setPromptMetadata(promptMetadata: PromptMetadata | undefined): this {
		this.promptMetadata = promptMetadata;
		return this;
	}

	recordSkillMetadata(skillMetadata: SkillArtifactMetadata | undefined): this {
		if (!skillMetadata) {
			return this;
		}
		const key = [
			skillMetadata.artifactId,
			skillMetadata.source,
			skillMetadata.name,
			skillMetadata.version,
			skillMetadata.hash,
		]
			.filter(Boolean)
			.join(":");
		if (!key) {
			return this;
		}
		this.skillMetadata.set(key, skillMetadata);
		return this;
	}

	setTraceId(traceId: string): this {
		this.traceId = traceId;
		return this;
	}

	setSandboxMode(mode: CanonicalTurnEvent["sandboxMode"]): this {
		this.sandboxMode = mode;
		return this;
	}

	setApprovalMode(mode: CanonicalTurnEvent["approvalMode"]): this {
		this.approvalMode = mode;
		return this;
	}

	setMcpServers(servers: string[]): this {
		this.mcpServers = servers;
		return this;
	}

	setContextSourceCount(count: number): this {
		this.contextSourceCount = count;
		return this;
	}

	setMessageCount(count: number): this {
		this.messageCount = count;
		return this;
	}

	setInputSize(bytes: number): this {
		this.inputSizeBytes = bytes;
		return this;
	}

	addOutputSize(bytes: number): this {
		this.outputSizeBytes += bytes;
		return this;
	}

	setFeatures(features: Partial<TurnCollector["features"]>): this {
		this.features = { ...this.features, ...features };
		return this;
	}

	// ─── Timing ───────────────────────────────────────────────────────────────

	recordQueueStart(): this {
		this.queueStartTime = performance.now();
		return this;
	}

	recordLlmStart(): this {
		this.llmRequestCount += 1;
		this.llmStartTime = performance.now();
		return this;
	}

	recordLlmEnd(): this {
		// Accumulate LLM duration (turns may have multiple LLM calls)
		if (this.llmStartTime !== undefined) {
			this.accumulatedLlmDurationMs += performance.now() - this.llmStartTime;
			this.llmStartTime = undefined;
		}
		return this;
	}

	// ─── Tool Recording ───────────────────────────────────────────────────────

	recordToolStart(name: string, callId: string, inputSizeBytes?: number): this {
		this.tools.set(callId, {
			name,
			callId,
			inputSizeBytes,
			// Store start time; will be converted to duration in recordToolEnd
			startTime: performance.now(),
		});
		return this;
	}

	recordToolSchedulingDecision(decision: ToolSchedulingDecision): this {
		this.toolSchedulingDecisions.set(decision.callId, {
			...decision,
			schedulerWaitMs:
				decision.schedulerWaitMs !== undefined
					? Math.max(0, Math.round(decision.schedulerWaitMs))
					: undefined,
		});
		return this;
	}

	recordToolPhaseSummary(summary: ToolPhaseSummary): this {
		this.toolPhaseSummaries.push(summary);
		for (const decision of summary.decisions ?? []) {
			this.recordToolSchedulingDecision({
				callId: decision.toolCallId,
				toolName: decision.toolName,
				emittedIndex: decision.emittedIndex,
				waveIndex: decision.waveIndex,
				decision: decision.decision,
				reason: decision.reason,
				schedulerWaitMs: decision.schedulerWaitMs,
				mcpOptIn: decision.mcpOptIn,
				cacheHit: decision.cacheHit,
				blockedByMutation: decision.blockedByMutation,
			});
		}
		for (const tool of this.completedTools) {
			tool.scheduling ??= this.toolSchedulingDecisions.get(tool.callId);
		}
		return this;
	}

	recordToolEnd(
		callId: string,
		success: boolean,
		outputSizeBytes?: number,
		errorCode?: string,
	): this {
		const tool = this.tools.get(callId);
		if (tool && typeof tool.startTime === "number") {
			const completed: ToolExecution = {
				name: tool.name ?? "unknown",
				callId,
				durationMs: performance.now() - tool.startTime,
				success,
				errorCode,
				inputSizeBytes: tool.inputSizeBytes,
				outputSizeBytes,
				scheduling: this.toolSchedulingDecisions.get(callId),
			};
			this.completedTools.push(completed);
			this.tools.delete(callId);
		}
		return this;
	}

	// ─── Completion ───────────────────────────────────────────────────────────

	/**
	 * Complete the turn and emit the canonical event.
	 * Applies tail sampling logic to decide whether to persist.
	 */
	complete(
		status: CanonicalTurnEvent["status"],
		tokens: TokenUsage,
		costUsd: number,
		errorDetails?: { category?: string; message?: string },
		abortReason?: CanonicalTurnEvent["abortReason"],
		metricTokens: TokenUsage = tokens,
	): CanonicalTurnEvent {
		const endTime = performance.now();
		const totalDurationMs = endTime - this.startTime;

		// Calculate timing breakdown (use accumulated LLM duration for multi-call turns)
		const llmDurationMs = this.accumulatedLlmDurationMs;
		const toolDurationMs = this.completedTools.reduce(
			(sum, t) => sum + t.durationMs,
			0,
		);
		// Calculate queue wait time, clamping to 0 if queueStartTime > startTime
		// (which shouldn't happen but prevents negative values in telemetry)
		const queueWaitMs =
			this.queueStartTime !== undefined
				? Math.max(0, this.startTime - this.queueStartTime)
				: undefined;
		const toolScheduling = this.summarizeToolScheduling();

		// Apply tail sampling
		const { sampled, sampleReason } = this.shouldSample(
			status,
			totalDurationMs,
		);

		const event: CanonicalTurnEvent = {
			type: "canonical-turn",
			timestamp: new Date().toISOString(),

			// Identity
			sessionId: this.sessionId,
			turnId: this.turnId,
			turnNumber: this.turnNumber,
			traceId: this.traceId,

			// Model
			model: this.model,
			promptMetadata: this.promptMetadata,
			skillMetadata:
				this.skillMetadata.size > 0
					? [...this.skillMetadata.values()]
					: undefined,

			// Timing
			totalDurationMs: Math.round(totalDurationMs),
			llmDurationMs: Math.round(llmDurationMs),
			toolDurationMs: Math.round(toolDurationMs),
			queueWaitMs:
				queueWaitMs !== undefined ? Math.round(queueWaitMs) : undefined,

			// Tools
			tools: this.completedTools,
			toolCount: this.completedTools.length,
			toolSuccessCount: this.completedTools.filter((t) => t.success).length,
			toolFailureCount: this.completedTools.filter((t) => !t.success).length,
			toolScheduling,

			// Tokens
			tokens,
			costUsd,

			// Business context
			sandboxMode: this.sandboxMode,
			approvalMode: this.approvalMode,
			mcpServerCount: this.mcpServers.length,
			mcpServers: this.mcpServers.length > 0 ? this.mcpServers : undefined,
			contextSourceCount: this.contextSourceCount,
			messageCount: this.messageCount,
			inputSizeBytes: this.inputSizeBytes,
			outputSizeBytes: this.outputSizeBytes,

			// Features
			features: this.features,

			// Outcome
			status,
			errorCategory: errorDetails?.category,
			errorMessage: errorDetails?.message,
			abortReason,

			// Sampling
			sampled,
			sampleReason,
		};

		if (isOpenTelemetryEnabled()) {
			try {
				recordAgentTurnMetric({
					durationMs: event.totalDurationMs,
					status: event.status,
					modelId: event.model.id,
					modelProvider: event.model.provider,
				});
				const llmRequestCount = Math.max(
					this.llmRequestCount,
					hasTokenUsage(metricTokens) ? 1 : 0,
				);
				for (
					let requestIndex = 0;
					requestIndex < llmRequestCount;
					requestIndex++
				) {
					recordLlmRequestMetric({
						provider: event.model.provider,
						modelId: event.model.id,
					});
				}
				recordLlmTokenUsageMetric(metricTokens, {
					"llm.model.provider": event.model.provider,
					"llm.model.id": event.model.id,
				});
			} catch {
				// Metrics must never affect canonical event creation or sampling.
			}
		}

		// Only persist if sampled
		if (sampled) {
			const recorder = this.recorder ?? defaultRecorder;
			if (recorder) {
				void recorder(event);
			}
		}

		return event;
	}

	private summarizeToolScheduling(): ToolSchedulingSummary | undefined {
		if (this.toolPhaseSummaries.length > 0) {
			// A turn can fail after per-call scheduling is recorded but before the
			// final phase summary is emitted; merge those unsummarized calls back in.
			return summarizeToolPhaseSummaries(this.toolPhaseSummaries, [
				...this.toolSchedulingDecisions.values(),
			]);
		}

		const decisions = [...this.toolSchedulingDecisions.values()].sort(
			(left, right) => left.emittedIndex - right.emittedIndex,
		);
		return summarizeToolSchedulingDecisions(decisions);
	}

	// ─── Sampling Logic ───────────────────────────────────────────────────────

	private shouldSample(
		status: CanonicalTurnEvent["status"],
		totalDurationMs: number,
	): { sampled: boolean; sampleReason: CanonicalTurnEvent["sampleReason"] } {
		// Always sample errors
		if (status === "error") {
			return { sampled: true, sampleReason: "error" };
		}

		// Always sample first N turns
		if (this.turnNumber <= this.samplingConfig.alwaysSampleFirstN) {
			return { sampled: true, sampleReason: "first_turn" };
		}

		// Always sample slow turns
		if (totalDurationMs >= this.samplingConfig.slowThresholdMs) {
			return { sampled: true, sampleReason: "slow" };
		}

		// Random sampling for successful fast turns
		if (Math.random() < this.samplingConfig.successSampleRate) {
			return { sampled: true, sampleReason: "random" };
		}

		return { sampled: false, sampleReason: "random" };
	}
}

function summarizeToolSchedulingDecisions(
	decisions: ToolSchedulingDecision[],
): ToolSchedulingSummary | undefined {
	if (decisions.length === 0) {
		return undefined;
	}

	const sortedDecisions = [...decisions].sort(
		(left, right) => left.emittedIndex - right.emittedIndex,
	);
	const waveCounts = new Map<number, number>();
	for (const decision of sortedDecisions) {
		if (decision.waveIndex !== undefined) {
			waveCounts.set(
				decision.waveIndex,
				(waveCounts.get(decision.waveIndex) ?? 0) + 1,
			);
		}
	}
	const classifiedDecisions = sortedDecisions.map((decision) =>
		classifyToolSchedulingDecision(
			decision,
			decision.waveIndex !== undefined
				? (waveCounts.get(decision.waveIndex) ?? 1)
				: 1,
			sortedDecisions.length,
		),
	);
	const serializationReasons = new Map<string, number>();
	for (const decision of classifiedDecisions) {
		if (decision.outcome === "delayed" || decision.outcome === "serialized") {
			serializationReasons.set(
				decision.reason,
				(serializationReasons.get(decision.reason) ?? 0) + 1,
			);
		}
	}

	return {
		modelToolCallCount: sortedDecisions.length,
		modelEmittedToolCallCount: sortedDecisions.length,
		schedulableWaveCount: waveCounts.size,
		parallelizedCallCount: classifiedDecisions.filter(
			(decision) => decision.outcome === "parallelized",
		).length,
		actuallyParallelizedCallCount: classifiedDecisions.filter(
			(decision) => decision.outcome === "parallelized",
		).length,
		serializedCallCount: classifiedDecisions.filter(
			(decision) =>
				decision.outcome === "serialized" || decision.outcome === "delayed",
		).length,
		delayedCallCount: classifiedDecisions.filter(
			(decision) => decision.outcome === "delayed",
		).length,
		blockedByMutationCount: sortedDecisions.filter(
			(decision) => decision.blockedByMutation === true,
		).length,
		mcpOptInCallCount: sortedDecisions.filter(
			(decision) => decision.mcpOptIn === true,
		).length,
		mcpOptInUseCount: sortedDecisions.filter(
			(decision) => decision.mcpOptIn === true,
		).length,
		cacheHitCount: sortedDecisions.filter(
			(decision) => decision.cacheHit === true,
		).length,
		totalToolWaitMs: sortedDecisions.reduce(
			(total, decision) => total + (decision.schedulerWaitMs ?? 0),
			0,
		),
		toolWaitTimeMs: sortedDecisions.reduce(
			(total, decision) => total + (decision.schedulerWaitMs ?? 0),
			0,
		),
		serializationReasons: Object.fromEntries(serializationReasons),
		topSerializationReasons: topSerializationReasons(
			Object.fromEntries(serializationReasons),
		),
	};
}

function classifyToolSchedulingDecision(
	decision: ToolSchedulingDecision,
	waveSize: number,
	modelToolCallCount: number,
): { outcome: ToolPhaseDecisionOutcome; reason: string } {
	const outcome: ToolPhaseDecisionOutcome =
		decision.cacheHit === true
			? "cached"
			: decision.decision === "skipped"
				? "skipped"
				: decision.decision === "delayed" || decision.blockedByMutation === true
					? "delayed"
					: decision.decision === "parallelized" ||
							(waveSize > 1 && decision.decision === "scheduled")
						? "parallelized"
						: "serialized";
	const reason =
		outcome === "cached"
			? "cache_hit"
			: decision.blockedByMutation === true
				? decision.reason
				: decision.reason === "workflow_state_serialized"
					? "workflow_state_serialized"
					: decision.mcpOptIn === true
						? "mcp_parallel_opt_in"
						: decision.reason.startsWith("read_only")
							? outcome === "parallelized"
								? "read_only_parallel_safe"
								: modelToolCallCount === 1
									? "single_read_only_call"
									: decision.reason
							: decision.reason.startsWith("path_scoped_mutation")
								? "path_scoped_mutation"
								: decision.reason;

	return { outcome, reason };
}

function countSerializationReasons(
	decisions: ToolPhaseSummary["decisions"],
): Record<string, number> {
	const reasons: Record<string, number> = {};
	for (const decision of decisions) {
		if (decision.outcome === "serialized" || decision.outcome === "delayed") {
			reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
		}
	}
	return reasons;
}

function summarizeToolPhaseSummaries(
	summaries: ToolPhaseSummary[],
	recordedDecisions: ToolSchedulingDecision[] = [],
): ToolSchedulingSummary {
	const summarizedCallIds = new Set(
		summaries.flatMap((summary) =>
			(summary.decisions ?? []).map((decision) => decision.toolCallId),
		),
	);
	const supplementalSummary = summarizeToolSchedulingDecisions(
		recordedDecisions.filter(
			(decision) => !summarizedCallIds.has(decision.callId),
		),
	);
	const decisions = summaries.flatMap((summary) => summary.decisions ?? []);
	const serializationReasons =
		decisions.length > 0
			? countSerializationReasons(decisions)
			: mergeSerializationReasons(summaries);

	const summary = {
		modelToolCallCount: summaries.reduce(
			(total, summary) => total + (summary.modelToolCallCount ?? 0),
			0,
		),
		modelEmittedToolCallCount: summaries.reduce(
			(total, summary) =>
				total +
				(summary.modelEmittedToolCallCount ?? summary.modelToolCallCount ?? 0),
			0,
		),
		schedulableWaveCount: summaries.reduce(
			(total, summary) => total + (summary.schedulableWaveCount ?? 0),
			0,
		),
		parallelizedCallCount: summaries.reduce(
			(total, summary) => total + (summary.parallelizedCallCount ?? 0),
			0,
		),
		actuallyParallelizedCallCount: summaries.reduce(
			(total, summary) =>
				total +
				(summary.actuallyParallelizedCallCount ??
					summary.parallelizedCallCount ??
					0),
			0,
		),
		serializedCallCount: summaries.reduce(
			(total, summary) => total + (summary.serializedCallCount ?? 0),
			0,
		),
		delayedCallCount: summaries.reduce(
			(total, summary) => total + (summary.delayedCallCount ?? 0),
			0,
		),
		blockedByMutationCount: summaries.reduce(
			(total, summary) => total + (summary.blockedByMutationCount ?? 0),
			0,
		),
		mcpOptInCallCount: summaries.reduce(
			(total, summary) => total + (summary.mcpOptInCallCount ?? 0),
			0,
		),
		mcpOptInUseCount: summaries.reduce(
			(total, summary) =>
				total + (summary.mcpOptInUseCount ?? summary.mcpOptInCallCount ?? 0),
			0,
		),
		cacheHitCount: summaries.reduce(
			(total, summary) => total + (summary.cacheHitCount ?? 0),
			0,
		),
		totalToolWaitMs: summaries.reduce(
			(total, summary) => total + (summary.totalToolWaitMs ?? 0),
			0,
		),
		toolWaitTimeMs: summaries.reduce(
			(total, summary) =>
				total + (summary.toolWaitTimeMs ?? summary.totalToolWaitMs ?? 0),
			0,
		),
		serializationReasons,
		topSerializationReasons: topSerializationReasons(serializationReasons),
	};

	return supplementalSummary
		? mergeToolSchedulingSummaries(summary, supplementalSummary)
		: summary;
}

function mergeToolSchedulingSummaries(
	left: ToolSchedulingSummary,
	right: ToolSchedulingSummary,
): ToolSchedulingSummary {
	const serializationReasons = {
		...left.serializationReasons,
	};
	for (const [reason, count] of Object.entries(right.serializationReasons)) {
		serializationReasons[reason] = (serializationReasons[reason] ?? 0) + count;
	}

	return {
		modelToolCallCount: left.modelToolCallCount + right.modelToolCallCount,
		modelEmittedToolCallCount:
			left.modelEmittedToolCallCount + right.modelEmittedToolCallCount,
		schedulableWaveCount:
			left.schedulableWaveCount + right.schedulableWaveCount,
		parallelizedCallCount:
			left.parallelizedCallCount + right.parallelizedCallCount,
		actuallyParallelizedCallCount:
			left.actuallyParallelizedCallCount + right.actuallyParallelizedCallCount,
		serializedCallCount: left.serializedCallCount + right.serializedCallCount,
		delayedCallCount: left.delayedCallCount + right.delayedCallCount,
		blockedByMutationCount:
			left.blockedByMutationCount + right.blockedByMutationCount,
		mcpOptInCallCount: left.mcpOptInCallCount + right.mcpOptInCallCount,
		mcpOptInUseCount: left.mcpOptInUseCount + right.mcpOptInUseCount,
		cacheHitCount: left.cacheHitCount + right.cacheHitCount,
		totalToolWaitMs: left.totalToolWaitMs + right.totalToolWaitMs,
		toolWaitTimeMs: left.toolWaitTimeMs + right.toolWaitTimeMs,
		serializationReasons,
		topSerializationReasons: topSerializationReasons(serializationReasons),
	};
}

function mergeSerializationReasons(
	summaries: ToolPhaseSummary[],
): Record<string, number> {
	const reasons: Record<string, number> = {};
	for (const summary of summaries) {
		for (const [reason, count] of Object.entries(
			summary.serializationReasons ?? {},
		)) {
			reasons[reason] = (reasons[reason] ?? 0) + count;
		}
	}
	return reasons;
}

function topSerializationReasons(
	reasons: Record<string, number>,
): SerializationReasonCount[] {
	return Object.entries(reasons)
		.map(([reason, count]) => ({ reason, count }))
		.sort((left, right) => right.count - left.count);
}

function hasTokenUsage(tokens: TokenUsage): boolean {
	return (
		tokens.input > 0 ||
		tokens.output > 0 ||
		tokens.cacheRead > 0 ||
		tokens.cacheWrite > 0
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new turn collector for a session.
 */
export function createTurnCollector(
	sessionId: string,
	turnNumber: number,
	config?: Partial<TailSamplingConfig>,
	recorder?: TelemetryRecorder,
): TurnCollector {
	return new TurnCollector(sessionId, turnNumber, config, recorder);
}

/**
 * Environment-based sampling config override.
 */
export function getSamplingConfigFromEnv(): Partial<TailSamplingConfig> {
	const config: Partial<TailSamplingConfig> = {};

	const sampleRate = process.env.MAESTRO_WIDE_EVENT_SAMPLE_RATE;
	if (sampleRate) {
		const rate = Number.parseFloat(sampleRate);
		if (!Number.isNaN(rate) && rate >= 0 && rate <= 1) {
			config.successSampleRate = rate;
		}
	}

	const slowThreshold = process.env.MAESTRO_WIDE_EVENT_SLOW_THRESHOLD_MS;
	if (slowThreshold) {
		const threshold = Number.parseInt(slowThreshold, 10);
		if (!Number.isNaN(threshold) && threshold > 0) {
			config.slowThresholdMs = threshold;
		}
	}

	return config;
}
