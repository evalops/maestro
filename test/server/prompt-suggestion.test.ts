import { afterEach, describe, expect, it, vi } from "vitest";
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

const sampleMessages = [
	{ role: "user" as const, content: "Inspect the failing web tests." },
	{ role: "assistant" as const, content: "I found a stale prompt bug." },
	{ role: "user" as const, content: "Fix it and update coverage." },
	{
		role: "assistant" as const,
		content: "I fixed the state handling and added tests.",
	},
];

describe("prompt suggestion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
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

	it("picks a fast model on the same provider and normalizes the native result", async () => {
		const slowModel = makeModel("openai", "gpt-5");
		const fastModel = makeModel("openai", "gpt-5-mini");
		vi.spyOn(registry, "getRegisteredModels").mockReturnValue([
			slowModel,
			fastModel,
		]);

		const runNativeBackgroundPrompt = vi.fn().mockResolvedValue({
			ok: true,
			text: '"Add a regression test for the prompt suggestion endpoint."',
		});

		const result = await generatePromptSuggestion(
			{
				model: "openai/gpt-5",
				messages: sampleMessages,
			},
			{
				getRegisteredModel: vi.fn().mockResolvedValue(slowModel),
				getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5" }),
				runNativeBackgroundPrompt,
			},
		);

		expect(runNativeBackgroundPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining("next natural user prompt"),
				modelId: "gpt-5-mini",
			}),
		);
		expect(result).toEqual({
			suggestion: "Add a regression test for the prompt suggestion endpoint.",
			model: "openai/gpt-5-mini",
		});
	});

	it("filters empty sentinel responses from native", async () => {
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
				runNativeBackgroundPrompt: vi.fn().mockResolvedValue({
					ok: true,
					text: "NONE",
				}),
			},
		);

		expect(result).toEqual({
			suggestion: null,
			suppressedReason: "empty",
			model: "anthropic/claude-3-5-haiku",
		});
	});

	it("prefers native path by default and succeeds", async () => {
		const fastModel = makeModel("openai", "gpt-5-mini");
		vi.spyOn(registry, "getRegisteredModels").mockReturnValue([fastModel]);
		const runNativeBackgroundPrompt = vi.fn().mockResolvedValue({
			ok: true,
			text: "Add coverage for the native suggestion path.",
		});

		const result = await generatePromptSuggestion(
			{
				model: "openai/gpt-5-mini",
				messages: sampleMessages,
			},
			{
				getRegisteredModel: vi.fn().mockResolvedValue(fastModel),
				getCurrentSelection: () => ({
					provider: "openai",
					modelId: "gpt-5-mini",
				}),
				runNativeBackgroundPrompt,
			},
		);

		expect(runNativeBackgroundPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining("next natural user prompt"),
				modelId: "gpt-5-mini",
				provider: "openai",
				prompt: expect.stringContaining("Suggest the next user message"),
			}),
		);
		expect(result).toEqual({
			suggestion: "Add coverage for the native suggestion path.",
			model: "openai/gpt-5-mini",
		});
	});

	it("throws on native start failure", async () => {
		const fastModel = makeModel("openai", "gpt-5-mini");
		vi.spyOn(registry, "getRegisteredModels").mockReturnValue([fastModel]);

		const runNativeBackgroundPrompt = vi.fn().mockResolvedValue({
			ok: false,
			error: new Error("spawn ENOENT"),
			phase: "start",
		});

		await expect(
			generatePromptSuggestion(
				{
					model: "openai/gpt-5-mini",
					messages: sampleMessages,
				},
				{
					getRegisteredModel: vi.fn().mockResolvedValue(fastModel),
					getCurrentSelection: () => ({
						provider: "openai",
						modelId: "gpt-5-mini",
					}),
					runNativeBackgroundPrompt,
				},
			),
		).rejects.toThrow("spawn ENOENT");

		expect(runNativeBackgroundPrompt).toHaveBeenCalled();
	});

	it("returns empty on native mid-turn failure", async () => {
		const fastModel = makeModel("openai", "gpt-5-mini");
		vi.spyOn(registry, "getRegisteredModels").mockReturnValue([fastModel]);
		const runNativeBackgroundPrompt = vi.fn().mockResolvedValue({
			ok: false,
			error: new Error("native crashed mid-turn"),
			phase: "turn",
		});

		const result = await generatePromptSuggestion(
			{
				model: "openai/gpt-5-mini",
				messages: sampleMessages,
			},
			{
				getRegisteredModel: vi.fn().mockResolvedValue(fastModel),
				getCurrentSelection: () => ({
					provider: "openai",
					modelId: "gpt-5-mini",
				}),
				runNativeBackgroundPrompt,
			},
		);

		expect(result).toEqual({
			suggestion: null,
			suppressedReason: "empty",
			model: "openai/gpt-5-mini",
		});
	});
});
