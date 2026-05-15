/**
 * Tests for resolveModelFromArgs() — model/provider resolution from CLI args.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/models/registry.js", () => ({
	resolveAlias: vi.fn().mockReturnValue(null),
	findModelById: vi.fn().mockReturnValue(null),
	getFactoryDefaultModelSelection: vi.fn().mockReturnValue({
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	}),
	getSupportedProviders: vi
		.fn()
		.mockReturnValue(["anthropic", "openai", "bedrock", "openai-codex"]),
	resolveModel: vi.fn().mockImplementation((provider: string, id: string) => ({
		api: "anthropic-messages",
		provider,
		id,
		name: id,
		contextWindow: 200000,
	})),
}));

import { resolveModelFromArgs } from "../../src/bootstrap/model-resolution-setup.js";
import {
	findModelById,
	resolveAlias,
	resolveModel,
} from "../../src/models/registry.js";

const mockRequireCredential = vi.fn().mockResolvedValue({ apiKey: "test-key" });
const originalScenarioPath = process.env.MAESTRO_SCENARIO_PATH;

describe("resolveModelFromArgs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireCredential.mockResolvedValue({ apiKey: "test-key" });
	});

	afterEach(() => {
		if (originalScenarioPath === undefined) {
			delete process.env.MAESTRO_SCENARIO_PATH;
			return;
		}
		process.env.MAESTRO_SCENARIO_PATH = originalScenarioPath;
	});

	it("uses factory defaults when no provider or model specified", async () => {
		const result = await resolveModelFromArgs({
			requireCredential: mockRequireCredential,
		});

		expect(result.provider).toBe("anthropic");
		expect(result.modelId).toBe("claude-sonnet-4-5");
	});

	it("parses slash-format provider/model", async () => {
		const result = await resolveModelFromArgs({
			parsedModel: "bedrock/anthropic.claude-v3",
			requireCredential: mockRequireCredential,
		});

		expect(result.provider).toBe("bedrock");
		expect(result.modelId).toBe("anthropic.claude-v3");
	});

	it("does not split on slash when provider segment contains a dot", async () => {
		// e.g. "anthropic.claude-v3/something" — the part before / has a dot
		const result = await resolveModelFromArgs({
			parsedModel: "anthropic.claude-v3",
			requireCredential: mockRequireCredential,
		});

		// Should not be split — falls through to findModelById/factory defaults
		expect(result.provider).toBe("anthropic");
	});

	it("resolves model aliases", async () => {
		(resolveAlias as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			provider: "openai",
			modelId: "gpt-4o",
		});

		const result = await resolveModelFromArgs({
			parsedModel: "gpt4",
			requireCredential: mockRequireCredential,
		});

		expect(result.provider).toBe("openai");
		expect(result.modelId).toBe("gpt-4o");
	});

	it("searches across providers when no alias found", async () => {
		(findModelById as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			provider: "openai",
		});

		const result = await resolveModelFromArgs({
			parsedModel: "gpt-4o",
			requireCredential: mockRequireCredential,
		});

		expect(result.provider).toBe("openai");
		expect(result.modelId).toBe("gpt-4o");
	});

	it("throws on unsupported provider", async () => {
		await expect(
			resolveModelFromArgs({
				parsedProvider: "unknown-provider",
				parsedModel: "some-model",
				requireCredential: mockRequireCredential,
			}),
		).rejects.toThrow(/Unknown provider "unknown-provider"/);
	});

	it("throws when resolveModel returns null", async () => {
		(resolveModel as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

		await expect(
			resolveModelFromArgs({
				parsedProvider: "anthropic",
				parsedModel: "nonexistent-model",
				requireCredential: mockRequireCredential,
			}),
		).rejects.toThrow(/Unknown model/);
	});

	it("calls requireCredential with fatal=false", async () => {
		await resolveModelFromArgs({
			parsedProvider: "anthropic",
			parsedModel: "claude-sonnet-4-5",
			requireCredential: mockRequireCredential,
		});

		expect(mockRequireCredential).toHaveBeenCalledWith("anthropic", false);
	});

	it("still requires non-scripted credentials when scenario env is set", async () => {
		process.env.MAESTRO_SCENARIO_PATH = "/tmp/replay.json";

		await resolveModelFromArgs({
			parsedProvider: "openai",
			parsedModel: "gpt-4o",
			requireCredential: mockRequireCredential,
		});

		expect(mockRequireCredential).toHaveBeenCalledWith("openai", false);
	});

	it("does not require credentials for Codex app-server models", async () => {
		(resolveModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			api: "openai-codex-app-server",
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "gpt-5.5",
			contextWindow: 200000,
		});

		const result = await resolveModelFromArgs({
			parsedProvider: "openai-codex",
			parsedModel: "gpt-5.5",
			requireCredential: mockRequireCredential,
		});

		expect(result.model.api).toBe("openai-codex-app-server");
		expect(mockRequireCredential).not.toHaveBeenCalled();
	});

	it("still requires credentials for legacy Codex responses models", async () => {
		(resolveModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5-codex",
			name: "gpt-5-codex",
			contextWindow: 200000,
		});

		await resolveModelFromArgs({
			parsedProvider: "openai-codex",
			parsedModel: "gpt-5-codex",
			requireCredential: mockRequireCredential,
		});

		expect(mockRequireCredential).toHaveBeenCalledWith("openai-codex", false);
	});

	it("propagates credential errors", async () => {
		mockRequireCredential.mockRejectedValueOnce(
			new Error("No credentials for openai"),
		);

		await expect(
			resolveModelFromArgs({
				parsedProvider: "openai",
				parsedModel: "gpt-4o",
				requireCredential: mockRequireCredential,
			}),
		).rejects.toThrow("No credentials for openai");
	});

	it("wraps PolicyError into plain Error", async () => {
		const { PolicyError } = await import("../../src/safety/policy.js");
		(resolveModel as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new PolicyError("Model not allowed by policy");
		});

		await expect(
			resolveModelFromArgs({
				parsedProvider: "anthropic",
				parsedModel: "claude-sonnet-4-5",
				requireCredential: mockRequireCredential,
			}),
		).rejects.toThrow("Model not allowed by policy");
	});

	it("uses explicit provider when both provider and model given", async () => {
		const result = await resolveModelFromArgs({
			parsedProvider: "openai",
			parsedModel: "gpt-4o",
			requireCredential: mockRequireCredential,
		});

		expect(result.provider).toBe("openai");
		expect(result.modelId).toBe("gpt-4o");
		// Should not attempt alias resolution when provider is explicit
		expect(resolveAlias).not.toHaveBeenCalled();
	});
});
