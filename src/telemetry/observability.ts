/**
 * Observability Integration
 *
 * Unified observability layer supporting OpenTelemetry and LangSmith for
 * tracing, metrics, and debugging of agent operations.
 *
 * ## Features
 *
 * - OpenTelemetry span creation for tool calls and LLM requests
 * - LangSmith trace logging for debugging agent behavior
 * - Automatic context propagation
 * - Cost and latency tracking
 * - Error correlation
 *
 * ## Usage
 *
 * ```typescript
 * import { observability } from "./observability.js";
 *
 * // Configure providers
 * observability.configure({
 *   openTelemetry: { enabled: true, endpoint: "http://localhost:4318" },
 *   langSmith: { enabled: true, apiKey: "ls_..." },
 * });
 *
 * // Trace a tool call
 * await observability.traceToolCall("Read", { path: "/file.ts" }, async () => {
 *   return fs.readFile("/file.ts", "utf-8");
 * });
 *
 * // Trace an LLM call
 * await observability.traceLLMCall({
 *   model: "claude-sonnet-4-20250514",
 *   messages: [...],
 * }, async () => {
 *   return anthropic.messages.create(...);
 * });
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("telemetry:observability");

/**
 * Observability configuration
 */
export interface ObservabilityConfig {
	/** OpenTelemetry configuration */
	openTelemetry?: {
		enabled: boolean;
		/** OTLP endpoint (default: http://localhost:4318) */
		endpoint?: string;
		/** Service name (default: composer-agent) */
		serviceName?: string;
		/** Additional resource attributes */
		resourceAttributes?: Record<string, string>;
	};
	/** LangSmith configuration */
	langSmith?: {
		enabled: boolean;
		/** API key (env: LANGSMITH_API_KEY) */
		apiKey?: string;
		/** Project name (default: composer-agent) */
		project?: string;
		/** Endpoint (default: https://api.smith.langchain.com) */
		endpoint?: string;
	};
	/** Enable console logging of traces */
	consoleLogging?: boolean;
	/** Sample rate for traces (0-1, default: 1.0) */
	sampleRate?: number;
}

/**
 * Span context for trace correlation
 */
export interface SpanContext {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	startTime: number;
	attributes: Record<string, unknown>;
}

/**
 * LLM call metadata for tracing
 */
export interface LLMCallMetadata {
	model: string;
	provider?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	cost?: number;
	stopReason?: string;
	temperature?: number;
	maxTokens?: number;
}

/**
 * Tool call metadata for tracing
 */
export interface ToolCallMetadata {
	toolName: string;
	args?: Record<string, unknown>;
	result?: unknown;
	error?: Error;
	durationMs?: number;
}

/**
 * Generate a random trace ID
 */
function generateTraceId(): string {
	return Array.from({ length: 32 }, () =>
		Math.floor(Math.random() * 16).toString(16),
	).join("");
}

/**
 * Generate a random span ID
 */
function generateSpanId(): string {
	return Array.from({ length: 16 }, () =>
		Math.floor(Math.random() * 16).toString(16),
	).join("");
}

/**
 * Observability manager
 */
class ObservabilityManager {
	private config: ObservabilityConfig = {};
	private currentTraceId: string | null = null;
	private spanStack: SpanContext[] = [];
	private pendingSpans: Map<string, SpanContext> = new Map();

	/**
	 * Configure observability providers
	 */
	configure(config: ObservabilityConfig): void {
		this.config = { ...this.config, ...config };

		if (config.openTelemetry?.enabled) {
			logger.info("OpenTelemetry enabled", {
				endpoint: config.openTelemetry.endpoint || "http://localhost:4318",
				serviceName: config.openTelemetry.serviceName || "composer-agent",
			});
		}

		if (config.langSmith?.enabled) {
			logger.info("LangSmith enabled", {
				project: config.langSmith.project || "composer-agent",
				endpoint: config.langSmith.endpoint || "https://api.smith.langchain.com",
			});
		}
	}

