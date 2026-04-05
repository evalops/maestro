import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";
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
		private nextRunSystemPromptAdditions: string[] = [];
		private nextRunHistoryMessages: Array<{
			role: string;
			content:
				| string
				| Array<{
						type: string;
						text?: string;
				  }>;
		}> = [];
		private nextRunPromptOnlyMessages: Array<{
			role: string;
			content: Array<{ type: string; text: string }>;
		}> = [];

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
			const queuedSystemPrompt = this.nextRunSystemPromptAdditions.join("\n");
			const queuedHistoryMessages = [...this.nextRunHistoryMessages];
			const queuedPromptOnlyMessages = [...this.nextRunPromptOnlyMessages];
			this.nextRunSystemPromptAdditions = [];
			this.nextRunHistoryMessages = [];
			this.nextRunPromptOnlyMessages = [];

			this.state.messages.push({
				role: "user",
				content: [{ type: "text", text: message }],
			});

			const responseText = message.startsWith("JSON:")
				? message.slice(5)
				: [
						queuedSystemPrompt,
						queuedHistoryMessages
							.map((queuedMessage) =>
								typeof queuedMessage.content === "string"
									? queuedMessage.content
									: queuedMessage.content
											.filter((block) => block.type === "text")
											.map((block) => block.text ?? "")
											.join("\n"),
							)
							.join("\n"),
						queuedPromptOnlyMessages
							.flatMap((queuedMessage) => queuedMessage.content)
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n"),
						`Echo: ${message}`,
					]
						.filter(Boolean)
						.join("\n");
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

		queueNextRunSystemPromptAddition(text: string) {
			this.nextRunSystemPromptAdditions.push(text);
		}

		queueNextRunHistoryMessage(message: {
			role: string;
			content:
				| string
				| Array<{
						type: string;
						text?: string;
				  }>;
		}) {
			this.nextRunHistoryMessages.push(message);
		}

		queueNextRunPromptOnlyMessage(message: {
			role: string;
			content: Array<{ type: string; text: string }>;
		}) {
			this.nextRunPromptOnlyMessages.push(message);
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
	const originalAgentDir = process.env.MAESTRO_AGENT_DIR;
	const originalMaestroHome = process.env.MAESTRO_HOME;
	const originalOpenAI = process.env.OPENAI_API_KEY;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalAnthropicOAuthFile = process.env.ANTHROPIC_OAUTH_FILE;
	const originalLog = console.log;
	const originalError = console.error;
	const originalStdoutWrite = process.stdout.write;
	let output: string[];
	let tempAgentDir: string;

	beforeEach(() => {
		tempAgentDir = mkdtempSync(join(tmpdir(), "composer-cli-test-"));
		process.env.MAESTRO_HOME = tempAgentDir;
		process.env.MAESTRO_AGENT_DIR = tempAgentDir;
		process.env.ANTHROPIC_OAUTH_FILE = join(
			tempAgentDir,
			"anthropic-oauth.json",
		);
		process.env.ANTHROPIC_API_KEY = "test-key";
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
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
			Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
		} else {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		}
		if (originalOpenAI === undefined) {
			Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		} else {
			process.env.OPENAI_API_KEY = originalOpenAI;
		}
		if (originalClaude === undefined) {
			Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
		} else {
			process.env.CLAUDE_CODE_TOKEN = originalClaude;
		}
		if (originalAnthropicOAuthFile === undefined) {
			Reflect.deleteProperty(process.env, "ANTHROPIC_OAUTH_FILE");
		} else {
			process.env.ANTHROPIC_OAUTH_FILE = originalAnthropicOAuthFile;
		}
		if (originalAgentDir === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalAgentDir;
		}
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		if (tempAgentDir) {
			rmSync(tempAgentDir, { recursive: true, force: true });
		}
		clearRegisteredHooks();
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
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		await main(["models", "list"]);
		expect(exitCodes).toEqual([0]);
		expect(output.some((line) => line.includes("anthropic"))).toBe(true);
		exitSpy.mockRestore();
	});

	it("prints maestro version output", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["--version"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([0]);
		const combined = output.join("\n");
		expect(combined).toContain("Maestro v");
		expect(combined).not.toContain("Composer v");
		exitSpy.mockRestore();
	});

	it("fails fast on invalid task budgets", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["--task-budget", "0", "hello"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain(
			"--task-budget must be a positive integer",
		);
		exitSpy.mockRestore();
	});

	it("prints providers summary for filter", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		await main(["models", "providers", "--provider", "openrouter"]);
		expect(exitCodes).toEqual([0]);
		expect(output.join("\n")).toContain("openrouter");
		exitSpy.mockRestore();
	});

	it("prints maestro models help for unknown models subcommand", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["models", "wat"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		const combined = output.join("\n");
		expect(combined).toContain("Unknown models subcommand: wat");
		expect(combined).toContain("maestro models list");
		expect(combined).not.toContain("composer models list");
		exitSpy.mockRestore();
	});

	it("runs composer exec in text mode", async () => {
		await main(["exec", "Summarize release notes"]);
		const combined = output.join("\n");
		expect(combined).toContain("Echo: Summarize release notes");
	});

	it("applies SessionStart hook context before the first CLI prompt", async () => {
		registerHook("SessionStart", {
			type: "callback",
			callback: async () => ({
				systemMessage: "Hook says: keep changes scoped.",
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: "Hook says: this repo uses Nx.",
				},
			}),
		});

		await main(["hello"]);
		const combined = output.join("\n");
		expect(combined).toContain(
			"SessionStart hook system guidance:\nHook says: keep changes scoped.",
		);
		expect(combined).toContain("Hook says: this repo uses Nx.");
		expect(combined).toContain("Echo: hello");
	});

	it("runs SessionEnd hooks after a CLI prompt completes", async () => {
		let sessionEndInput: Record<string, unknown> | undefined;

		registerHook("SessionEnd", {
			type: "callback",
			callback: async (input) => {
				sessionEndInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await main(["hello"]);

		expect(sessionEndInput).toMatchObject({
			hook_event_name: "SessionEnd",
			reason: "complete",
			turn_count: 1,
		});
		expect(sessionEndInput?.duration_ms).toEqual(expect.any(Number));
		expect(Number(sessionEndInput?.duration_ms)).toBeGreaterThanOrEqual(0);
	});

	it("runs SessionEnd hooks after maestro exec completes", async () => {
		let sessionEndInput: Record<string, unknown> | undefined;

		registerHook("SessionEnd", {
			type: "callback",
			callback: async (input) => {
				sessionEndInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await main(["exec", "Summarize release notes"]);

		expect(sessionEndInput).toMatchObject({
			hook_event_name: "SessionEnd",
			reason: "complete",
			turn_count: 1,
		});
		expect(sessionEndInput?.duration_ms).toEqual(expect.any(Number));
		expect(Number(sessionEndInput?.duration_ms)).toBeGreaterThanOrEqual(0);
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

	it("rejects Codex/ChatGPT auth flags", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
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
		expect(output.join("\n")).toContain(
			"Codex/ChatGPT auth mode is no longer supported",
		);
		exitSpy.mockRestore();
	});

	it("rejects Codex subscription tokens", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(
			main(["--codex-api-key", "codex-token", "hello"]),
		).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain(
			"Codex/ChatGPT auth mode is no longer supported",
		);
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
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
	});

	it("fails when claude auth mode lacks OAuth tokens", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
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
		expect(output.join("\n")).toContain("maestro anthropic login");
		exitSpy.mockRestore();
	});

	it("prints maestro usage for unknown hooks subcommand", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		const { handleHooksCommand } = await import(
			"../../src/cli/commands/hooks.js"
		);
		await expect(handleHooksCommand("wat")).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		const combined = output.join("\n");
		expect(combined).toContain("Unknown hooks subcommand: wat");
		expect(combined).toContain("Try: maestro hooks status");
		expect(combined).not.toContain("composer hooks status");
		exitSpy.mockRestore();
	});

	it("shows memory subcommand help before requiring shared memory config", async () => {
		Reflect.deleteProperty(process.env, "MAESTRO_SHARED_MEMORY_BASE");
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		const { handleMemoryCommand } = await import(
			"../../src/cli/commands/memory.js"
		);
		await expect(handleMemoryCommand("wat", [])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		const combined = output.join("\n");
		expect(combined).toContain("Unknown memory subcommand: wat");
		expect(combined).toContain("maestro memory [status]");
		expect(combined).not.toContain("composer memory [status]");
		expect(combined).not.toContain("MAESTRO_SHARED_MEMORY_BASE is not set");
		exitSpy.mockRestore();
	});

	it("reports missing memory session id before requiring shared memory config", async () => {
		Reflect.deleteProperty(process.env, "MAESTRO_SHARED_MEMORY_BASE");
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		const { handleMemoryCommand } = await import(
			"../../src/cli/commands/memory.js"
		);
		await expect(handleMemoryCommand("session", [])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		const combined = output.join("\n");
		expect(combined).toContain("Session id required.");
		expect(combined).not.toContain("MAESTRO_SHARED_MEMORY_BASE is not set");
		exitSpy.mockRestore();
	});

	it("prints maestro config help for unknown config subcommand", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["config", "wat"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		const combined = output.join("\n");
		expect(combined).toContain("Unknown config subcommand: wat");
		expect(combined).toContain("maestro config validate");
		expect(combined).not.toContain("composer config validate");
		exitSpy.mockRestore();
	});

	it("prints maestro cost help for unknown cost subcommand", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["cost", "wat"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		const combined = output.join("\n");
		expect(combined).toContain("Unknown cost subcommand: wat");
		expect(combined).toContain("maestro cost [today]");
		expect(combined).not.toContain("composer cost [today]");
		exitSpy.mockRestore();
	});
});
