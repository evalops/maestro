import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("recordUsageOnSpan", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("adds usage attributes to an existing span without emitting metrics", async () => {
		const recordLlmTokenUsageMetric = vi.fn();
		const setAttributes = vi.fn();

		vi.doMock("../../src/telemetry/metrics.js", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("../../src/telemetry/metrics.js")>();
			return {
				...actual,
				recordLlmTokenUsageMetric,
			};
		});

		const { recordUsageOnSpan } = await import("../../src/agent/tracing.js");
		const span = { setAttributes } as Parameters<typeof recordUsageOnSpan>[0];

		recordUsageOnSpan(span, {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.03,
			},
		});

		expect(recordLlmTokenUsageMetric).not.toHaveBeenCalled();
		expect(setAttributes).toHaveBeenCalledWith({
			"llm.usage.input_tokens": 10,
			"llm.usage.output_tokens": 5,
			"llm.usage.cache_read_tokens": 2,
			"llm.usage.cache_write_tokens": 1,
			"llm.usage.cost_total": 0.03,
		});
	});
});
