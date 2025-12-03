import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/main.js";

interface MockAgentState {
	model?: unknown;
	thinkingLevel?: string;
	messages: Array<{
		role: string;
		content: Array<{ type: string; text: string }>;
		stopReason?: string;
	}>;
}

interface MockAgentConfig {
	initialState?: Partial<MockAgentState>;
}

interface MockAgentEvent {
	type: string;
	message?: unknown;
}

type SubscriptionHandler = (event: MockAgentEvent) => void | Promise<void>;

vi.mock("../../src/agent/agent.js", async () => {
	class Agent {
		public state: MockAgentState;
		private subscribers: SubscriptionHandler[] = [];

		constructor(config: MockAgentConfig) {
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

			const responseText = message.startsWith("JSON:")
				? message.slice(5)
				: `Echo: ${message}`;
			const assistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: responseText }],
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

		replaceMessages(
			messages: Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
			}>,
		) {
			this.state.messages = [...messages];
		}

		setModel(model: unknown) {
			this.state.model = model;
		}

		setThinkingLevel(level: string) {
			this.state.thinkingLevel = level;
		}
	}

	return { Agent };
});

interface MockTransportOptions {
	getApiKey?: () => string;
}

vi.mock("../../src/agent/transport.js", () => ({
	ProviderTransport: class ProviderTransport {
		constructor(public readonly options: MockTransportOptions) {}
	},
}));