	/**
	 * Start a new trace
	 */
	startTrace(name: string, attributes?: Record<string, unknown>): string {
		this.currentTraceId = generateTraceId();

		const span = this.startSpan(name, attributes);

		logger.debug("Trace started", {
			traceId: this.currentTraceId,
			name,
		});

		return span.spanId;
	}

	/**
	 * End the current trace
	 */
	endTrace(): void {
		if (this.spanStack.length > 0) {
			const rootSpan = this.spanStack[0];
			if (rootSpan) {
				this.endSpan(rootSpan.spanId);
			}
		}
		this.currentTraceId = null;
		this.spanStack = [];
	}

	/**
	 * Start a new span
	 */
	startSpan(name: string, attributes?: Record<string, unknown>): SpanContext {
		const spanId = generateSpanId();
		const parentSpan = this.spanStack[this.spanStack.length - 1];

		const span: SpanContext = {
			traceId: this.currentTraceId || generateTraceId(),
			spanId,
			parentSpanId: parentSpan?.spanId,
			startTime: Date.now(),
			attributes: {
				name,
				...attributes,
			},
		};

		this.spanStack.push(span);
		this.pendingSpans.set(spanId, span);

		if (this.config.consoleLogging) {
			logger.debug("Span started", {
				traceId: span.traceId,
				spanId: span.spanId,
				name,
			});
		}

		return span;
	}

	/**
	 * End a span
	 */
	endSpan(
		spanId: string,
		attributes?: Record<string, unknown>,
		error?: Error,
	): void {
		const span = this.pendingSpans.get(spanId);
		if (!span) {
			logger.warn("Span not found", { spanId });
			return;
		}

		const duration = Date.now() - span.startTime;
		const finalAttributes = {
			...span.attributes,
			...attributes,
			durationMs: duration,
			...(error && {
				error: true,
				errorMessage: error.message,
				errorStack: error.stack,
			}),
		};

		// Export to providers
		this.exportSpan(span, finalAttributes, duration);

		// Cleanup
		this.pendingSpans.delete(spanId);
		const idx = this.spanStack.findIndex((s) => s.spanId === spanId);
		if (idx >= 0) {
			this.spanStack.splice(idx, 1);
		}
	}

	/**
	 * Export span to configured providers
	 */
	private exportSpan(
		span: SpanContext,
		attributes: Record<string, unknown>,
		durationMs: number,
	): void {
		// Check sample rate
		if (
			this.config.sampleRate !== undefined &&
			Math.random() > this.config.sampleRate
		) {
			return;
		}

		// Export to OpenTelemetry
		if (this.config.openTelemetry?.enabled) {
			this.exportToOTLP(span, attributes, durationMs);
		}

		// Export to LangSmith
		if (this.config.langSmith?.enabled) {
			this.exportToLangSmith(span, attributes, durationMs);
		}

		// Console logging
		if (this.config.consoleLogging) {
			logger.debug("Span completed", {
				traceId: span.traceId,
				spanId: span.spanId,
				name: attributes["name"],
				durationMs,
				error: attributes["error"],
			});
		}
	}

