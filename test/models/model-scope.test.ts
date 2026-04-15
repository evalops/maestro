import { describe, expect, it } from "vitest";
import type { RegisteredModel } from "../../src/models/registry.js";
import { scopeModels } from "../../src/models/scope.js";

const baseModel = (id: string, provider = "anthropic"): RegisteredModel => ({
	id,
	name: id,
	provider,
	providerName: provider,
	source: "builtin",
	isLocal: false,
	api: "anthropic-messages",
	baseUrl: "https://api.example.com",
	reasoning: true,
	input: ["text"],
	cost: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200000,
	maxTokens: 4000,
});

describe("scopeModels", () => {
	it("prefers alias over dated variants", () => {
		const models = [
			baseModel("claude-sonnet-4-5-20241010"),
			baseModel("claude-sonnet-4-5"),
		];
		const scoped = scopeModels(["sonnet"], models);
		expect(scoped).toHaveLength(1);
		expect(scoped[0]?.id).toBe("claude-sonnet-4-5");
	});

	it("deduplicates matches across patterns", () => {
		const models = [
			baseModel("gpt-4o-mini", "openai"),
			baseModel("claude-sonnet-4-5"),
		];
		const scoped = scopeModels(["gpt", "openai", "sonnet"], models);
		expect(scoped).toHaveLength(2);
		const ids = scoped.map((model) => model.id);
		expect(ids).toContain("gpt-4o-mini");
		expect(ids).toContain("claude-sonnet-4-5");
	});

	it("returns empty array when no matches found", () => {
		const scoped = scopeModels(["nonexistent"], [baseModel("claude-haiku")]);
		expect(scoped).toHaveLength(0);
	});
});
