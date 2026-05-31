import { describe, expect, it } from "vitest";
import { isSelectableWithoutStoredCredential } from "../../src/cli-tui/selectors/model-selector.js";
import type { RegisteredModel } from "../../src/models/registry.js";

const model = (overrides: Partial<RegisteredModel>): RegisteredModel =>
	({
		id: "gpt-5.5",
		name: "GPT-5.5",
		provider: "openai-codex",
		providerName: "OpenAI Codex",
		api: "openai-codex-app-server",
		baseUrl: "codex-app-server://local",
		contextWindow: 272000,
		maxTokens: 128000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		capabilities: {
			tools: true,
			streaming: true,
			vision: true,
			reasoning: true,
		},
		source: "builtin",
		isLocal: false,
		...overrides,
	}) as RegisteredModel;

describe("ModelSelectorComponent credential filtering", () => {
	it("keeps Codex app-server models selectable without Maestro OAuth credentials", () => {
		expect(isSelectableWithoutStoredCredential(model({}))).toBe(true);
	});

	it("still requires stored credentials for legacy Codex responses models", () => {
		expect(
			isSelectableWithoutStoredCredential(
				model({ api: "openai-codex-responses" }),
			),
		).toBe(false);
	});
});
