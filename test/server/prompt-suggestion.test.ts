import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/index.js";
import type { AssistantMessage } from "../../src/agent/types.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import * as registry from "../../src/models/registry.js";
import {
	generatePromptSuggestion,
	getPromptSuggestionSuppressReason,
} from "../../src/server/prompt-suggestion.js";

function makeModel(provider: string, id: string): RegisteredModel {
	return {
		id,
		name: id,
		provider,
		providerName: provider,
		source: "builtin",
		isLocal: false,
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
		},
		reasoning: false,
	};
}

function makeAssistantSummary(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("prompt suggestion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("suppresses early conversations", () => {
		expect(
			getPromptSuggestionSuppressReason([
				{ role: "user", content: "Look at the failing test." },
				{ role: "assistant", content: "I found the failure." },
			]),
		).toBe("early_conversation");
	});

	it("suppresses when the last relevant message is not assistant output", () => {
		expect(
			getPromptSuggestionSuppressReason([
				{ role: "user", content: "Check the current branch." },
				{ role: "assistant", content: "It is on main." },
				{ role: "user", content: "Now inspect the latest commit." },
				{ role: "assistant", content: "The latest commit updated CI." },
				{ role: "user", content: "What should we fix next?" },
			]),
		).toBe("awaiting_assistant");
	});

	it("picks a fast model on the same provider and normalizes the result", async () => {
		const slowModel = makeModel("openai", "gpt-5");
		const fastModel = makeModel("openai", "gpt-5-mini");
		vi.spyOn(registry, "getRegisteredModels").mockReturnValue([
			slowModel,
			fastModel,
		]);

		const generateSummary = vi
			.fn()
			.mockResolvedValue(
				makeAssistantSummary(
					'"Add a regression test for the prompt suggestion endpoint."',
				),
			);
		const createBackgroundAgent = vi
			.fn()
			.mockResolvedValue({ generateSummary } as unknown as Agent);

		const result = await generatePromptSuggestion(
			{
				model: "openai/gpt-5",
				messages: [
					{ role: "user", content: "Inspect the failing web tests." },
					{ role: "assistant", content: "I found a stale prompt bug." },
					{ role: "user", content: "Fix it and update coverage." },
					{
						role: "assistant",
						content: "I fixed the state handling and added tests.",
					},
				],
			},
			{
				getRegisteredModel: vi.fn().mockResolvedValue(slowModel),
				getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5" }),
				createBackgroundAgent,
			},
		);

		expect(createBackgroundAgent).toHaveBeenCalledWith(
			expect.objectContaining({ id: "gpt-5-mini" }),
			expect.objectContaining({
				systemPrompt: expect.stringContaining("next natural user prompt"),
			}),
		);
		expect(generateSummary).toHaveBeenCalled();
		expect(result).toEqual({
			suggestion: "Add a regression test for the prompt suggestion endpoint.",
			model: "openai/gpt-5-mini",
		});
	});

	it("filters empty sentinel responses", async () => {
		const fastModel = makeModel("anthropic", "claude-3-5-haiku");
		vi.spyOn(registry, "getRegisteredModels").mockReturnValue([fastModel]);

		const result = await generatePromptSuggestion(
			{
				model: "anthropic/claude-3-5-haiku",
				messages: [
					{ role: "user", content: "Review the current patch." },
					{ role: "assistant", content: "I found a few issues." },
					{ role: "user", content: "Address them." },
					{ role: "assistant", content: "All addressed and verified." },
				],
			},
			{
				getRegisteredModel: vi.fn().mockResolvedValue(fastModel),
				getCurrentSelection: () => ({
					provider: "anthropic",
					modelId: "claude-3-5-haiku",
				}),
				createBackgroundAgent: vi.fn().mockResolvedValue({
					generateSummary: vi
						.fn()
						.mockResolvedValue(makeAssistantSummary("NONE")),
				} as unknown as Agent),
			},
		);

		expect(result).toEqual({
			suggestion: null,
			suppressedReason: "empty",
			model: "anthropic/claude-3-5-haiku",
		});
	});
});
