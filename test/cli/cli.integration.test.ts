import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";
import { main } from "../../src/main.js";
import { SessionManager } from "../../src/session/manager.js";

interface MockAgentState {
	model?: unknown;
	thinkingLevel?: string;
	tools?: unknown[];
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

		setTools(tools: unknown[]) {
			this.state.tools = [...tools];
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

vi.mock("../../src/evalops/agent-bootstrap.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../src/evalops/agent-bootstrap.js")
		>();
	return {
		...actual,
		bootstrapEvalOpsAgent: async (
			_options: unknown,
			deps?: { onStatus?: (status: { message: string }) => void },
		) => {
			deps?.onStatus?.({
				message: "Registering Maestro with EvalOps agent MCP",
			});
			return {
				agentId: "agent_json",
				apiKeyCreated: true,
				approvalPolicyAttached: true,
				authenticatedAs: "json@example.com",
				consoleUrl: "https://app.evalops.dev/overview?env=production",
				endpoint: "https://app.evalops.dev/mcp",
				evidenceEventPublished: true,
				evidenceEvents: 1,
				governedActionsLoaded: 17,
				governedInferenceCheckRan: true,
				integrationProfile: "managed_runtime",
				keyPrefix: "pk_live_json",
				memoryMode: "durable",
				organizationId: "org_json",
				registryVisible: true,
				riskFindings: 0,
				runId: "run_json",
				runtimeOwner: "evalops",
				scopesGranted: ["agent:register"],
				sessionExpiresAt: "2026-05-06T13:00:00Z",
				shimType: "sdk",
				stored: true,
				traceIngestionStarted: true,
				traceMode: "otlp",
			};
		},
	};
});

