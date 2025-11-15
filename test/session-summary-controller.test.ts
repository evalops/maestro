import { describe, expect, it } from "vitest";
import type { RegisteredModel } from "../src/models/registry.js";
import { selectSummaryModel } from "../src/tui/session-summary-controller.js";

const baseModel = (overrides: Partial<RegisteredModel>): RegisteredModel => ({
	providerName: overrides.providerName ?? overrides.provider ?? "anthropic",
	source: "builtin",
	isLocal: false,
	api: "openai-responses",
	baseUrl: "https://example.com",
	contextWindow: 128000,
	maxTokens: 4096,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	reasoning: false,
	id: overrides.id ?? "model",
	name: overrides.name ?? "Model",
	provider: overrides.provider ?? "anthropic",
});

describe("selectSummaryModel", () => {
	it("prefers Anthropic Haiku when available", () => {
		const models: RegisteredModel[] = [
			baseModel({ id: "claude-sonnet-4-5", provider: "anthropic" }),
			baseModel({ id: "claude-haiku-4-5", provider: "anthropic" }),
		];
		const selection = selectSummaryModel(models);
		expect(selection?.id).toBe("claude-haiku-4-5");
	});

	it("falls back to OpenAI mini when Anthropic missing", () => {
		const models: RegisteredModel[] = [
			baseModel({ id: "gpt-4o-mini", provider: "openai" }),
			baseModel({ id: "gpt-4o", provider: "openai" }),
		];
		const selection = selectSummaryModel(models);
		expect(selection?.id).toBe("gpt-4o-mini");
	});

	it("falls back to any known provider if no cheap model available", () => {
		const models: RegisteredModel[] = [
			baseModel({ id: "gpt-4o", provider: "openai" }),
		];
		const selection = selectSummaryModel(models);
		expect(selection?.id).toBe("gpt-4o");
	});
});
