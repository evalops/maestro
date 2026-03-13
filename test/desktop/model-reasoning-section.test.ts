import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODE_OPTIONS,
	buildModelReasoningViewModel,
	normalizeModeOptions,
} from "../../packages/desktop/src/renderer/components/Settings/ModelReasoningSection";

describe("normalizeModeOptions", () => {
	it("dedupes mixed mode entries while preserving order", () => {
		const options = normalizeModeOptions([
			"smart",
			{ mode: "rush", config: { description: "Fast" } },
			"smart",
			{ mode: "custom", config: {} },
		]);

		expect(options).toEqual(["smart", "rush", "custom"]);
	});

	it("falls back to the default mode list when empty", () => {
		expect(normalizeModeOptions([])).toEqual(DEFAULT_MODE_OPTIONS);
	});
});

describe("buildModelReasoningViewModel", () => {
	it("prefers available models and includes current mode details", () => {
		const viewModel = buildModelReasoningViewModel(
			[
				{ id: "sonnet", name: "Claude Sonnet", provider: "anthropic" },
				{ id: "sonnet", name: "Claude Sonnet", provider: "anthropic" },
				{ id: "gpt-5", provider: "openai" },
			],
			[{ id: "fallback", provider: "openai" }],
			"anthropic:sonnet",
			{
				mode: "rush",
				config: { description: "Fastest response path" },
			},
			["smart", "rush"],
			"high",
		);

		expect(viewModel.modelOptions).toEqual([
			{ id: "anthropic:sonnet", label: "Claude Sonnet · anthropic" },
			{ id: "openai:gpt-5", label: "gpt-5 · openai" },
		]);
		expect(viewModel.modelEmptyLabel).toBeNull();
		expect(viewModel.selectedModelId).toBe("anthropic:sonnet");
		expect(viewModel.selectedMode).toBe("rush");
		expect(viewModel.modeDescription).toBe("Fastest response path");
		expect(viewModel.thinkingLevel).toBe("high");
	});

	it("falls back to prop models and default modes when needed", () => {
		const viewModel = buildModelReasoningViewModel(
			[],
			[{ id: "sonnet", provider: "anthropic" }],
			"anthropic:sonnet",
			null,
			[],
			"minimal",
		);

		expect(viewModel.modelOptions).toEqual([
			{ id: "anthropic:sonnet", label: "sonnet · anthropic" },
		]);
		expect(viewModel.modeOptions).toEqual(DEFAULT_MODE_OPTIONS);
		expect(viewModel.selectedMode).toBe("smart");
		expect(viewModel.modeDescription).toBeNull();
	});

	it("reports an empty model state", () => {
		const viewModel = buildModelReasoningViewModel(
			[],
			[],
			"",
			null,
			["smart"],
			"off",
		);

		expect(viewModel.modelOptions).toEqual([]);
		expect(viewModel.modelEmptyLabel).toBe("No models detected");
	});
});