vi.mock("../../src/models/builtin.js", () => ({
	getModel: (provider: string, id: string) => ({ provider, id }),
	getProviders: () => ["anthropic"],
	getModels: () => [{ id: "claude-sonnet-4-5", provider: "anthropic" }],
	ensureModelsLoaded: async () => {},
	areModelsLoaded: () => true,
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
	{
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1/responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
		providerName: "OpenAI",
		source: "builtin" as const,
		isLocal: false,
	},
];

vi.mock("../../src/models/registry.js", () => ({
	getRegisteredModels: () => fakeRegisteredModels,
	getSupportedProviders: () => ["anthropic", "openrouter", "openai"],
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
	const originalAgentDir = process.env.COMPOSER_AGENT_DIR;
	const originalOpenAI = process.env.OPENAI_API_KEY;
	const originalCodex = process.env.CODEX_API_KEY;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalAnthropicOAuthFile = process.env.ANTHROPIC_OAUTH_FILE;
	const originalLog = console.log;
	const originalError = console.error;
	const originalStdoutWrite = process.stdout.write;
	let output: string[];
	let tempAgentDir: string;

	beforeEach(() => {
		tempAgentDir = mkdtempSync(join(tmpdir(), "composer-cli-test-"));
		process.env.COMPOSER_AGENT_DIR = tempAgentDir;
		process.env.ANTHROPIC_OAUTH_FILE = join(
			tempAgentDir,
			"anthropic-oauth.json",
		);
		process.env.ANTHROPIC_API_KEY = "test-key";
		// biome-ignore lint/performance/noDelete: ensure env var absence for tests
		delete process.env.OPENAI_API_KEY;
		// biome-ignore lint/performance/noDelete: ensure env var absence for tests
		delete process.env.CODEX_API_KEY;
		// biome-ignore lint/performance/noDelete: ensure env var absence for tests
		delete process.env.CLAUDE_CODE_TOKEN;
		output = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		console.error = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		// Mock stdout.write to capture JSONL output
		process.stdout.write = ((chunk: unknown) => {
			output.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
		process.stdout.write = originalStdoutWrite;
		if (originalEnv === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		}
		if (originalOpenAI === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalOpenAI;
		}
		if (originalCodex === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.CODEX_API_KEY;
		} else {
			process.env.CODEX_API_KEY = originalCodex;
		}
		if (originalClaude === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.CLAUDE_CODE_TOKEN;
		} else {
			process.env.CLAUDE_CODE_TOKEN = originalClaude;
		}
		if (originalAnthropicOAuthFile === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.ANTHROPIC_OAUTH_FILE;
		} else {
			process.env.ANTHROPIC_OAUTH_FILE = originalAnthropicOAuthFile;
		}
		if (originalAgentDir === undefined) {
			process.env.COMPOSER_AGENT_DIR = undefined;
		} else {
			process.env.COMPOSER_AGENT_DIR = originalAgentDir;
		}
		if (tempAgentDir) {
			rmSync(tempAgentDir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("emits JSON events in json mode", async () => {
		await main(["--mode", "json", "hello"]);
		// Should emit JSONL events like thread_start, turn, item, thread_end
		const hasJsonlEvents = output.some(
			(line) =>
				line.includes('"type":"thread"') ||
				line.includes('"type":"turn"') ||
				line.includes('"type":"item"'),
		);
		expect(hasJsonlEvents).toBe(true);
	});

	it("prints models list command output", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(code ?? 0);
			return undefined as never;
		});
		await main(["models", "list"]);
		expect(exitCodes).toEqual([0]);
		expect(output.some((line) => line.includes("anthropic"))).toBe(true);
		exitSpy.mockRestore();
	});

	it("prints providers summary for filter", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(code ?? 0);
			return undefined as never;
		});
		await main(["models", "providers", "--provider", "openrouter"]);
		expect(exitCodes).toEqual([0]);
		expect(output.join("\n")).toContain("openrouter");
		exitSpy.mockRestore();
	});

	it("runs composer exec in text mode", async () => {
		await main(["exec", "Summarize release notes"]);
		const combined = output.join("\n");
		expect(combined).toContain("Echo: Summarize release notes");
	});

	it("streams JSON events in composer exec", async () => {
		const originalWrite = process.stdout.write;
		let streamed = "";
		process.stdout.write = ((chunk: unknown) => {
			streamed += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await main(["exec", "Plan work", "--json"]);
		} finally {
			process.stdout.write = originalWrite;
		}
		expect(streamed).toContain('"type":"thread"');
	});

	it("validates schema in composer exec", async () => {
		await main([
			"exec",
			'JSON:{"result":"ok"}',
			"--output-schema",
			'{"type":"object","properties":{"result":{"const":"ok"}},"required":["result"]}',
		]);
	});

	it("fails schema validation in composer exec", async () => {
		await expect(
			main([
				"exec",
				'JSON:{"result":"ok"}',
				"--output-schema",
				'{"type":"object","required":["status"]}',
			]),
		).rejects.toThrow(/schema/);
	});

	it("supports --last for exec sessions", async () => {
		await main(["exec", "Initial run"]);
		output = [];
		await main(["exec", "--last", "Follow up run"]);
		expect(output.join("\n")).toContain("Echo: Follow up run");
	});

	it("uses chatgpt auth when Codex token is provided", async () => {
		await main([
			"--provider",
			"openai",
			"--model",
			"gpt-test",
			"--auth",
			"chatgpt",
			"--codex-api-key",
			"codex-token",
			"hello",
		]);
		expect(output.join("\n")).toContain("Echo: hello");
	});

	it("fails when chatgpt auth mode lacks a Codex token", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(code ?? 0);
			throw new Error("exit");
		});
		await expect(
			main([
				"--provider",
				"openai",
				"--model",
				"gpt-test",
				"--auth",
				"chatgpt",
				"hello",
			]),
		).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain("CODEX_API_KEY");
		exitSpy.mockRestore();
	});

	it("uses claude auth when Claude Code token is provided", async () => {
		process.env.CLAUDE_CODE_TOKEN = "claude-token";
		await main([
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
			"--auth",
			"claude",
			"hello",
		]);
		expect(output.join("\n")).toContain("Echo: hello");
		// biome-ignore lint/performance/noDelete: resetting test env var
		delete process.env.CLAUDE_CODE_TOKEN;
	});

	it("fails when claude auth mode lacks OAuth tokens", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(code ?? 0);
			throw new Error("exit");
		});
		await expect(
			main([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
				"--auth",
				"claude",
				"hello",
			]),
		).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain("composer anthropic login");
		exitSpy.mockRestore();
	});
});
