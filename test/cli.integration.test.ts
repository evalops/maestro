import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

type SubscriptionHandler = (event: any) => void | Promise<void>;

vi.mock("../src/agent/agent.js", async () => {
	class Agent {
		public state: any;
		private subscribers: SubscriptionHandler[] = [];

		constructor(config: any) {
			this.state = {
				...config.initialState,
				messages: [],
			};
		}

		subscribe(handler: SubscriptionHandler) {
			this.subscribers.push(handler);
		}

		async prompt(message: string) {
			this.state.messages.push({
				role: "user",
				content: [{ type: "text", text: message }],
			});

			const assistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `Echo: ${message}` }],
				stopReason: "completed",
			};
			this.state.messages.push(assistantMessage);

			for (const handler of this.subscribers) {
				await handler({ type: "message_end", message: assistantMessage });
			}
		}

		abort() {
			// no-op for tests
		}

		replaceMessages(messages: any[]) {
			this.state.messages = [...messages];
		}

		setModel(model: any) {
			this.state.model = model;
		}

		setThinkingLevel(level: string) {
			this.state.thinkingLevel = level;
		}
	}

	return { Agent };
});

vi.mock("../src/agent/transport.js", () => ({
	ProviderTransport: class ProviderTransport {
		constructor(public readonly options: any) {}
	},
}));

vi.mock("../src/models/builtin.js", () => ({
	getModel: (provider: string, id: string) => ({ provider, id }),
	getProviders: () => ["anthropic"],
	getModels: () => [{ id: "claude-sonnet-4-5", provider: "anthropic" }],
}));

const fakeRegisteredModels = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1/messages",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		providerName: "Anthropic",
		source: "builtin" as const,
		isLocal: false,
	},
	{
		id: "local-build",
		name: "Local Build",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "http://localhost:11434/v1/chat/completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
		providerName: "OpenRouter Custom",
		source: "custom" as const,
		isLocal: true,
	},
];

vi.mock("../src/models/registry.js", () => ({
	getRegisteredModels: () => fakeRegisteredModels,
	getSupportedProviders: () => ["anthropic", "openrouter"],
	getCustomProviderMetadata: () => undefined,
	getCustomConfigPath: () => "/tmp/composer.json",
	getFactoryDefaultModelSelection: () => ({
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	}),
	reloadModelConfig: () => {},
	resolveAlias: () => null,
	resolveModel: (provider: string, modelId: string) =>
		fakeRegisteredModels.find(
			(model) => model.provider === provider && model.id === modelId,
		) ?? null,
}));

describe("CLI integration", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;
	const originalLog = console.log;
	let output: string[];

	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = "test-key";
		output = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		if (originalEnv === undefined) {
			process.env.ANTHROPIC_API_KEY = undefined;
		} else {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		}
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("emits JSON events in json mode", async () => {
		await main(["--mode", "json", "hello"]);
		expect(output.some((line) => line.includes('"type":"message_end"'))).toBe(
			true,
		);
	});

	it("prints models list command output", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			exitCodes.push(code ?? 0);
			return undefined as never;
		}) as any);
		await main(["models", "list"]);
		expect(exitCodes).toEqual([0]);
		expect(output.some((line) => line.includes("anthropic"))).toBe(true);
		exitSpy.mockRestore();
	});

	it("prints providers summary for filter", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			exitCodes.push(code ?? 0);
			return undefined as never;
		}) as any);
		await main(["models", "providers", "--provider", "openrouter"]);
		expect(exitCodes).toEqual([0]);
		expect(output.join("\n")).toContain("openrouter");
		exitSpy.mockRestore();
	});
});
