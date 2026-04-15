import { describe, expect, it, vi } from "vitest";
import { createToolArgumentNormalizer } from "../../src/agent/providers/tool-arguments.js";

describe("tool argument normalization", () => {
	it("parses stringified JSON into object arguments", () => {
		const warn = vi.fn();
		const normalizer = createToolArgumentNormalizer({
			logger: { warn },
			providerLabel: "TestProvider",
		});

		const args = normalizer.normalize('{"path":"/tmp/test.txt"}', {
			toolId: "tool_1",
			name: "read",
			stage: "done",
		});

		expect(args).toEqual({ path: "/tmp/test.txt" });
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns once per provider when parsed arguments are not objects", () => {
		const warn = vi.fn();
		const normalizer = createToolArgumentNormalizer({
			logger: { warn },
			providerLabel: "TestProvider",
		});

		const first = normalizer.normalize('"oops"', {
			toolId: "tool_1",
			name: "read",
			stage: "delta",
		});
		const second = normalizer.normalize('"oops"', {
			toolId: "tool_1",
			name: "read",
			stage: "delta",
		});

		expect(first).toEqual({});
		expect(second).toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("scopes warnings per provider label", () => {
		const warn = vi.fn();
		const normalizerA = createToolArgumentNormalizer({
			logger: { warn },
			providerLabel: "ProviderA",
		});
		const normalizerB = createToolArgumentNormalizer({
			logger: { warn },
			providerLabel: "ProviderB",
		});

		normalizerA.normalize(123, { toolId: "tool_a", name: "read" });
		normalizerA.normalize(123, { toolId: "tool_a", name: "read" });
		normalizerB.normalize(123, { toolId: "tool_b", name: "read" });

		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("preserves partial JSON when normalizing with partial buffers", () => {
		const warn = vi.fn();
		const normalizer = createToolArgumentNormalizer({
			logger: { warn },
			providerLabel: "TestProvider",
		});

		const stringResult = normalizer.normalizeWithPartialJson(
			'{"path":"/tmp/test.txt"}',
			{ callId: "call_1", name: "read", stage: "start" },
			{ expectString: true },
		);

		expect(stringResult.partialJson).toBe('{"path":"/tmp/test.txt"}');
		expect(stringResult.arguments).toEqual({ path: "/tmp/test.txt" });

		const objectResult = normalizer.normalizeWithPartialJson(
			{ path: "/tmp/test.txt" },
			{ callId: "call_1", name: "read", stage: "start" },
			{ expectString: true },
		);

		expect(objectResult.partialJson).toBe("");
		expect(objectResult.arguments).toEqual({ path: "/tmp/test.txt" });
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
