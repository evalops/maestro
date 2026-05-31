import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metricRecorders = vi.hoisted(() => ({
	recordAgentTurnMetric: vi.fn(),
	recordLlmRequestMetric: vi.fn(),
	recordLlmTokenUsageMetric: vi.fn(),
}));

vi.mock("../../src/telemetry/metrics.js", () => metricRecorders);

describe("TurnCollector metrics", () => {
	beforeEach(() => {
		vi.stubEnv("MAESTRO_OTEL", "1");
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("records turn and token metrics before canonical-event sampling", async () => {
		const { TurnCollector } = await import(
			"../../src/telemetry/wide-events.js"
		);
		const recorder = vi.fn();
		const collector = new TurnCollector(
			"session-unsampled",
			100,
			{
				alwaysSampleFirstN: 0,
				slowThresholdMs: 999999,
				successSampleRate: 0,
			},
			recorder,
		);
		collector.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "high",
		});

		const event = collector.complete(
			"success",
			{ input: 11, output: 22, cacheRead: 3, cacheWrite: 4 },
			0.01,
		);

		expect(event.sampled).toBe(false);
		expect(recorder).not.toHaveBeenCalled();
		expect(metricRecorders.recordAgentTurnMetric).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "success",
				modelId: "claude-opus-4-6",
				modelProvider: "anthropic",
			}),
		);
		expect(metricRecorders.recordLlmRequestMetric).toHaveBeenCalledWith({
			provider: "anthropic",
			modelId: "claude-opus-4-6",
		});
		expect(metricRecorders.recordLlmTokenUsageMetric).toHaveBeenCalledWith(
			{
				input: 11,
				output: 22,
				cacheRead: 3,
				cacheWrite: 4,
			},
			{
				"llm.model.provider": "anthropic",
				"llm.model.id": "claude-opus-4-6",
			},
		);
	});

	it("counts each LLM request while recording aggregate turn tokens once", async () => {
		const { TurnCollector } = await import(
			"../../src/telemetry/wide-events.js"
		);
		const collector = new TurnCollector("session-tools", 1);
		collector.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "high",
		});

		collector.recordLlmStart();
		collector.recordLlmEnd();
		collector.recordLlmStart();
		collector.recordLlmEnd();
		collector.complete(
			"success",
			{ input: 30, output: 40, cacheRead: 5, cacheWrite: 6 },
			0.02,
		);

		expect(metricRecorders.recordLlmRequestMetric).toHaveBeenCalledTimes(2);
		expect(metricRecorders.recordLlmRequestMetric).toHaveBeenNthCalledWith(1, {
			provider: "anthropic",
			modelId: "claude-opus-4-6",
		});
		expect(metricRecorders.recordLlmRequestMetric).toHaveBeenNthCalledWith(2, {
			provider: "anthropic",
			modelId: "claude-opus-4-6",
		});
		expect(metricRecorders.recordLlmTokenUsageMetric).toHaveBeenCalledTimes(1);
		expect(metricRecorders.recordLlmTokenUsageMetric).toHaveBeenCalledWith(
			{ input: 30, output: 40, cacheRead: 5, cacheWrite: 6 },
			{
				"llm.model.provider": "anthropic",
				"llm.model.id": "claude-opus-4-6",
			},
		);
	});

	it("counts failed LLM attempts even when no usage is produced", async () => {
		const { TurnCollector } = await import(
			"../../src/telemetry/wide-events.js"
		);
		const collector = new TurnCollector("session-provider-error", 1);
		collector.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "high",
		});

		collector.recordLlmStart();
		collector.complete(
			"error",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(metricRecorders.recordLlmRequestMetric).toHaveBeenCalledTimes(1);
		expect(metricRecorders.recordLlmRequestMetric).toHaveBeenCalledWith({
			provider: "anthropic",
			modelId: "claude-opus-4-6",
		});
	});

	it("does not count pre-provider turn errors as LLM requests", async () => {
		const { TurnCollector } = await import(
			"../../src/telemetry/wide-events.js"
		);
		const collector = new TurnCollector("session-early-error", 1);
		collector.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "high",
		});

		collector.complete(
			"error",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			0,
		);

		expect(metricRecorders.recordLlmRequestMetric).not.toHaveBeenCalled();
	});

	it("honors the explicit OTel opt-out for turn metrics", async () => {
		vi.stubEnv("MAESTRO_OTEL", "0");
		const { TurnCollector } = await import(
			"../../src/telemetry/wide-events.js"
		);
		const collector = new TurnCollector("session-otel-disabled", 1);
		collector.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "high",
		});

		collector.complete(
			"success",
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
			0.01,
		);

		expect(metricRecorders.recordAgentTurnMetric).not.toHaveBeenCalled();
		expect(metricRecorders.recordLlmRequestMetric).not.toHaveBeenCalled();
		expect(metricRecorders.recordLlmTokenUsageMetric).not.toHaveBeenCalled();
	});
});
