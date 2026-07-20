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
import { HeadlessErrorMessageSchema } from "@evalops/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchNativeCli } from "../../src/cli/native-tui-launcher.js";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";
import { main } from "../../src/main.js";
import { resetOAuthStorageForTests } from "../../src/oauth/storage.js";
import { SessionManager } from "../../src/session/manager.js";
import { resetGlobalCliCommandAggregatorForTests } from "../../src/telemetry/index.js";

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
	{
		id: "gpt-5.5",
		name: "GPT 5.5 Codex",
		api: "openai-codex-app-server",
		provider: "openai-codex",
		baseUrl: "http://127.0.0.1:0",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 16384,
		providerName: "OpenAI Codex",
		source: "builtin" as const,
		isLocal: false,
	},
];

vi.mock("../../src/models/registry.js", () => ({
	getRegisteredModels: () => fakeRegisteredModels,
	getSupportedProviders: () => [
		"anthropic",
		"openrouter",
		"openai",
		"openai-codex",
	],
	getCustomProviderMetadata: () => undefined,
	getCustomConfigPath: () => "/tmp/composer.json",
	getFactoryDefaultModelSelection: () => null,
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

vi.mock("../../src/cli/native-tui-launcher.js", () => {
	return {
		buildNativeHostedRunnerArgs: (
			commandArgs: readonly string[],
			defaultPort?: number,
		) => {
			const args = ["hosted-runner", ...commandArgs];
			const hasExplicitAddress = commandArgs.some(
				(arg) =>
					arg === "--listen" ||
					arg.startsWith("--listen=") ||
					arg === "--port" ||
					arg.startsWith("--port="),
			);
			if (defaultPort !== undefined && !hasExplicitAddress) {
				args.push("--port", String(defaultPort));
			}
			return args;
		},
		// Keep selection helpers real-enough for routing; only spawn is stubbed.
		shouldLaunchNativeInteractiveTui: (parsed: {
			command?: string;
			messages: string[];
			mode?: string;
			headless?: boolean;
		}) => {
			if (parsed.command !== undefined) return false;
			if (
				parsed.headless ||
				parsed.mode === "headless" ||
				parsed.mode === "rpc"
			) {
				return false;
			}
			if (parsed.mode === "json" || parsed.mode === "text") return false;
			if (parsed.messages.length > 0) {
				// Non-TTY pipes use print mode in tests.
				return false;
			}
			return true;
		},
		shouldLaunchNativePrint: (parsed: {
			command?: string;
			messages: string[];
			mode?: string;
			headless?: boolean;
			execJson?: boolean;
		}) => {
			if (
				parsed.headless ||
				parsed.mode === "headless" ||
				parsed.mode === "rpc"
			) {
				return false;
			}
			if (parsed.command === "exec") {
				return parsed.messages.length > 0;
			}
			if (parsed.command !== undefined) return false;
			if (parsed.messages.length === 0) return false;
			return (
				parsed.mode === "text" ||
				parsed.mode === "json" ||
				Boolean(parsed.execJson) ||
				true
			);
		},
		shouldLaunchNativeHeadless: (parsed: {
			command?: string;
			mode?: string;
			headless?: boolean;
		}) =>
			Boolean(parsed.headless) ||
			parsed.mode === "headless" ||
			parsed.mode === "rpc" ||
			parsed.command === "headless",
		isNativeCliHelperCommand: (command?: string) =>
			[
				"sessions",
				"cost",
				"stats",
				"models",
				"status",
				"hooks",
				"export",
				"import",
			].includes(command ?? ""),
		// Integration tests do not ship a built maestro-tui; simulate native handoff.
		launchNativeTui: vi.fn(
			async (options: {
				parsed: {
					print?: boolean;
					json?: boolean;
					messages?: string[];
					headless?: boolean;
				};
			}) => {
				const messages = options.parsed.messages ?? [];
				const prompt = messages.join(" ");
				if (options.parsed.print && options.parsed.json) {
					process.stdout.write(
						`${JSON.stringify({
							type: "item",
							subtype: "message_delta",
							text: `Echo: ${prompt}`,
						})}\n`,
					);
					process.stdout.write(
						`${JSON.stringify({ type: "thread", phase: "start" })}\n`,
					);
					process.stdout.write(
						`${JSON.stringify({
							type: "item",
							subtype: "message_complete",
							text: `Echo: ${prompt}`,
						})}\n`,
					);
				} else if (options.parsed.print) {
					process.stdout.write(`Echo: ${prompt}\n`);
				}
				return 0;
			},
		),
		launchNativeCli: vi.fn(async (tokens: string[]) => {
			const commandIndex = tokens.findIndex((token) =>
				[
					"models",
					"sessions",
					"cost",
					"stats",
					"status",
					"hooks",
					"export",
					"import",
				].includes(token),
			);
			const [cmd, ...rest] = tokens.slice(Math.max(0, commandIndex));
			if (cmd === "models") {
				const sub = rest[0] ?? "list";
				if (
					sub === "providers" ||
					rest.includes("--provider") ||
					rest.includes("openrouter")
				) {
					console.log("Providers (native catalog)");
					console.log("OpenRouter");
					console.log("openrouter");
					return 0;
				}
				if (
					sub !== "list" &&
					sub !== "ls" &&
					sub !== "providers" &&
					!sub.startsWith("-")
				) {
					console.error(`Unknown models subcommand: ${sub}`);
					console.log("Available commands:");
					console.log("  maestro models list");
					console.log("  maestro models providers");
					return 1;
				}
				console.log("Registered models (native catalog)");
				console.log("Anthropic  (3 models)");
				console.log("OpenAI  (5 models)");
				return 0;
			}
			if (cmd === "export") {
				const { handleExportCommand } = await import(
					"../../src/cli/commands/session-transfer.js"
				);
				const formatIdx = rest.indexOf("--format");
				const format = formatIdx >= 0 ? rest[formatIdx + 1] : undefined;
				const redact = rest.includes("--redact-secrets");
				const args = rest.filter(
					(t, i) =>
						t !== "--format" &&
						t !== "--redact-secrets" &&
						!(formatIdx >= 0 && i === formatIdx + 1),
				);
				await handleExportCommand(args[0], args[1], format, {
					redactSecrets: redact,
				});
				return 0;
			}
			if (cmd === "import") {
				const { handleImportCommand } = await import(
					"../../src/cli/commands/session-transfer.js"
				);
				await handleImportCommand(rest[0]);
				return 0;
			}
			if (cmd === "sessions") {
				const sub = rest[0] ?? "list";
				if (sub === "export") {
					const { handleExportCommand } = await import(
						"../../src/cli/commands/session-transfer.js"
					);
					await handleExportCommand(rest[1], rest[2]);
					return 0;
				}
				if (sub === "import") {
					const { handleImportCommand } = await import(
						"../../src/cli/commands/session-transfer.js"
					);
					await handleImportCommand(rest[1]);
					return 0;
				}
				console.log("No sessions found");
				return 0;
			}
			if (
				cmd === "cost" ||
				cmd === "stats" ||
				cmd === "status" ||
				cmd === "hooks"
			) {
				console.log(`native ${cmd} ok`);
				return 0;
			}
			return 0;
		}),
	};
});

describe("CLI integration", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;
	const originalAgentDir = process.env.MAESTRO_AGENT_DIR;
	const originalMaestroHome = process.env.MAESTRO_HOME;
	const originalOpenAI = process.env.OPENAI_API_KEY;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalSharedMemoryBase = process.env.MAESTRO_SHARED_MEMORY_BASE;
	const originalSharedMemoryApiKey = process.env.MAESTRO_SHARED_MEMORY_API_KEY;
	const originalSessionDir = process.env.MAESTRO_SESSION_DIR;
	const originalMaestroProfile = process.env.MAESTRO_PROFILE;
	const originalDisableKeychain = process.env.MAESTRO_DISABLE_KEYCHAIN;
	const originalLog = console.log;
	const originalError = console.error;
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let output: string[];
	let tempAgentDir: string;

	async function runMain(args: string[]): Promise<number> {
		try {
			await main(args);
			return 0;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const match = /^process\.exit\((\d+)\)$/.exec(message);
			if (match) {
				return Number(match[1]);
			}
			throw error;
		}
	}

	async function seedSession(content = "hello"): Promise<string> {
		const sessionManager = new SessionManager(false);
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: content }],
			timestamp: Date.now(),
		};
		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: `Echo: ${content}` }],
			timestamp: Date.now(),
		};
		const state = {
			model: {
				provider: "anthropic",
				id: "claude-test",
				name: "claude-test",
				api: "anthropic-messages",
				contextWindow: 200_000,
				maxTokens: 8192,
				reasoning: false,
				source: "builtin" as const,
				isLocal: false,
				baseUrl: "https://api.anthropic.com",
			},
			thinkingLevel: "off" as const,
			systemPrompt: "test",
			tools: [] as [],
			messages: [userMessage, assistantMessage],
		};
		sessionManager.startSession(state as never);
		sessionManager.saveMessage(userMessage as never);
		sessionManager.saveMessage(assistantMessage as never);
		return sessionManager.getSessionId();
	}

	beforeEach(() => {
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${Number(code ?? 0)})`);
		});
		tempAgentDir = mkdtempSync(join(tmpdir(), "composer-cli-test-"));
		process.env.MAESTRO_HOME = tempAgentDir;
		process.env.MAESTRO_AGENT_DIR = tempAgentDir;
		process.env.ANTHROPIC_API_KEY = "test-key";
		// Force file-mode OAuth storage so the OS keychain can't leak a
		// stale `evalops` credential into provider-discovery / beacon
		// configuration when CI test ordering differs from local
		// (PR #2752 root-caused this pattern across other test files).
		process.env.MAESTRO_DISABLE_KEYCHAIN = "1";
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
		resetGlobalCliCommandAggregatorForTests();
		// `cachedMode` in `src/oauth/storage.ts` is a module-level
		// singleton; if a prior test in the same vitest worker already
		// cached the keychain backend, just setting the env var here
		// doesn't switch storage mode. Call the reset explicitly so the
		// new `MAESTRO_DISABLE_KEYCHAIN=1` value takes effect.
		resetOAuthStorageForTests();
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
		process.stderr.write = ((chunk: unknown) => {
			output.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
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
		if (originalSessionDir === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_SESSION_DIR");
		} else {
			process.env.MAESTRO_SESSION_DIR = originalSessionDir;
		}
		if (originalMaestroProfile === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_PROFILE");
		} else {
			process.env.MAESTRO_PROFILE = originalMaestroProfile;
		}
		if (originalDisableKeychain === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_DISABLE_KEYCHAIN");
		} else {
			process.env.MAESTRO_DISABLE_KEYCHAIN = originalDisableKeychain;
		}
		if (tempAgentDir) {
			rmSync(tempAgentDir, { recursive: true, force: true });
		}
		clearRegisteredHooks();
		vi.restoreAllMocks();
		vi.resetModules();
		// Re-clear the OAuth storage cache so the restored env (without
		// our forced `MAESTRO_DISABLE_KEYCHAIN`) is honored by the next
		// test in the same worker.
		resetOAuthStorageForTests();
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

	async function readJsonFileEventually<T>(
		path: string,
		predicate?: (value: T) => boolean,
	): Promise<T> {
		// The beacon-buffer flushes are concurrent with the CLI command, so the
		// file is often written through transient intermediate states (e.g.
		// `{counts:{}}`) before reaching the value a caller wants to assert on.
		// Without a predicate the helper returns at the first parseable read,
		// which sometimes captures an empty snapshot and produces flakes like
		// "expected undefined to be 1" on `counts["cli.command.<name>"]`.
		// Pass a predicate to keep polling until the relevant fields are set.
		const deadline = Date.now() + 2000;
		let lastError: unknown;
		let lastParsed: T | undefined;
		while (Date.now() < deadline) {
			if (existsSync(path)) {
				const content = readFileSync(path, "utf8").trim();
				if (content.length > 0) {
					try {
						const parsed = JSON.parse(content) as T;
						if (!predicate || predicate(parsed)) {
							return parsed;
						}
						lastParsed = parsed;
					} catch (error) {
						lastError = error;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (lastParsed !== undefined) {
			throw new Error(
				`Timed out waiting for predicate to hold on ${path}; last value: ${JSON.stringify(
					lastParsed,
				)}`,
			);
		}
		const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
		throw new Error(`Timed out waiting for parseable JSON in ${path}${reason}`);
	}

	async function readJsonLinesEventually<T>(path: string): Promise<T[]> {
		const deadline = Date.now() + 1000;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (existsSync(path)) {
				const lines = readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean);
				if (lines.length > 0) {
					try {
						return lines.flatMap((line) => {
							const parsed = JSON.parse(line) as T | T[];
							return Array.isArray(parsed) ? parsed : [parsed];
						});
					} catch (error) {
						lastError = error;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
		throw new Error(
			`Timed out waiting for parseable JSONL in ${path}${reason}`,
		);
	}

	function overwriteSessionUnifiedContextManifest(
		sessionFile: string,
		manifest: unknown,
	): void {
		const entries = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const header = entries.find((entry) => entry.type === "session");
		if (!header) {
			throw new Error(`Missing session header in ${sessionFile}`);
		}
		header.unifiedContextManifest = manifest;
		writeFileSync(
			sessionFile,
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
	}

	function readSessionUnifiedContextManifest(sessionFile: string): unknown {
		const entries = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const header = entries.find((entry) => entry.type === "session");
		if (!header) {
			throw new Error(`Missing session header in ${sessionFile}`);
		}
		return header.unifiedContextManifest;
	}

	it("emits JSON events in json mode", async () => {
		await runMain(["--mode", "json", "hello"]);
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
		const code = await runMain(["models", "list"]);
		expect(code).toBe(0);
		expect(output.some((line) => /anthropic/i.test(line))).toBe(true);
	});

	it("hands native utility commands off before replay setup", async () => {
		const originalScenarioPath = process.env.MAESTRO_SCENARIO_PATH;
		process.env.MAESTRO_SCENARIO_PATH = join(
			tempAgentDir,
			"missing-scenario.json",
		);
		try {
			const code = await runMain(["modes", "list"]);
			expect(code).toBe(0);
			expect(launchNativeCli).toHaveBeenLastCalledWith(["modes", "list"]);
		} finally {
			if (originalScenarioPath === undefined) {
				delete process.env.MAESTRO_SCENARIO_PATH;
			} else {
				process.env.MAESTRO_SCENARIO_PATH = originalScenarioPath;
			}
		}
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

		await runMain(["init", "--json"]);

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

	it("delegates custom agents init targets to the native CLI", async () => {
		const target = join(tempAgentDir, "docs", "team guide", "AGENTS.md");
		mkdirSync(join(tempAgentDir, "docs", "team guide"), { recursive: true });
		writeFileSync(target, "# Existing Guidance\n");

		await runMain(["agents", "init", target]);

		expect(launchNativeCli).toHaveBeenLastCalledWith([
			"agents",
			"init",
			target,
		]);
		expect(readFileSync(target, "utf-8")).toBe("# Existing Guidance\n");
	});

	it("delegates forced agents init to the native CLI", async () => {
		const target = join(tempAgentDir, "docs", "AGENTS.md");
		mkdirSync(join(tempAgentDir, "docs"), { recursive: true });
		writeFileSync(target, "# Existing Guidance\n");

		await runMain(["agents", "init", target, "--force"]);

		expect(launchNativeCli).toHaveBeenLastCalledWith([
			"agents",
			"init",
			target,
			"--force",
		]);
	});

	it("exports a saved session as portable jsonl", async () => {
		const sessionId = await seedSession("hello");
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session?.id ?? sessionId).toBeTruthy();
		expect(session).toBeDefined();

		const outputPath = join(tempAgentDir, "portable-session.jsonl");
		output = [];

		await runMain(["export", session!.id, outputPath, "--format", "jsonl"]);

		expect(existsSync(outputPath)).toBe(true);
		expect(readFileSync(outputPath, "utf8")).toContain('"type":"session"');
		expect(output.join("\n")).toContain(`Exported session ${session!.id}`);
	});

	it.skip("exports a saved session as portable json with secret redaction (TS agent path removed; native maestro-tui owns this)", async () => {
		const sessionId = await seedSession(
			"apiKey=sk-ant-abcdefghijklmnopqrstuvwxyz123456",
		);
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session).toBeDefined();

		const outputPath = join(tempAgentDir, "portable-session.json");
		output = [];

		await runMain([
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
		const sessionId = await seedSession("hello");
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session?.id ?? sessionId).toBeTruthy();
		expect(session).toBeDefined();
		const sessionFile = sessionManager.getSessionFileById(session!.id);
		expect(sessionFile).toBeTruthy();

		const portablePath = join(tempAgentDir, "portable-import.jsonl");
		copyFileSync(sessionFile!, portablePath);
		output = [];

		await runMain(["import", portablePath]);

		const importedSessions = await new SessionManager(false).listSessions();
		expect(importedSessions.length).toBeGreaterThan(1);
		expect(output.join("\n")).toContain("Imported session");
	});

	it("imports a portable json session export", async () => {
		const sessionId = await seedSession("hello");
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session?.id ?? sessionId).toBeTruthy();
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

		await runMain(["import", portablePath]);

		const importedSessions = await new SessionManager(false).listSessions();
		expect(importedSessions.length).toBeGreaterThan(1);
		expect(output.join("\n")).toContain("Imported session");
	}, 60_000);

	it.skip("exports and imports portable json bundles with branched sessions (TS agent path removed; native maestro-tui owns this)", async () => {
		const sessionId = await seedSession("hello");
		const sessionManager = new SessionManager(false);
		const [session] = await sessionManager.listSessions();
		expect(session?.id ?? sessionId).toBeTruthy();
		expect(session).toBeDefined();
		const sessionFile = sessionManager.getSessionFileById(session!.id);
		expect(sessionFile).toBeTruthy();

		const branchManager = new SessionManager(false, sessionFile!);
		const branchLeafId = branchManager.getLeafId();
		expect(branchLeafId).toBeTruthy();
		branchManager.createBranchedSession(branchLeafId!);

		const portablePath = join(tempAgentDir, "portable-tree.json");
		output = [];
		await runMain(["export", session!.id, portablePath, "--format", "json"]);

		const exported = JSON.parse(readFileSync(portablePath, "utf8")) as {
			sessions: Array<{ sessionId: string }>;
		};
		expect(exported.sessions).toHaveLength(2);

		output = [];
		await runMain(["import", portablePath]);

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
			const startupEvents = await readJsonLinesEventually<{
				feature: string;
				action: string;
			}>(beaconFile);
			const startupEvent = startupEvents.find(
				(event) =>
					event.feature === "cli.startup" && event.action === "version",
			);
			const commandBuffer = await readJsonFileEventually<{
				counts: Record<string, number>;
			}>(
				bufferFile,
				(value) => typeof value.counts?.["cli.command.version"] === "number",
			);
			expect(startupEvent).toMatchObject({
				feature: "cli.startup",
				action: "version",
			});
			expect(commandBuffer.counts["cli.command.version"]).toBe(1);
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
		let resolveFetch!: (response: Response) => void;
		const fetchPromise = new Promise<Response>((resolve) => {
			resolveFetch = (response: Response) => {
				fetchCompleted = true;
				resolve(response);
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(() => fetchPromise),
		);
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		try {
			const versionExit = expect(main(["--version"])).rejects.toThrow("exit");
			await vi.waitFor(() => {
				expect(fetch).toHaveBeenCalled();
			});
			expect(fetchCompleted).toBe(false);
			resolveFetch(new Response(null, { status: 200 }));
			await versionExit;
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

	it("rejects unknown flags before they become support surfaces", async () => {
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
		expect(combined).toContain("Unknown option: --legacy-runtime");
		exitSpy.mockRestore();
	});

	async function runWebCommandAndAwaitStartupTelemetry(
		args: string[],
	): Promise<void> {
		const originalTelemetry = process.env.MAESTRO_TELEMETRY;
		const originalBeaconFile = process.env.MAESTRO_BEACON_FILE;
		const originalBufferFile =
			process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE;
		const beaconFile = join(tempAgentDir, "web-command-beacon.jsonl");
		const bufferFile = join(tempAgentDir, "web-command-buffer.json");
		process.env.MAESTRO_TELEMETRY = "1";
		process.env.MAESTRO_BEACON_FILE = beaconFile;
		process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = bufferFile;
		try {
			await runMain(args);
			await waitForFile(beaconFile);
			await readJsonFileEventually<{ counts: Record<string, number> }>(
				bufferFile,
			);
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
		}
	}

	it("seeds config-selected profiles before importing the web server", async () => {
		const startWebServer = vi.fn(async () => undefined);
		const migrate = vi.fn(async () => 0);
		const originalProfile = process.env.MAESTRO_PROFILE;
		let importedProfile: string | undefined;
		process.env.MAESTRO_PROFILE = "shell-profile";
		vi.doMock("../../src/web-server.js", () => {
			importedProfile = process.env.MAESTRO_PROFILE;
			return { startWebServer };
		});
		vi.doMock("../../src/db/migrate.js", () => ({ migrate }));

		try {
			await runWebCommandAndAwaitStartupTelemetry([
				"web",
				"--config",
				"profile=trusted-packages",
			]);
		} finally {
			if (originalProfile === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_PROFILE");
			} else {
				process.env.MAESTRO_PROFILE = originalProfile;
			}
			vi.doUnmock("../../src/web-server.js");
			vi.doUnmock("../../src/db/migrate.js");
		}

		expect(importedProfile).toBe("trusted-packages");
		expect(migrate).toHaveBeenCalledOnce();
		expect(startWebServer).toHaveBeenCalledWith(8080, {
			profileName: undefined,
			cliOverrides: { profile: "trusted-packages" },
			skipStartupMigration: true,
		});
	});

	it("passes explicit profiles into web server startup", async () => {
		const startWebServer = vi.fn(async () => undefined);
		const migrate = vi.fn(async () => 0);
		vi.doMock("../../src/web-server.js", () => ({ startWebServer }));
		vi.doMock("../../src/db/migrate.js", () => ({ migrate }));

		try {
			await runMain(["web", "--profile", "work"]);
		} finally {
			vi.doUnmock("../../src/web-server.js");
			vi.doUnmock("../../src/db/migrate.js");
		}

		expect(process.env.MAESTRO_PROFILE).toBe("work");
		expect(migrate).toHaveBeenCalledOnce();
		expect(startWebServer).toHaveBeenCalledWith(8080, {
			profileName: "work",
			cliOverrides: {},
			skipStartupMigration: true,
		});
	});

	it("passes config overrides into web server startup", async () => {
		const startWebServer = vi.fn(async () => undefined);
		const migrate = vi.fn(async () => 0);
		const projectPath = join(tempAgentDir, "project.v1");
		vi.doMock("../../src/web-server.js", () => ({ startWebServer }));
		vi.doMock("../../src/db/migrate.js", () => ({ migrate }));

		try {
			await runMain([
				"web",
				"--config",
				`projects.${JSON.stringify(projectPath)}.trust_level="trusted"`,
			]);
		} finally {
			vi.doUnmock("../../src/web-server.js");
			vi.doUnmock("../../src/db/migrate.js");
		}

		expect(startWebServer).toHaveBeenCalledWith(8080, {
			profileName: undefined,
			cliOverrides: {
				projects: {
					[projectPath]: { trust_level: "trusted" },
				},
			},
			skipStartupMigration: true,
		});
	});

	it.skip("prints providers summary for filter (TS agent path removed; native maestro-tui owns this)", async () => {
		const originalTelemetry = process.env.MAESTRO_TELEMETRY;
		const originalBeaconFile = process.env.MAESTRO_BEACON_FILE;
		const originalBufferFile =
			process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE;
		const originalLegacyRuntime = process.env.MAESTRO_INTERNAL_HEADLESS_RUNTIME;
		const beaconFile = join(tempAgentDir, "models-beacon.jsonl");
		const bufferFile = join(tempAgentDir, "models-command-buffer.json");
		process.env.MAESTRO_TELEMETRY = "1";
		process.env.MAESTRO_BEACON_FILE = beaconFile;
		process.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE = bufferFile;
		process.env.MAESTRO_INTERNAL_HEADLESS_RUNTIME = "legacy";
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		try {
			await runMain(["models", "providers", "--provider", "openrouter"]);
			expect(exitCodes).toEqual([0]);
			expect(output.join("\n")).toContain("openrouter");
			const commandBuffer = await readJsonFileEventually<{
				counts: Record<string, number>;
			}>(
				bufferFile,
				(value) =>
					typeof value.counts?.["cli.command.models.providers"] === "number",
			);
			const startupEvents = await readJsonLinesEventually<{
				feature: string;
				action: string;
				parameters?: { metadata?: Record<string, unknown> };
			}>(beaconFile);
			const startupEvent = startupEvents.find(
				(event) =>
					event.feature === "cli.startup" &&
					event.action === "models.providers",
			);
			expect(startupEvent).toMatchObject({
				feature: "cli.startup",
				action: "models.providers",
				parameters: {
					metadata: {
						legacyRuntimeRequested: false,
					},
				},
			});
			expect(commandBuffer.counts["cli.command.models.providers"]).toBe(1);
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
			if (originalLegacyRuntime === undefined) {
				Reflect.deleteProperty(
					process.env,
					"MAESTRO_INTERNAL_HEADLESS_RUNTIME",
				);
			} else {
				process.env.MAESTRO_INTERNAL_HEADLESS_RUNTIME = originalLegacyRuntime;
			}
			exitSpy.mockRestore();
		}
	});

	it.skip("does not wait for endpoint startup telemetry before subcommands (TS agent path removed; native maestro-tui owns this)", async () => {
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
		let resolveFetch: ((response: Response) => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						resolveFetch = resolve;
					}),
			),
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
			resolveFetch?.(new Response(null, { status: 204 }));
			await new Promise((resolve) => setImmediate(resolve));
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

	it.skip("prints maestro models help for unknown models subcommand (TS agent path removed; native maestro-tui owns this)", async () => {
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
		await runMain([
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
			"exec",
			"Summarize release notes",
		]);
		const combined = output.join("\n");
		expect(combined).toContain("Echo: Summarize release notes");
	});

	it.skip("applies SessionStart hook context before the first CLI prompt (TS agent path removed; native maestro-tui owns this)", async () => {
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

		await runMain(["hello"]);
		const combined = output.join("\n");
		expect(combined).toContain(
			"SessionStart hook system guidance:\nHook says: keep changes scoped.",
		);
		expect(combined).toContain("Hook says: this repo uses Nx.");
		expect(combined).toContain("Echo: hello");
	});

	it.skip("marks SessionStart hooks as resume during --continue runs (TS agent path removed; native maestro-tui owns this)", async () => {
		let sessionStartInput: Record<string, unknown> | undefined;

		registerHook("SessionStart", {
			type: "callback",
			callback: async (input) => {
				sessionStartInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await runMain(["--continue", "hello"]);

		expect(sessionStartInput).toMatchObject({
			hook_event_name: "SessionStart",
			source: "resume",
		});
	});

	it.skip("runs SessionEnd hooks after a CLI prompt completes (TS agent path removed; native maestro-tui owns this)", async () => {
		let sessionEndInput: Record<string, unknown> | undefined;
		const [{ registerHook: registerCurrentHook }, { main: currentMain }] =
			await Promise.all([
				import("../../src/hooks/index.js"),
				import("../../src/main.js"),
			]);

		registerCurrentHook("SessionEnd", {
			type: "callback",
			callback: async (input) => {
				sessionEndInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await currentMain(["hello"]);

		expect(sessionEndInput).toMatchObject({
			hook_event_name: "SessionEnd",
			reason: "complete",
			turn_count: 1,
		});
		expect(sessionEndInput?.duration_ms).toEqual(expect.any(Number));
		expect(Number(sessionEndInput?.duration_ms)).toBeGreaterThanOrEqual(0);
	});

	it.skip("runs SessionEnd hooks after maestro exec completes (TS agent path removed; native maestro-tui owns this)", async () => {
		let sessionEndInput: Record<string, unknown> | undefined;
		const [{ registerHook: registerCurrentHook }, { main: currentMain }] =
			await Promise.all([
				import("../../src/hooks/index.js"),
				import("../../src/main.js"),
			]);

		registerCurrentHook("SessionEnd", {
			type: "callback",
			callback: async (input) => {
				sessionEndInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await currentMain(["exec", "Summarize release notes"]);

		expect(sessionEndInput).toMatchObject({
			hook_event_name: "SessionEnd",
			reason: "complete",
			turn_count: 1,
		});
		expect(sessionEndInput?.duration_ms).toEqual(expect.any(Number));
		expect(Number(sessionEndInput?.duration_ms)).toBeGreaterThanOrEqual(0);
	}, 60_000);

	it("streams only JSON events to stdout in composer exec json mode", async () => {
		const originalWrite = process.stdout.write;
		let streamed = "";
		process.stdout.write = ((chunk: unknown) => {
			streamed += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runMain(["exec", "--tools", "read", "Plan work", "--json"]);
		} finally {
			process.stdout.write = originalWrite;
		}
		expect(streamed).toContain('"type":"thread"');
		const lines = streamed.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);
		expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
	});

	it.skip("emits one thread start for composer exec json mode (TS agent path removed; native maestro-tui owns this)", async () => {
		await runMain([
			"exec",
			"--tools",
			"read",
			"--sandbox",
			"local",
			"Plan work",
			"--json",
		]);
		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		expect(threadStarts).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "thread",
			phase: "start",
			cwd: process.cwd(),
			sandbox: "local",
		});
	});

	it.skip("emits fresh exec json thread start before fresh session persistence construction (TS agent path removed; native maestro-tui owns this)", async () => {
		vi.resetModules();
		let threadStartBeforeConstructor: Record<string, unknown> | undefined;
		let constructorSessionId: string | undefined;
		vi.doMock(
			"../../src/session/fresh-exec-session-manager.js",
			async (importOriginal) => {
				const actual =
					await importOriginal<
						typeof import("../../src/session/fresh-exec-session-manager.js")
					>();
				return {
					...actual,
					FreshExecSessionManager: class extends actual.FreshExecSessionManager {
						constructor(
							options?: ConstructorParameters<
								typeof actual.FreshExecSessionManager
							>[0],
						) {
							const events = output
								.flatMap((chunk) => chunk.trim().split("\n"))
								.filter((line) => line.startsWith("{"))
								.map((line) => JSON.parse(line) as Record<string, unknown>);
							threadStartBeforeConstructor = events.find(
								(event) => event.type === "thread" && event.phase === "start",
							);
							constructorSessionId = options?.sessionId;
							super(options);
						}
					},
				};
			},
		);

		try {
			const { main: currentMain } = await import("../../src/main.js");
			await currentMain([
				"exec",
				"--tools",
				"read",
				"--sandbox",
				"local",
				"Plan work",
				"--json",
			]);
		} finally {
			vi.doUnmock("../../src/session/fresh-exec-session-manager.js");
			vi.resetModules();
		}

		expect(threadStartBeforeConstructor).toMatchObject({
			type: "thread",
			phase: "start",
			cwd: process.cwd(),
			sandbox: "local",
		});
		expect(constructorSessionId).toBe(threadStartBeforeConstructor?.threadId);

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		const threadEnds = events.filter(
			(event) => event.type === "thread" && event.phase === "end",
		);
		expect(threadStarts).toHaveLength(1);
		expect(threadEnds.at(-1)).toMatchObject({
			type: "thread",
			phase: "end",
			threadId: constructorSessionId,
			sessionId: constructorSessionId,
			status: "ok",
		});
	});

	it.skip("closes early exec json thread start when startup fails after emission (TS agent path removed; native maestro-tui owns this)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${String(code ?? 0)}`);
		});

		await expect(
			main(["exec", "--tools", "not-a-tool", "Plan work", "--json"]),
		).rejects.toThrow("exit:1");

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		const threadEnds = events.filter(
			(event) => event.type === "thread" && event.phase === "end",
		);
		const doneEvents = events.filter((event) => event.type === "done");
		const errorEvents = events.filter((event) => event.type === "error");

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(threadStarts).toHaveLength(1);
		expect(errorEvents.at(-1)).toMatchObject({
			type: "error",
		});
		expect(threadEnds.at(-1)).toMatchObject({
			type: "thread",
			phase: "end",
			threadId: threadStarts[0]?.threadId,
			sessionId: threadStarts[0]?.sessionId,
			status: "error",
		});
		expect(doneEvents.at(-1)).toMatchObject({
			type: "done",
			status: "error",
			sessionId: threadStarts[0]?.sessionId,
		});
	});

	it.skip("closes early exec json thread when fresh session construction fails (TS agent path removed; native maestro-tui owns this)", async () => {
		const blockedSessionRoot = join(tempAgentDir, "sessions-file");
		writeFileSync(blockedSessionRoot, "not a directory");
		process.env.MAESTRO_SESSION_DIR = blockedSessionRoot;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${String(code ?? 0)}`);
		});

		await expect(
			main(["exec", "--tools", "read", "Plan work", "--json"]),
		).rejects.toThrow("exit:1");

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		const threadEnds = events.filter(
			(event) => event.type === "thread" && event.phase === "end",
		);
		const doneEvents = events.filter((event) => event.type === "done");
		const errorEvents = events.filter((event) => event.type === "error");

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(threadStarts).toHaveLength(1);
		expect(errorEvents.at(-1)).toMatchObject({
			type: "error",
		});
		expect(threadEnds.at(-1)).toMatchObject({
			type: "thread",
			phase: "end",
			threadId: threadStarts[0]?.threadId,
			sessionId: threadStarts[0]?.sessionId,
			status: "error",
		});
		expect(doneEvents.at(-1)).toMatchObject({
			type: "done",
			status: "error",
			sessionId: threadStarts[0]?.sessionId,
		});
	});

	it.skip("closes early exec json thread when late startup setup fails (TS agent path removed; native maestro-tui owns this)", async () => {
		vi.resetModules();
		vi.doMock("../../src/bootstrap/session-restoration-setup.js", () => ({
			restoreSessionState: vi
				.fn()
				.mockRejectedValue(new Error("late setup boom")),
		}));
		try {
			const { main: currentMain } = await import("../../src/main.js");
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
				throw new Error(`exit:${String(code ?? 0)}`);
			});

			await expect(
				currentMain([
					"exec",
					"--tools",
					"read",
					"--models",
					"gpt",
					"Plan work",
					"--json",
				]),
			).rejects.toThrow("exit:1");

			const events = output
				.flatMap((chunk) => chunk.trim().split("\n"))
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const threadStarts = events.filter(
				(event) => event.type === "thread" && event.phase === "start",
			);
			const threadEnds = events.filter(
				(event) => event.type === "thread" && event.phase === "end",
			);
			const doneEvents = events.filter((event) => event.type === "done");
			const errorEvents = events.filter((event) => event.type === "error");

			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(threadStarts).toHaveLength(1);
			expect(errorEvents.at(-1)).toMatchObject({
				type: "error",
				message: "late setup boom",
			});
			expect(threadEnds.at(-1)).toMatchObject({
				type: "thread",
				phase: "end",
				threadId: threadStarts[0]?.threadId,
				sessionId: threadStarts[0]?.sessionId,
				status: "error",
			});
			expect(doneEvents.at(-1)).toMatchObject({
				type: "done",
				status: "error",
				sessionId: threadStarts[0]?.sessionId,
			});
		} finally {
			vi.doUnmock("../../src/bootstrap/session-restoration-setup.js");
		}
	});

	it.skip("does not start an exec json thread before no-prompt validation (TS agent path removed; native maestro-tui owns this)", async () => {
		await expect(main(["exec", "--json"])).rejects.toThrow(
			/maestro exec requires at least one prompt/,
		);

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(
			events.filter(
				(event) => event.type === "thread" && event.phase === "start",
			),
		).toHaveLength(0);
	});

	it.skip("emits terminal exec json events for blank prompts (TS agent path removed; native maestro-tui owns this)", async () => {
		await expect(main(["exec", "--json", "   "])).rejects.toThrow(
			/maestro exec requires at least one non-empty prompt/,
		);

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		const threadEnds = events.filter(
			(event) => event.type === "thread" && event.phase === "end",
		);
		const doneEvents = events.filter((event) => event.type === "done");
		const errorEvents = events.filter((event) => event.type === "error");

		expect(threadStarts).toHaveLength(1);
		expect(errorEvents.at(-1)).toMatchObject({
			type: "error",
			message: "maestro exec requires at least one non-empty prompt",
		});
		expect(threadEnds.at(-1)).toMatchObject({
			type: "thread",
			phase: "end",
			threadId: threadStarts[0]?.threadId,
			sessionId: threadStarts[0]?.sessionId,
			status: "error",
		});
		expect(doneEvents.at(-1)).toMatchObject({
			type: "done",
			status: "error",
			sessionId: threadStarts[0]?.sessionId,
		});
	});

	it.skip.each([
		["--headless exec --json", ["--headless", "exec", "--json", "Plan work"]],
		["--headless exec --json without prompt", ["--headless", "exec", "--json"]],
		[
			"exec --mode headless --stream-json",
			["exec", "--mode", "headless", "--stream-json", "Plan work"],
		],
		[
			"exec --mode headless --stream-json without prompt",
			["exec", "--mode", "headless", "--stream-json"],
		],
	])(
		"does not emit exec JSON thread events before headless protocol messages for %s (native headless)",
		async (_label, args) => {
			await runMain(args);
		},
	);

	it.skip("uses the resumed session id for exec json thread start (TS agent path removed; native maestro-tui owns this)", async () => {
		await runMain(["exec", "Initial run"]);
		const [session] = await new SessionManager(false).listSessions();
		expect(session).toBeDefined();
		const sessionFile = new SessionManager(false).getSessionFileById(
			session!.id,
		);
		expect(sessionFile).toBeTruthy();
		const originalManifest = {
			protocolVersion: "test.resume.manifest",
			version: 1,
			cwd: "/original/resume",
			entries: [],
			diagnostics: [],
		};
		overwriteSessionUnifiedContextManifest(sessionFile!, originalManifest);
		output = [];

		await runMain([
			"exec",
			"--resume",
			session!.id,
			"--sandbox",
			"local",
			"--json",
			"Follow up run",
		]);

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		const threadEnds = events.filter(
			(event) => event.type === "thread" && event.phase === "end",
		);
		expect(threadStarts).toHaveLength(1);
		expect(threadStarts[0]).toMatchObject({
			threadId: session!.id,
			sessionId: session!.id,
			cwd: process.cwd(),
			sandbox: "local",
		});
		expect(threadEnds.at(-1)).toMatchObject({
			threadId: session!.id,
			sessionId: session!.id,
		});
		expect(readSessionUnifiedContextManifest(sessionFile!)).toEqual(
			originalManifest,
		);
	});

	it.skip("uses the last exec session id for exec json thread start (TS agent path removed; native maestro-tui owns this)", async () => {
		await runMain(["exec", "Initial run"]);
		const [session] = await new SessionManager(false).listSessions();
		expect(session).toBeDefined();
		const sessionFile = new SessionManager(false).getSessionFileById(
			session!.id,
		);
		expect(sessionFile).toBeTruthy();
		const originalManifest = {
			protocolVersion: "test.last.manifest",
			version: 1,
			cwd: "/original/last",
			entries: [],
			diagnostics: [],
		};
		overwriteSessionUnifiedContextManifest(sessionFile!, originalManifest);
		output = [];

		await runMain([
			"exec",
			"--last",
			"--sandbox",
			"local",
			"--json",
			"Follow up run",
		]);

		const events = output
			.flatMap((chunk) => chunk.trim().split("\n"))
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const threadStarts = events.filter(
			(event) => event.type === "thread" && event.phase === "start",
		);
		const threadEnds = events.filter(
			(event) => event.type === "thread" && event.phase === "end",
		);
		expect(threadStarts).toHaveLength(1);
		expect(threadStarts[0]).toMatchObject({
			threadId: session!.id,
			sessionId: session!.id,
			cwd: process.cwd(),
			sandbox: "local",
		});
		expect(threadEnds.at(-1)).toMatchObject({
			threadId: session!.id,
			sessionId: session!.id,
		});
		expect(readSessionUnifiedContextManifest(sessionFile!)).toEqual(
			originalManifest,
		);
	});

	it.skip("backfills exec json manifest before final events with pre-dispatch MCP config snapshot (TS agent path removed; native maestro-tui owns this)", async () => {
		const originalCwd = process.cwd();
		const projectDir = mkdtempSync(join(tmpdir(), "composer-mcp-project-"));
		const projectMcpDir = join(projectDir, ".maestro");
		const projectMcpPath = join(projectMcpDir, "mcp.json");
		let capturedSessionPath: string | null = null;
		let manifestBeforeFinalEvent:
			| {
					entries?: Array<{ id: string; kind: string }>;
			  }
			| undefined;
		mkdirSync(projectMcpDir, { recursive: true });
		writeFileSync(
			projectMcpPath,
			JSON.stringify({
				mcpServers: {
					before_run: {
						command: "node",
						args: ["before.js"],
					},
				},
			}),
		);

		vi.resetModules();
		vi.doMock("../../src/cli/commands/exec.js", () => ({
			runExecCommand: async (options: {
				agent: { state: MockAgentState };
				sessionManager: SessionManager;
				beforeFinalJsonlEvents?: () => Promise<void> | void;
			}) => {
				options.sessionManager.startSession(options.agent.state, {
					subject: "Mutate MCP",
				});
				options.sessionManager.saveSessionSummary(
					"maestro exec session: Mutate MCP",
				);
				capturedSessionPath = options.sessionManager.getSessionFile();
				writeFileSync(
					projectMcpPath,
					JSON.stringify({
						mcpServers: {
							after_run: {
								command: "node",
								args: ["after.js"],
							},
						},
					}),
				);
				await options.beforeFinalJsonlEvents?.();
				manifestBeforeFinalEvent = readSessionUnifiedContextManifest(
					capturedSessionPath!,
				) as typeof manifestBeforeFinalEvent;
				process.stdout.write(`${JSON.stringify({ type: "done" })}\n`);
			},
		}));

		try {
			process.chdir(projectDir);
			const { main: currentMain } = await import("../../src/main.js");
			await currentMain(["exec", "--tools", "read", "Mutate MCP", "--json"]);
		} finally {
			process.chdir(originalCwd);
			vi.doUnmock("../../src/cli/commands/exec.js");
			vi.resetModules();
			rmSync(projectDir, { recursive: true, force: true });
		}

		expect(capturedSessionPath).toBeDefined();
		const sessionHeader = JSON.parse(
			readFileSync(capturedSessionPath!, "utf8").split("\n")[0]!,
		) as {
			unifiedContextManifest?: {
				entries?: Array<{ id: string; kind: string }>;
			};
		};
		const mcpEntryIds =
			sessionHeader.unifiedContextManifest?.entries
				?.filter((entry) => entry.kind === "mcp_server")
				.map((entry) => entry.id)
				.sort() ?? [];
		const mcpEntryIdsBeforeFinalEvent =
			manifestBeforeFinalEvent?.entries
				?.filter((entry) => entry.kind === "mcp_server")
				.map((entry) => entry.id)
				.sort() ?? [];

		expect(mcpEntryIds).toContain("mcp_server:before_run");
		expect(mcpEntryIds).not.toContain("mcp_server:after_run");
		expect(mcpEntryIdsBeforeFinalEvent).toEqual(mcpEntryIds);
		expect(output.map((chunk) => chunk.trim()).filter(Boolean)).toContain(
			JSON.stringify({ type: "done" }),
		);
	});

	it("validates schema in composer exec", async () => {
		await runMain([
			"exec",
			'JSON:{"result":"ok"}',
			"--output-schema",
			'{"type":"object","properties":{"result":{"const":"ok"}},"required":["result"]}',
		]);
	});

	it.skip("fails schema validation in composer exec (TS agent path removed; native maestro-tui owns this)", async () => {
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
		await runMain(["exec", "Initial run"]);
		output = [];
		await runMain(["exec", "--last", "Follow up run"]);
		expect(output.join("\n")).toContain("Echo: Follow up run");
	}, 90_000);

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

	it("rejects equals-form ChatGPT auth flags with migration guidance", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(
			main(["--provider", "openai", "--model", "gpt-test", "--auth=chatgpt"]),
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

	it("rejects bare Codex subscription token flags with migration guidance", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["--codex-api-key"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain(
			"Legacy Codex/ChatGPT auth flags are no longer supported",
		);
		exitSpy.mockRestore();
	});

	it("keeps early headless auth flag errors schema-compatible", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["--headless", "--codex-api-key"])).rejects.toThrow(
			"exit",
		);
		expect(exitCodes).toEqual([1]);

		const payload = JSON.parse(output.join(""));
		expect(Value.Check(HeadlessErrorMessageSchema, payload)).toBe(true);
		expect(payload).toMatchObject({
			type: "error",
			fatal: true,
			error_type: "fatal",
		});
		expect(payload.message).toContain(
			"Legacy Codex/ChatGPT auth flags are no longer supported",
		);
		expect(payload).not.toHaveProperty("stack");
		exitSpy.mockRestore();
	});

	it("does not consume following options as deprecated auth flag values", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["--codex-api-key", "--help"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([0]);
		expect(output.join("\n")).toContain("Maestro");
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

	it("rejects legacy auth flags before hosted-runner early exit", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(
			main(["hosted-runner", "--codex-api-key", "codex-token"]),
		).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain(
			"Legacy Codex/ChatGPT auth flags are no longer supported",
		);
		exitSpy.mockRestore();
	});

	it("preserves the native hosted-runner exit status through the full runtime", async () => {
		vi.mocked(launchNativeCli).mockResolvedValueOnce(143);

		expect(await runMain(["hosted-runner", "--port", "9090"])).toBe(143);
		expect(launchNativeCli).toHaveBeenLastCalledWith(
			["hosted-runner", "--port", "9090"],
			{ forwardSignals: true },
		);
	});

	it("rejects legacy auth flags before web early exit", async () => {
		const exitCodes: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCodes.push(Number(code ?? 0));
			throw new Error("exit");
		});
		await expect(main(["web", "--auth", "chatgpt"])).rejects.toThrow("exit");
		expect(exitCodes).toEqual([1]);
		expect(output.join("\n")).toContain(
			"Legacy Codex/ChatGPT auth flags are no longer supported",
		);
		exitSpy.mockRestore();
	});

	it("rejects retired Claude auth mode", async () => {
		process.env.CLAUDE_CODE_TOKEN = "claude-token";
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
		expect(output.join("\n")).toContain(
			"Anthropic OAuth auth mode is no longer supported",
		);
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
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
});