describe("CLI integration", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;
	const originalAgentDir = process.env.MAESTRO_AGENT_DIR;
	const originalMaestroHome = process.env.MAESTRO_HOME;
	const originalOpenAI = process.env.OPENAI_API_KEY;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalAnthropicOAuthFile = process.env.ANTHROPIC_OAUTH_FILE;
	const originalSharedMemoryBase = process.env.MAESTRO_SHARED_MEMORY_BASE;
	const originalSharedMemoryApiKey = process.env.MAESTRO_SHARED_MEMORY_API_KEY;
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
		if (originalSharedMemoryBase === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_SHARED_MEMORY_BASE");
		} else {
			process.env.MAESTRO_SHARED_MEMORY_BASE = originalSharedMemoryBase;
		}
		if (originalSharedMemoryApiKey === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_SHARED_MEMORY_API_KEY");
		} else {
			process.env.MAESTRO_SHARED_MEMORY_API_KEY = originalSharedMemoryApiKey;
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

	async function waitForFile(path: string): Promise<void> {
		const deadline = Date.now() + 500;
		while (!existsSync(path)) {
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for ${path}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

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

	it("keeps maestro init --json stdout parseable", async () => {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		console.log = (...args: unknown[]) => {
			stdoutLines.push(args.map((arg) => String(arg)).join(" "));
		};
		console.error = (...args: unknown[]) => {
			stderrLines.push(args.map((arg) => String(arg)).join(" "));
		};

		await main(["init", "--json"]);

		expect(stderrLines.join("\n")).toContain(
			"Registering Maestro with EvalOps agent MCP",
		);
		expect(stdoutLines).toHaveLength(1);
		const parsed = JSON.parse(stdoutLines[0] ?? "{}") as Record<
			string,
			unknown
		>;
		expect(parsed).toMatchObject({
			agentId: "agent_json",
			integrationProfile: "managed_runtime",
			memoryMode: "durable",
			organizationId: "org_json",
			runtimeOwner: "evalops",
			traceMode: "otlp",
		});
		expect(stdoutLines.join("\n")).not.toContain("Loaded configuration");
	});

	it("includes custom agents init target in force rerun instructions", async () => {
		const target = join(tempAgentDir, "docs", "team guide", "AGENTS.md");
		mkdirSync(join(tempAgentDir, "docs", "team guide"), { recursive: true });
		writeFileSync(target, "# Existing Guidance\n");

		await main(["agents", "init", target]);

		const combined = output.join("\n");
		const quotedTarget =
			process.platform === "win32" ? `"${target}"` : `'${target}'`;
		expect(combined).toContain(`maestro agents init ${quotedTarget} --force`);
		expect(combined).toContain("Index:");
		expect(combined).toContain("--- ");
		expect(combined).toContain("+++ ");
		expect(readFileSync(target, "utf-8")).toBe("# Existing Guidance\n");
	});

	it("applies the previewed agents init scaffold when forced", async () => {
		const target = join(tempAgentDir, "docs", "AGENTS.md");
		mkdirSync(join(tempAgentDir, "docs"), { recursive: true });
		writeFileSync(target, "# Existing Guidance\n");

		await main(["agents", "init", target, "--force"]);

		const combined = output.join("\n");
		const content = readFileSync(target, "utf-8");
		expect(combined).toContain(`Updated AGENTS instructions at ${target}.`);
		expect(combined).not.toContain("Echo:");
		expect(content).toContain("# Repository Guidelines");
		expect(content).toContain("## Imported AI Tooling Rules");
		expect(content).not.toContain("# Existing Guidance");
	});

	it("exports a saved session as portable jsonl", async () => {
		await main(["hello"]);
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session).toBeDefined();

		const outputPath = join(tempAgentDir, "portable-session.jsonl");
		output = [];

		await main(["export", session!.id, outputPath, "--format", "jsonl"]);

		expect(existsSync(outputPath)).toBe(true);
		expect(readFileSync(outputPath, "utf8")).toContain('"type":"session"');
		expect(output.join("\n")).toContain(`Exported session ${session!.id}`);
	});

	it("exports a saved session as portable json with secret redaction", async () => {
		await main(["apiKey=sk-ant-abcdefghijklmnopqrstuvwxyz123456"]);
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session).toBeDefined();

		const outputPath = join(tempAgentDir, "portable-session.json");
		output = [];

		await main([
			"export",
			session!.id,
			outputPath,
			"--format",
			"json",
			"--redact-secrets",
		]);

		expect(existsSync(outputPath)).toBe(true);
		const exported = JSON.parse(readFileSync(outputPath, "utf8")) as {
			format: string;
			entries: Array<unknown>;
		};
		const serialized = JSON.stringify(exported);
		expect(exported.format).toBe("maestro-session-export.v1");
		expect(serialized).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz123456");
		expect(serialized).toContain("[REDACTED:api_key:");
	});

	it("imports a portable jsonl session log", async () => {
		await main(["hello"]);
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session).toBeDefined();
		const sessionFile = sessionManager.getSessionFileById(session!.id);
		expect(sessionFile).toBeTruthy();

		const portablePath = join(tempAgentDir, "portable-import.jsonl");
		copyFileSync(sessionFile!, portablePath);
		output = [];

		await main(["import", portablePath]);

		const importedSessions = await new SessionManager(false).listSessions();
		expect(importedSessions.length).toBeGreaterThan(1);
		expect(output.join("\n")).toContain("Imported session");
	});

	it("imports a portable json session export", async () => {
		await main(["hello"]);
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session).toBeDefined();
		const sessionFile = sessionManager.getSessionFileById(session!.id);
		expect(sessionFile).toBeTruthy();

		const portablePath = join(tempAgentDir, "portable-import.json");
		const entries = readFileSync(sessionFile!, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		writeFileSync(
			portablePath,
			JSON.stringify({
				format: "maestro-session-export.v1",
				exportedAt: new Date().toISOString(),
				entries,
			}),
			"utf8",
		);
		output = [];

		await main(["import", portablePath]);

		const importedSessions = await new SessionManager(false).listSessions();
		expect(importedSessions.length).toBeGreaterThan(1);
		expect(output.join("\n")).toContain("Imported session");
	});

	it("exports and imports portable json bundles with branched sessions", async () => {
		await main(["hello"]);
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session).toBeDefined();
		const sessionFile = sessionManager.getSessionFileById(session!.id);
		expect(sessionFile).toBeTruthy();

		const branchManager = new SessionManager(false, sessionFile!);
		const branchLeafId = branchManager.getLeafId();
		expect(branchLeafId).toBeTruthy();
		branchManager.createBranchedSession(branchLeafId!);

		const portablePath = join(tempAgentDir, "portable-tree.json");
		output = [];
		await main(["export", session!.id, portablePath, "--format", "json"]);

		const exported = JSON.parse(readFileSync(portablePath, "utf8")) as {
			sessions: Array<{ sessionId: string }>;
		};
		expect(exported.sessions).toHaveLength(2);

		output = [];
		await main(["import", portablePath]);

		const importedSessions = await new SessionManager(false).listSessions();
		expect(importedSessions.length).toBe(4);
		expect(output.join("\n")).toContain("Imported 2 sessions");
	});

	it("prints maestro version output", async () => {
		const originalTelemetry = process.env.MAESTRO_TELEMETRY;
		const originalBeaconFile = process.env.MAESTRO_BEACON_FILE;
		const originalBufferFile =
			process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE;
		const beaconFile = join(tempAgentDir, "version-beacon.jsonl");
		const bufferFile = join(tempAgentDir, "version-command-buffer.json");
		process.env.MAESTRO_TELEMETRY = "1";
		process.env.MAESTRO_BEACON_FILE = beaconFile;
		process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = bufferFile;
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		try {
			await expect(main(["--version"])).rejects.toThrow("exit");
			expect(exitCodes).toEqual([0]);
			const combined = output.join("\n");
			expect(combined).toContain("Maestro v");
			expect(combined).not.toContain("Composer v");
			const [startupEvent] = JSON.parse(
				readFileSync(beaconFile, "utf8").trim(),
			) as [{ feature: string; action: string }];
			const commandBuffer = JSON.parse(readFileSync(bufferFile, "utf8")) as {
				counts: Record<string, number>;
			};
			expect(startupEvent).toMatchObject({
				feature: "cli.startup",
				action: "version",
			});
			expect(commandBuffer.counts).toEqual({
				"cli.command.version": 1,
			});
		} finally {
			if (originalTelemetry === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_TELEMETRY");
			} else {
				process.env.MAESTRO_TELEMETRY = originalTelemetry;
			}
			if (originalBeaconFile === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_FILE");
			} else {
				process.env.MAESTRO_BEACON_FILE = originalBeaconFile;
			}
			if (originalBufferFile === undefined) {
				Reflect.deleteProperty(
					process.env,
					"MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE",
				);
			} else {
				process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = originalBufferFile;
			}
			exitSpy.mockRestore();
		}
	});

	it("waits for endpoint startup telemetry before version exits", async () => {
		const originalTelemetry = process.env.MAESTRO_TELEMETRY;
		const originalBeaconFile = process.env.MAESTRO_BEACON_FILE;
		const originalBeaconEndpoint = process.env.MAESTRO_BEACON_ENDPOINT;
		const originalBufferFile =
			process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE;
		const originalTimeout = process.env.MAESTRO_BEACON_TIMEOUT_MS;
		const bufferFile = join(tempAgentDir, "version-endpoint-buffer.json");
		process.env.MAESTRO_TELEMETRY = "1";
		process.env.MAESTRO_BEACON_FILE = "";
		process.env.MAESTRO_BEACON_ENDPOINT = "https://telemetry.example.test";
		process.env.MAESTRO_BEACON_TIMEOUT_MS = "100";
		process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = bufferFile;
		let fetchCompleted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						setTimeout(() => {
							fetchCompleted = true;
							resolve(new Response(null, { status: 200 }));
						}, 75);
					}),
			),
		);
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		try {
			await expect(main(["--version"])).rejects.toThrow("exit");
			expect(exitCodes).toEqual([0]);
			expect(fetchCompleted).toBe(true);
		} finally {
			if (originalTelemetry === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_TELEMETRY");
			} else {
				process.env.MAESTRO_TELEMETRY = originalTelemetry;
			}
			if (originalBeaconFile === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_FILE");
			} else {
				process.env.MAESTRO_BEACON_FILE = originalBeaconFile;
			}
			if (originalBeaconEndpoint === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_ENDPOINT");
			} else {
				process.env.MAESTRO_BEACON_ENDPOINT = originalBeaconEndpoint;
			}
			if (originalBufferFile === undefined) {
				Reflect.deleteProperty(
					process.env,
					"MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE",
				);
			} else {
				process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = originalBufferFile;
			}
			if (originalTimeout === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_TIMEOUT_MS");
			} else {
				process.env.MAESTRO_BEACON_TIMEOUT_MS = originalTimeout;
			}
			exitSpy.mockRestore();
			vi.unstubAllGlobals();
		}
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

	it("rejects legacy runtime as a CLI flag", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});

		await expect(main(["web", "--legacy-runtime"])).rejects.toThrow("exit");
		await expect(
			main(["web", "--mode=headless", "--legacy-runtime"]),
		).rejects.toThrow("exit");

		expect(exitCodes).toEqual([1, 1]);
		const combined = output.join("\n");
		expect(combined).toContain(
			"Legacy headless runtime selection is not available from the CLI",
		);
		exitSpy.mockRestore();
	});

	it("prints providers summary for filter", async () => {
		const originalTelemetry = process.env.MAESTRO_TELEMETRY;
		const originalBeaconFile = process.env.MAESTRO_BEACON_FILE;
		const originalBufferFile =
			process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE;
		const beaconFile = join(tempAgentDir, "models-beacon.jsonl");
		const bufferFile = join(tempAgentDir, "models-command-buffer.json");
		process.env.MAESTRO_TELEMETRY = "1";
		process.env.MAESTRO_BEACON_FILE = beaconFile;
		process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = bufferFile;
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		try {
			await main(["models", "providers", "--provider", "openrouter"]);
			expect(exitCodes).toEqual([0]);
			expect(output.join("\n")).toContain("openrouter");
			await waitForFile(beaconFile);
			await waitForFile(bufferFile);
			const [startupEvent] = JSON.parse(
				readFileSync(beaconFile, "utf8").trim(),
			) as [{ feature: string; action: string }];
			const commandBuffer = JSON.parse(readFileSync(bufferFile, "utf8")) as {
				counts: Record<string, number>;
			};
			expect(startupEvent).toMatchObject({
				feature: "cli.startup",
				action: "models.providers",
			});
			expect(commandBuffer.counts).toEqual({
				"cli.command.models.providers": 1,
			});
		} finally {
			if (originalTelemetry === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_TELEMETRY");
			} else {
				process.env.MAESTRO_TELEMETRY = originalTelemetry;
			}
			if (originalBeaconFile === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_FILE");
			} else {
				process.env.MAESTRO_BEACON_FILE = originalBeaconFile;
			}
			if (originalBufferFile === undefined) {
				Reflect.deleteProperty(
					process.env,
					"MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE",
				);
			} else {
				process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = originalBufferFile;
			}
			exitSpy.mockRestore();
		}
	});

	it("does not wait for endpoint startup telemetry before subcommands", async () => {
		const originalTelemetry = process.env.MAESTRO_TELEMETRY;
		const originalBeaconFile = process.env.MAESTRO_BEACON_FILE;
		const originalBeaconEndpoint = process.env.MAESTRO_BEACON_ENDPOINT;
		const originalBufferFile =
			process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE;
		const originalTimeout = process.env.MAESTRO_BEACON_TIMEOUT_MS;
		process.env.MAESTRO_TELEMETRY = "1";
		process.env.MAESTRO_BEACON_FILE = "";
		process.env.MAESTRO_BEACON_ENDPOINT = "https://telemetry.example.test";
		process.env.MAESTRO_BEACON_TIMEOUT_MS = "10000";
		process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = join(
			tempAgentDir,
			"providers-endpoint-buffer.json",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => {})),
		);
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		try {
			const completed = await Promise.race([
				main(["models", "providers", "--provider", "openrouter"]).then(
					() => true,
				),
				new Promise<boolean>((resolve) => {
					setTimeout(() => resolve(false), 50);
				}),
			]);
			expect(completed).toBe(true);
			expect(exitCodes).toEqual([0]);
			expect(output.join("\n")).toContain("openrouter");
		} finally {
			if (originalTelemetry === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_TELEMETRY");
			} else {
				process.env.MAESTRO_TELEMETRY = originalTelemetry;
			}
			if (originalBeaconFile === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_FILE");
			} else {
				process.env.MAESTRO_BEACON_FILE = originalBeaconFile;
			}
			if (originalBeaconEndpoint === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_ENDPOINT");
			} else {
				process.env.MAESTRO_BEACON_ENDPOINT = originalBeaconEndpoint;
			}
			if (originalBufferFile === undefined) {
				Reflect.deleteProperty(
					process.env,
					"MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE",
				);
			} else {
				process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = originalBufferFile;
			}
			if (originalTimeout === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_BEACON_TIMEOUT_MS");
			} else {
				process.env.MAESTRO_BEACON_TIMEOUT_MS = originalTimeout;
			}
			exitSpy.mockRestore();
			vi.unstubAllGlobals();
		}
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

	it("marks SessionStart hooks as resume during --continue runs", async () => {
		let sessionStartInput: Record<string, unknown> | undefined;

		registerHook("SessionStart", {
			type: "callback",
			callback: async (input) => {
				sessionStartInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await main(["--continue", "hello"]);

		expect(sessionStartInput).toMatchObject({
			hook_event_name: "SessionStart",
			source: "resume",
		});
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
			"Legacy Codex/ChatGPT auth flags are no longer supported",
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
			"Legacy Codex/ChatGPT auth flags are no longer supported",
		);
		exitSpy.mockRestore();
	});

	it("rejects legacy auth flags before status early exit", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(
			main(["--codex-api-key", "codex-token", "status"]),
		).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain(
			"Legacy Codex/ChatGPT auth flags are no longer supported",
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

	it("retries transient shared memory status failures", async () => {
		process.env.MAESTRO_SHARED_MEMORY_BASE = "http://shared-memory.test/";
		process.env.MAESTRO_SHARED_MEMORY_API_KEY = "memory-key";
		let calls = 0;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(init?.headers).toBeInstanceOf(Headers);
			expect((init?.headers as Headers).get("Authorization")).toBe(
				"Bearer memory-key",
			);
			calls += 1;
			if (calls === 1) {
				return new Response("unavailable", {
					status: 503,
					headers: { "Retry-After-Ms": "1" },
				});
			}
			return new Response(
				JSON.stringify({
					status: "ok",
					now: "2026-04-20T00:00:00.000Z",
					capabilities: {
						supports_sync: true,
						supports_gzip: true,
						max_body_bytes: 1024,
						max_events_batch: 10,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { handleMemoryCommand } = await import(
			"../../src/cli/commands/memory.js"
		);
		await handleMemoryCommand("status", []);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const combined = output.join("\n");
		expect(combined).toContain("Shared Memory");
		expect(combined).toContain("Status: ok");
		expect(combined).toContain("max_body");
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
