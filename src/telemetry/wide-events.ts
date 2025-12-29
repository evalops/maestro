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
import { recordTelemetry } from "../telemetry.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// Turn Collector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collects context during a turn and emits a single wide event at completion.
 *
 * Usage:
 * ```typescript
 * const turn = new TurnCollector(sessionId, turnNumber);
 * turn.setModel({ id: "claude-opus-4-5-20251101", provider: "anthropic", thinkingLevel: "medium" });
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
	private queueStartTime?: number;

	private model: ModelInfo = {
		id: "unknown",
		provider: "unknown",
		thinkingLevel: "off",
	};
	private tools: Map<
		string,
		{ name: string; callId: string; startTime: number; inputSizeBytes?: number }
	> = new Map();
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

	constructor(
		private readonly sessionId: string,
		private readonly turnNumber: number,
		samplingConfig?: Partial<TailSamplingConfig>,
	) {
		this.turnId = randomUUID();
		this.startTime = performance.now();
		this.samplingConfig = { ...DEFAULT_SAMPLING_CONFIG, ...samplingConfig };
	}

	// ─── Setters ──────────────────────────────────────────────────────────────

	setModel(model: ModelInfo): this {
		this.model = model;
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

		// Only persist if sampled
		if (sampled) {
			void recordTelemetry(event);
		}

		return event;
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
): TurnCollector {
	return new TurnCollector(sessionId, turnNumber, config);
}

/**
 * Environment-based sampling config override.
 */
export function getSamplingConfigFromEnv(): Partial<TailSamplingConfig> {
	const config: Partial<TailSamplingConfig> = {};

	const sampleRate = process.env.COMPOSER_WIDE_EVENT_SAMPLE_RATE;
	if (sampleRate) {
		const rate = Number.parseFloat(sampleRate);
		if (!Number.isNaN(rate) && rate >= 0 && rate <= 1) {
			config.successSampleRate = rate;
		}
	}

	const slowThreshold = process.env.COMPOSER_WIDE_EVENT_SLOW_THRESHOLD_MS;
	if (slowThreshold) {
		const threshold = Number.parseInt(slowThreshold, 10);
		if (!Number.isNaN(threshold) && threshold > 0) {
			config.slowThresholdMs = threshold;
		}
	}

	return config;
}
