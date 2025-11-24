import { describe, expect, it } from "vitest";
import { __modelSelectionStore as store } from "../src/web-server.js";

describe("model selection store", () => {
	it("preserves model ids containing slashes", () => {
		store.reset();
		store.set({ provider: "openrouter", id: "openai/o4-mini" } as any);
		const selection = store.get();
		expect(selection).toEqual({
			provider: "openrouter",
			modelId: "openai/o4-mini",
		});
	});
});