	/**
	 * Export to OpenTelemetry OTLP endpoint
	 */
	private exportToOTLP(
		span: SpanContext,
		attributes: Record<string, unknown>,
		durationMs: number,
	): void {
		const endpoint = this.config.openTelemetry?.endpoint || "http://localhost:4318";
		const serviceName = this.config.openTelemetry?.serviceName || "composer-agent";

		const otlpSpan = {
			traceId: span.traceId,
			spanId: span.spanId,
			parentSpanId: span.parentSpanId,
			name: String(attributes["name"] || "unknown"),
			kind: 1, // SPAN_KIND_INTERNAL
			startTimeUnixNano: span.startTime * 1_000_000,
			endTimeUnixNano: (span.startTime + durationMs) * 1_000_000,
			attributes: Object.entries(attributes)
				.filter(([key]) => key !== "name")
				.map(([key, value]) => ({
					key,
					value: { stringValue: String(value) },
				})),
			status: attributes["error"]
				? { code: 2, message: String(attributes["errorMessage"]) }
				: { code: 1 },
		};

		const payload = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: serviceName } },
							...Object.entries(this.config.openTelemetry?.resourceAttributes || {}).map(
								([key, value]) => ({
									key,
									value: { stringValue: value },
								}),
							),
						],
					},
					scopeSpans: [
						{
							scope: { name: "composer-agent" },
							spans: [otlpSpan],
						},
					],
				},
			],
		};

		// Fire and forget - don't block on telemetry
		fetch(`${endpoint}/v1/traces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		}).catch((err) => {
			logger.debug("Failed to export to OTLP", { error: err.message });
		});
	}

	/**
	 * Export to LangSmith
	 */
	private exportToLangSmith(
		span: SpanContext,
		attributes: Record<string, unknown>,
		durationMs: number,
	): void {
		const endpoint = this.config.langSmith?.endpoint || "https://api.smith.langchain.com";
		const apiKey = this.config.langSmith?.apiKey || process.env["LANGSMITH_API_KEY"];
		const project = this.config.langSmith?.project || "composer-agent";

		if (!apiKey) {
			logger.debug("LangSmith API key not configured");
			return;
		}

		const run = {
			id: span.spanId,
			trace_id: span.traceId,
			parent_run_id: span.parentSpanId,
			name: String(attributes["name"] || "unknown"),
			run_type: this.inferRunType(attributes),
			start_time: new Date(span.startTime).toISOString(),
			end_time: new Date(span.startTime + durationMs).toISOString(),
			inputs: this.extractInputs(attributes),
			outputs: this.extractOutputs(attributes),
			error: attributes["error"] ? String(attributes["errorMessage"]) : undefined,
			extra: {
				metadata: attributes,
			},
			session_name: project,
		};

		// Fire and forget
		fetch(`${endpoint}/runs`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(run),
		}).catch((err) => {
			logger.debug("Failed to export to LangSmith", { error: err.message });
		});
	}

	/**
	 * Infer LangSmith run type from attributes
	 */
	private inferRunType(attributes: Record<string, unknown>): string {
		if (attributes["model"]) return "llm";
		if (attributes["toolName"]) return "tool";
		return "chain";
	}

	/**
	 * Extract inputs for LangSmith
	 */
	private extractInputs(attributes: Record<string, unknown>): Record<string, unknown> {
		const inputs: Record<string, unknown> = {};

		if (attributes["messages"]) inputs["messages"] = attributes["messages"];
		if (attributes["args"]) inputs["args"] = attributes["args"];
		if (attributes["prompt"]) inputs["prompt"] = attributes["prompt"];
		if (attributes["model"]) inputs["model"] = attributes["model"];

		return inputs;
	}

	/**
	 * Extract outputs for LangSmith
	 */
	private extractOutputs(attributes: Record<string, unknown>): Record<string, unknown> {
		const outputs: Record<string, unknown> = {};

		if (attributes["result"]) outputs["result"] = attributes["result"];
		if (attributes["response"]) outputs["response"] = attributes["response"];
		if (attributes["outputTokens"]) outputs["tokens"] = attributes["outputTokens"];

		return outputs;
	}

	/**
	 * Trace a tool call
	 */
	async traceToolCall<T>(
		toolName: string,
		args: Record<string, unknown>,
		fn: () => Promise<T>,
	): Promise<T> {
		const span = this.startSpan(`tool:${toolName}`, {
			toolName,
			args: this.sanitizeArgs(args),
		});

		try {
			const result = await fn();
			this.endSpan(span.spanId, {
				result: this.sanitizeResult(result),
			});
			return result;
		} catch (error) {
			this.endSpan(span.spanId, {}, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	/**
	 * Trace an LLM call
	 */
	async traceLLMCall<T>(
		metadata: LLMCallMetadata,
		fn: () => Promise<T>,
	): Promise<T> {
		const span = this.startSpan(`llm:${metadata.model}`, {
			model: metadata.model,
			provider: metadata.provider,
			temperature: metadata.temperature,
			maxTokens: metadata.maxTokens,
		});

		try {
			const result = await fn();
			this.endSpan(span.spanId, {
				inputTokens: metadata.inputTokens,
				outputTokens: metadata.outputTokens,
				cachedTokens: metadata.cachedTokens,
				cost: metadata.cost,
				stopReason: metadata.stopReason,
			});
			return result;
		} catch (error) {
			this.endSpan(span.spanId, {}, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	/**
	 * Record a custom event
	 */
	recordEvent(
		name: string,
		attributes?: Record<string, unknown>,
	): void {
		const span = this.startSpan(`event:${name}`, attributes);
		this.endSpan(span.spanId);
	}

	/**
	 * Sanitize args for logging (remove sensitive data)
	 */
	private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(args)) {
			// Skip sensitive fields
			if (key.toLowerCase().includes("key") ||
					key.toLowerCase().includes("secret") ||
					key.toLowerCase().includes("password") ||
					key.toLowerCase().includes("token")) {
				sanitized[key] = "[REDACTED]";
				continue;
			}

			// Truncate long strings
			if (typeof value === "string" && value.length > 1000) {
				sanitized[key] = value.slice(0, 1000) + "...[truncated]";
				continue;
			}

			sanitized[key] = value;
		}

		return sanitized;
	}

	/**
	 * Sanitize result for logging
	 */
	private sanitizeResult(result: unknown): unknown {
		if (typeof result === "string" && result.length > 2000) {
			return result.slice(0, 2000) + "...[truncated]";
		}

		if (typeof result === "object" && result !== null) {
			const json = JSON.stringify(result);
			if (json.length > 2000) {
				return JSON.parse(json.slice(0, 2000) + '"}');
			}
		}

		return result;
	}

	/**
	 * Get current trace ID
	 */
	getCurrentTraceId(): string | null {
		return this.currentTraceId;
	}

	/**
	 * Get current span
	 */
	getCurrentSpan(): SpanContext | null {
		return this.spanStack[this.spanStack.length - 1] || null;
	}

	/**
	 * Check if observability is enabled
	 */
	isEnabled(): boolean {
		return !!(
			this.config.openTelemetry?.enabled ||
			this.config.langSmith?.enabled ||
			this.config.consoleLogging
		);
	}

	/**
	 * Get configuration
	 */
	getConfig(): ObservabilityConfig {
		return { ...this.config };
	}
}

/**
 * Global observability manager instance
 */
export const observability = new ObservabilityManager();

/**
 * Decorator for tracing methods
 */
export function traced(name?: string) {
	return function <T>(
		_target: unknown,
		propertyKey: string,
		descriptor: TypedPropertyDescriptor<(...args: unknown[]) => Promise<T>>,
	): TypedPropertyDescriptor<(...args: unknown[]) => Promise<T>> {
		const originalMethod = descriptor.value!;
		const spanName = name || propertyKey;

		descriptor.value = async function (...args: unknown[]): Promise<T> {
			const span = observability.startSpan(spanName, {
				method: propertyKey,
				argCount: args.length,
			});

			try {
				const result = await originalMethod.apply(this, args);
				observability.endSpan(span.spanId);
				return result;
			} catch (error) {
				observability.endSpan(
					span.spanId,
					{},
					error instanceof Error ? error : new Error(String(error)),
				);
				throw error;
			}
		};

		return descriptor;
	};
}

/**
 * Configure observability from environment
 */
export function configureFromEnv(): void {
	observability.configure({
		openTelemetry: {
			enabled: process.env["OTEL_ENABLED"] === "true",
			endpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
			serviceName: process.env["OTEL_SERVICE_NAME"],
		},
		langSmith: {
			enabled: process.env["LANGSMITH_TRACING"] === "true",
			apiKey: process.env["LANGSMITH_API_KEY"],
			project: process.env["LANGSMITH_PROJECT"],
			endpoint: process.env["LANGSMITH_ENDPOINT"],
		},
		consoleLogging: process.env["TRACE_LOGGING"] === "true",
		sampleRate: process.env["TRACE_SAMPLE_RATE"]
			? parseFloat(process.env["TRACE_SAMPLE_RATE"])
			: 1.0,
	});
}
