import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderTransport } from "../../src/agent/transport.js";
import type {
	AgentRunConfig,
	Context,
	Message,
	Model,
} from "../../src/agent/types.js";

const openaiProviderMock = vi.hoisted(() => {
	const streamOpenAI = vi.fn(async function* () {
		const message = {
			role: "assistant" as const,
			content: [],
			api: "openai-completions" as const,
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};

		yield { type: "done" as const, reason: "stop" as const, message };
	});

	return { streamOpenAI };
});

const scriptedProviderMock = vi.hoisted(() => {
	const streamScriptedReplay = vi.fn(async function* () {
		const message = {
			role: "assistant" as const,
			content: [],
			api: "scripted-replay" as const,
			provider: "scripted-replay",
			model: "maestro-replay-v1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};

		yield { type: "done" as const, reason: "stop" as const, message };
	});

	return { streamScriptedReplay };
});

vi.mock("../../src/agent/providers/openai.js", () => openaiProviderMock);
vi.mock("../../src/agent/providers/scripted.js", () => scriptedProviderMock);
vi.mock("../../src/agent/keys.js", () => ({
	getStoredCredentials: vi.fn(() => ({})),
}));

const originalScenarioPath = process.env.MAESTRO_SCENARIO_PATH;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

const openAiModel: Model<"openai-completions"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 256,
};

const context: Context = {
	systemPrompt: "Test",
	messages: [],
	tools: [],
};

const userMessage: Message = {
	role: "user",
	content: "hello",
	timestamp: 1,
};

afterEach(() => {
	openaiProviderMock.streamOpenAI.mockClear();
	scriptedProviderMock.streamScriptedReplay.mockClear();
	if (originalScenarioPath === undefined) {
		delete process.env.MAESTRO_SCENARIO_PATH;
	} else {
		process.env.MAESTRO_SCENARIO_PATH = originalScenarioPath;
	}
	if (originalOpenAiKey === undefined) {
		delete process.env.OPENAI_API_KEY;
	} else {
		process.env.OPENAI_API_KEY = originalOpenAiKey;
	}
});

describe("scripted replay routing guards", () => {
	it("keeps non-scripted provider streams on their selected provider", async () => {
		process.env.MAESTRO_SCENARIO_PATH = "/tmp/replay.json";
		const { createProviderStream } = await import(
			"../../src/agent/transport/create-provider-stream.js"
		);

		const stream = createProviderStream(
			openAiModel,
			context,
			{ apiKey: "test-key", maxTokens: 64 },
			{},
		);

		await stream.next();

		expect(openaiProviderMock.streamOpenAI).toHaveBeenCalledOnce();
		expect(scriptedProviderMock.streamScriptedReplay).not.toHaveBeenCalled();
	});

	it("still requires real credentials for non-scripted providers", async () => {
		process.env.MAESTRO_SCENARIO_PATH = "/tmp/replay.json";
		delete process.env.OPENAI_API_KEY;

		const transport = new ProviderTransport({
			getApiKey: () => undefined,
			getAuthContext: () => undefined,
		});
		const config: AgentRunConfig = {
			systemPrompt: "",
			tools: [],
			model: openAiModel,
		};

		await expect(transport.run([], userMessage, config).next()).rejects.toThrow(
			'No credentials found for provider "openai"',
		);
		expect(openaiProviderMock.streamOpenAI).not.toHaveBeenCalled();
	});
});
