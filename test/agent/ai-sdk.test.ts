import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	type AgentEvent,
	type Api,
	type Model,
	ProviderTransport,
	getModel,
	getModels,
	getProviders,
} from "../../packages/ai/src/index.js";

const trackUsage = vi.hoisted(() => vi.fn());

vi.mock("../../src/agent/providers/openai.js", () => {
	const streamOpenAI = vi.fn(async function* mockStream() {
		const timestamp = 1_733_000_000_000;
		const partial = {
			role: "assistant" as const,
			content: [],
			api: "openai-completions" as const,
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 8,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp,
		};

		yield { type: "start", partial };
		yield { type: "text_delta", contentIndex: 0, delta: "Hi", partial };
		yield { type: "done", reason: "stop" as const, message: partial };
	});
	return { streamOpenAI };
});

vi.mock("../../src/agent/providers/anthropic.js", () => ({
	streamAnthropic: vi.fn(),
}));
vi.mock("../../src/agent/providers/google.js", () => ({
	streamGoogle: vi.fn(),
}));
vi.mock("../../src/tracking/cost-tracker.js", () => ({
	trackUsage,
}));

describe("@evalops/ai facade", () => {
	beforeEach(() => {
		trackUsage.mockClear();
	});

	it("exposes model registry helpers", () => {
		const providers = getProviders();
		expect(providers.length).toBeGreaterThan(0);

		const firstProvider = providers[0] ?? "openai";
		const models = getModels(firstProvider);
		expect(models.length).toBeGreaterThan(0);

		const candidate = getModel(firstProvider, models[0]?.id ?? "");
		expect(candidate?.id).toBe(models[0]?.id);
	});

	it("streams assistant events through ProviderTransport and tracks usage", async () => {
		const transport = new ProviderTransport({
			getApiKey: () => "sk-test",
		});

		const model: Model<Api> = {
			id: "gpt-test",
			name: "GPT Test",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4000,
		};

		const userMessage = {
			role: "user" as const,
			content: "hello",
			timestamp: 1_733_000_000_000,
		};

		const events: AgentEvent[] = [];
		for await (const event of transport.run([], userMessage, {
			systemPrompt: "You are helpful",
			tools: [],
			model,
			reasoning: "low",
		})) {
			events.push(event);
		}

		expect(events.map((e) => e.type)).toEqual([
			"message_start",
			"message_end",
			"turn_start",
			"message_start",
			"message_update",
			"message_end",
			"turn_end",
		]);

		expect(trackUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "openai",
				model: "gpt-test",
				tokensInput: 8,
				tokensOutput: 4,
			}),
		);
	});
});
