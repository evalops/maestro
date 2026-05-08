import { afterEach, describe, expect, it, vi } from "vitest";

const metricRecorders = vi.hoisted(() => ({
	recordAgentTurnMetric: vi.fn(),
	recordLlmRequestMetric: vi.fn(),
	recordLlmTokenUsageMetric: vi.fn(),
	recordToolInvocationMetric: vi.fn(),
}));

vi.mock("../../src/telemetry/metrics.js", () => metricRecorders);

describe("agent tracing metric isolation", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not emit agent turn metrics from tracing spans", async () => {
		const { traceAgentTurn } = await import("../../src/agent/tracing.js");

		await expect(
			traceAgentTurn(
				{
					modelId: "claude-sonnet-4-5",
					modelProvider: "anthropic",
					thinkingLevel: "medium",
					toolCount: 2,
					messageCount: 4,
					surface: "cli",
					agentRunId: "run_123",
				},
				async () => "ok",
			),
		).resolves.toBe("ok");

		expect(metricRecorders.recordAgentTurnMetric).not.toHaveBeenCalled();
	});

	it("does not emit tool metrics from tracing spans", async () => {
		const { traceToolCall } = await import("../../src/agent/tracing.js");

		await expect(
			traceToolCall(
				{
					toolName: "read_file",
					toolCallId: "tool_123",
					inputSize: 20,
					surface: "cli",
					agentRunId: "run_123",
				},
				async () => "ok",
			),
		).resolves.toBe("ok");

		expect(metricRecorders.recordToolInvocationMetric).not.toHaveBeenCalled();
	});

	it("does not emit llm request metrics when the request fails", async () => {
		const { traceLlmRequest } = await import("../../src/agent/tracing.js");
		const error = new Error("request failed");
		metricRecorders.recordLlmRequestMetric.mockImplementation(() => {
			throw new Error("metric failure");
		});

		await expect(
			traceLlmRequest(
				{
					modelId: "claude-sonnet-4-5",
					provider: "anthropic",
					inputTokens: 10,
					outputTokens: 20,
					surface: "cli",
					agentRunId: "run_123",
				},
				async () => {
					throw error;
				},
			),
		).rejects.toBe(error);

		expect(metricRecorders.recordLlmRequestMetric).not.toHaveBeenCalled();
	});

	it("does not emit llm request metrics when the request succeeds", async () => {
		const { traceLlmRequest } = await import("../../src/agent/tracing.js");

		await expect(
			traceLlmRequest(
				{
					modelId: "claude-sonnet-4-5",
					provider: "anthropic",
					inputTokens: 10,
					outputTokens: 20,
				},
				async () => "ok",
			),
		).resolves.toBe("ok");

		expect(metricRecorders.recordLlmRequestMetric).not.toHaveBeenCalled();
	});

	it("does not emit token usage metrics when no span is available", async () => {
		const { recordUsageOnSpan } = await import("../../src/agent/tracing.js");

		recordUsageOnSpan(null, {
			input: 10,
			output: 20,
			cacheRead: 3,
			cacheWrite: 4,
			cost: { input: 0.01, output: 0.02, total: 0.03 },
		});

		expect(metricRecorders.recordLlmTokenUsageMetric).not.toHaveBeenCalled();
	});
});
