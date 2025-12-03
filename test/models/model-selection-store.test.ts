import { describe, expect, it } from "vitest";
import type { RegisteredModel } from "../../src/models/registry.js";
import { __modelSelectionStore as store } from "../../src/web-server.js";

describe("model selection store", () => {
	it("preserves model ids containing slashes", () => {
		store.reset();
		const testModel: RegisteredModel = {
			provider: "openrouter",
			id: "openai/o4-mini",
			name: "Test Model",
			api: "openai-completions",
			baseUrl: "https://api.openrouter.ai/api/v1/chat/completions",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			providerName: "OpenRouter",
			source: "custom",
			isLocal: false,
		};
		store.set(testModel);
		const selection = store.get();
		expect(selection).toEqual({
			provider: "openrouter",
			modelId: "openai/o4-mini",
		});
	});
});
