import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Maestro OTel metrics catalog", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("defines the canonical agent-domain metric instruments", async () => {
		const createCounter = vi.fn(() => ({ add: vi.fn() }));
		const createHistogram = vi.fn(() => ({ record: vi.fn() }));
		const createUpDownCounter = vi.fn(() => ({ add: vi.fn() }));
		const getMeter = vi.fn(() => ({
			createCounter,
			createHistogram,
			createUpDownCounter,
		}));
		vi.doMock("@opentelemetry/api", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("@opentelemetry/api")>();
			return {
				...actual,
				metrics: {
					...actual.metrics,
					getMeter,
				},
			};
		});

		const { MAESTRO_OTEL_METRIC_DEFINITIONS } = await import(
			"../../src/telemetry/metrics.js"
		);

		expect(
			MAESTRO_OTEL_METRIC_DEFINITIONS.map((metric) => metric.name),
		).toEqual([
			"tool_service.invocation_count",
			"tool_service.invocation_latency",
			"tool_service.skill.invocation_count",
			"agent.turn_count",
			"agent.turn_latency",
			"compaction.triggered",
			"llm.request_count",
			"llm.tokens_used",
		]);
		expect(createUpDownCounter).not.toHaveBeenCalled();
		expect(createCounter).toHaveBeenCalledWith(
			"tool_service.invocation_count",
			{
				description: "Number of tool invocations",
				unit: undefined,
			},
		);
		expect(createHistogram).toHaveBeenCalledWith(
			"tool_service.invocation_latency",
			{
				description: "Latency of tool invocations",
				unit: "ms",
			},
		);
		expect(createCounter).toHaveBeenCalledWith("llm.tokens_used", {
			description: "Tokens consumed by direction",
			unit: undefined,
		});
	});

	it("records tool, turn, compaction, and token observations", async () => {
		const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
		const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
		const upDownCounters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
		const createCounter = vi.fn((name: string) => {
			const instrument = { add: vi.fn() };
			counters.set(name, instrument);
			return instrument;
		});
		const createHistogram = vi.fn((name: string) => {
			const instrument = { record: vi.fn() };
			histograms.set(name, instrument);
			return instrument;
		});
		const createUpDownCounter = vi.fn((name: string) => {
			const instrument = { add: vi.fn() };
			upDownCounters.set(name, instrument);
			return instrument;
		});
		vi.doMock("@opentelemetry/api", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("@opentelemetry/api")>();
			return {
				...actual,
				metrics: {
					...actual.metrics,
					getMeter: vi.fn(() => ({
						createCounter,
						createHistogram,
						createUpDownCounter,
					})),
				},
			};
		});

		const metrics = await import("../../src/telemetry/metrics.js");
		metrics.recordToolInvocationMetric({
			toolName: "bash",
			durationMs: 42,
			success: true,
			skillName: "fix-tests",
		});
		metrics.recordAgentTurnMetric({
			durationMs: 100,
			status: "success",
			modelId: "claude-opus-4-6",
			modelProvider: "anthropic",
		});
		metrics.recordCompactionMetric({ "maestro.session_id": "session_1" });
		metrics.recordLlmRequestMetric({
			provider: "anthropic",
			modelId: "claude-opus-4-6",
			tokens: {
				input: 10,
				output: 20,
				cacheRead: 5,
				cacheWrite: 2,
			},
		});

		expect(
			counters.get("tool_service.invocation_count")?.add,
		).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ "tool.name": "bash", "tool.success": true }),
		);
		expect(
			histograms.get("tool_service.invocation_latency")?.record,
		).toHaveBeenCalledWith(
			42,
			expect.objectContaining({ "tool.name": "bash" }),
		);
		expect(
			counters.get("tool_service.skill.invocation_count")?.add,
		).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ "skill.name": "fix-tests" }),
		);
		expect(counters.get("agent.turn_count")?.add).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ "agent.turn.status": "success" }),
		);
		expect(histograms.get("agent.turn_latency")?.record).toHaveBeenCalledWith(
			100,
			expect.objectContaining({ "llm.model.id": "claude-opus-4-6" }),
		);
		expect(counters.get("compaction.triggered")?.add).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ "maestro.session_id": "session_1" }),
		);
		expect(counters.get("llm.request_count")?.add).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ "llm.model.provider": "anthropic" }),
		);
		expect(counters.get("llm.tokens_used")?.add).toHaveBeenCalledTimes(4);
		expect(counters.get("llm.tokens_used")?.add).toHaveBeenCalledWith(
			10,
			expect.objectContaining({ "llm.token.direction": "input" }),
		);
	});
});
