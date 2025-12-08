import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/models/registry.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/models/registry.js")
	>("../../src/models/registry.js");
	return {
		...actual,
		resolveAlias: (id: string) =>
			id === "fast-model" ? { provider: "openai", modelId: "gpt-fast" } : null,
		getFactoryDefaultModelSelection: () => ({
			provider: "anthropic",
			modelId: "claude-default",
		}),
		getRegisteredModels: () => [
			{ provider: "openai", id: "gpt-fast", name: "Fast", api: "chat" },
			{
				provider: "anthropic",
				id: "claude-default",
				name: "Claude",
				api: "chat",
			},
		],
	};
});

import {
	determineModelSelection,
	getRegisteredModelOrThrow,
	parseModelInput,
} from "../../src/server/model-selection.js";

describe("model-selection", () => {
	it("parses provider/model with colon or slash", () => {
		expect(parseModelInput("openai:gpt-4o")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
		expect(parseModelInput("openai/gpt-4o")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
	});

	it("applies alias resolution", () => {
		const selection = determineModelSelection(
			"fast-model",
			"anthropic",
			"claude-3",
		);
		expect(selection).toEqual({ provider: "openai", modelId: "gpt-fast" });
	});

	it("falls back to factory default when no input provided", () => {
		const selection = determineModelSelection(null, "anthropic", "claude-3");
		expect(selection).toEqual({
			provider: "anthropic",
			modelId: "claude-default",
		});
	});

	it("requires registered models", () => {
		expect(() =>
			getRegisteredModelOrThrow({ provider: "missing", modelId: "none" }),
		).toThrow(/not found/);
	});
});
