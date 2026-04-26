import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import {
	clearPlanModeState,
	enterPlanMode,
} from "../../src/agent/plan-mode.js";
import { SESSION_START_INITIAL_USER_METADATA_KIND } from "../../src/agent/session-start-metadata.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	Model,
	StopReason,
	TextContent,
} from "../../src/agent/types.js";
import {
	applyPreMessageHooks,
	applySessionStartHooks,
	applyUserPromptSubmitHooks,
	runUserPromptWithRecovery,
} from "../../src/agent/user-prompt-runtime.js";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";
import type { PostMessageHookInput } from "../../src/hooks/types.js";
import { addMemory } from "../../src/memory/index.js";

const mockModel: Model<"openai-completions"> = {
	id: "mock",
	name: "Mock",
	provider: "mock",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 2048,
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock",
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAssistantMessageWithUsage(
	text: string,
	options: {
		inputTokens: number;
		outputTokens: number;
		stopReason?: StopReason;
	},
): AssistantMessage {
	const assistant = createAssistantMessage(text);
	return {
		...assistant,
		usage: {
			...assistant.usage,
			input: options.inputTokens,
			output: options.outputTokens,
		},
		stopReason: options.stopReason ?? "stop",
	};
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) {
		return "";
	}

	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: {};
}

function buildConversation(turns: number): AppMessage[] {
	const messages: AppMessage[] = [];
	for (let i = 0; i < turns; i += 1) {
		messages.push({
			role: "user",
			content: `message ${i}`,
			timestamp: Date.now(),
		});
		messages.push(
			createAssistantMessageWithUsage(`response ${i}`, {
				inputTokens: 2000 + i * 100,
				outputTokens: 200,
				stopReason: "stop",
			}),
		);
	}
	return messages;
}

describe("user prompt runtime", () => {
	afterEach(() => {
		clearRegisteredHooks();
	});

	it("queues UserPromptSubmit hook context for the next run", async () => {
		const queueNextRunPromptOnlyMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();
		const queueNextRunHistoryMessage = vi.fn();

		registerHook("UserPromptSubmit", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "Remember the migration checklist.",
				},
				systemMessage: "Prefer minimal diffs.",
			}),
		});

		await applyUserPromptSubmitHooks({
			agent: {
				queueNextRunPromptOnlyMessage,
				queueNextRunSystemPromptAddition,
				queueNextRunHistoryMessage,
			} as unknown as Agent,
			sessionManager: {
				getSessionId: () => "session-user-prompt",
			} as never,
			cwd: "/tmp/user-prompt-hooks",
			prompt: "Update the config loader",
			attachmentCount: 2,
		});

		expect(queueNextRunSystemPromptAddition).toHaveBeenCalledWith(
			"UserPromptSubmit hook system guidance:\nPrefer minimal diffs.",
		);
		expect(queueNextRunHistoryMessage).toHaveBeenCalledWith({
			role: "hookMessage",
			customType: "UserPromptSubmit",
			content: "Remember the migration checklist.",
			display: true,
			timestamp: expect.any(Number),
		});
		expect(queueNextRunPromptOnlyMessage).not.toHaveBeenCalled();
	});

	it("clears queued prompt hook additions when execution fails before prompt start", async () => {
		const capturedRuns: Array<{
			messages: Message[];
			systemPrompt: string;
		}> = [];

		registerHook("UserPromptSubmit", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "Leaked user prompt hook context",
				},
				systemMessage: "Leaked user prompt system guidance",
			}),
		});
		registerHook("PreMessage", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "PreMessage",
					additionalContext: "Leaked pre-message hook context",
				},
			}),
		});

		class CaptureTransport implements AgentTransport {
			async *run(
				messages: Message[],
				_userMessage: Message,
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				capturedRuns.push({
					messages: structuredClone(messages),
					systemPrompt: config.systemPrompt,
				});
				const assistant = createAssistantMessage("Recovered cleanly");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new CaptureTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		const sessionManager = {
			getSessionId: () => "session-hook-leak-cleanup",
		};

		await expect(
			runUserPromptWithRecovery({
				agent,
				sessionManager: sessionManager as never,
				cwd: "/tmp/hook-leak-cleanup",
				prompt: "first",
				execute: async () => {
					throw new Error("Circuit breaker open");
				},
			}),
		).rejects.toThrow("Circuit breaker open");

		clearRegisteredHooks();

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/hook-leak-cleanup",
			prompt: "second",
			execute: () => agent.prompt("second"),
		});

		expect(capturedRuns).toHaveLength(1);
		expect(capturedRuns[0]?.systemPrompt).toBe("Base system prompt");
		expect(JSON.stringify(capturedRuns[0]?.messages ?? [])).not.toContain(
			"Leaked user prompt hook context",
		);
		expect(JSON.stringify(capturedRuns[0]?.messages ?? [])).not.toContain(
			"Leaked pre-message hook context",
		);
	});

	it("queues SessionStart hook context for the first run", async () => {
		const queueNextRunPromptOnlyMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();
		const queueNextRunHistoryMessage = vi.fn();

		registerHook("SessionStart", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: "This workspace uses generated API clients.",
					initialUserMessage: "Read the project conventions first.",
				},
				systemMessage: "Prefer workspace-local scripts over global installs.",
			}),
		});

		await applySessionStartHooks({
			agent: {
				queueNextRunPromptOnlyMessage,
				queueNextRunSystemPromptAddition,
				queueNextRunHistoryMessage,
			} as unknown as Agent,
			sessionManager: {
				getSessionId: () => "session-start",
			} as never,
			cwd: "/tmp/session-start-hooks",
			source: "cli",
		});

		expect(queueNextRunSystemPromptAddition).toHaveBeenCalledWith(
			"SessionStart hook system guidance:\nPrefer workspace-local scripts over global installs.",
		);
		expect(queueNextRunHistoryMessage).toHaveBeenNthCalledWith(1, {
			role: "hookMessage",
			customType: "SessionStart",
			content: "This workspace uses generated API clients.",
			display: true,
			timestamp: expect.any(Number),
		});
		expect(queueNextRunHistoryMessage).toHaveBeenNthCalledWith(2, {
			role: "user",
			content: "Read the project conventions first.",
			metadata: {
				kind: SESSION_START_INITIAL_USER_METADATA_KIND,
				source: "cli",
			},
			timestamp: expect.any(Number),
		});
		expect(queueNextRunPromptOnlyMessage).not.toHaveBeenCalled();
	});

	it("injects automatic memory recall into the next run system prompt", async () => {
		const originalMaestroHome = process.env.MAESTRO_HOME;
		const memoryRoot = mkdtempSync(join(tmpdir(), "maestro-memory-runtime-"));
		process.env.MAESTRO_HOME = join(memoryRoot, ".maestro-home");

		try {
			addMemory(
				"api-design",
				"Use cursor pagination for REST list endpoints and preserve retry backoff logic.",
			);

			const capturedRuns: Array<{
				systemPrompt: string;
			}> = [];

			class CaptureTransport implements AgentTransport {
				async *run(
					_messages: Message[],
					_userMessage: Message,
					config: AgentRunConfig,
				): AsyncGenerator<AgentEvent, void, unknown> {
					capturedRuns.push({
						systemPrompt: config.systemPrompt,
					});
					const assistant = createAssistantMessage("Memory recall applied");
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
				}
			}

			const agent = new Agent({
				transport: new CaptureTransport(),
				initialState: {
					model: mockModel,
					tools: [],
					systemPrompt: "Base system prompt",
				},
			});

			await runUserPromptWithRecovery({
				agent,
				sessionManager: {
					getSessionId: () => "session-memory-recall",
				} as never,
				cwd: "/tmp/memory-recall",
				prompt: "Update the REST list endpoints to use cursor pagination",
				execute: () =>
					agent.prompt(
						"Update the REST list endpoints to use cursor pagination",
					),
			});

			expect(capturedRuns).toHaveLength(1);
			expect(capturedRuns[0]?.systemPrompt).toContain(
				"Automatic memory recall:",
			);
			expect(capturedRuns[0]?.systemPrompt).toContain("api-design");
			expect(capturedRuns[0]?.systemPrompt).toContain("cursor pagination");
		} finally {
			if (originalMaestroHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = originalMaestroHome;
			}
			rmSync(memoryRoot, { recursive: true, force: true });
		}
	});

	it("injects optional Cerebro facts context into the next run system prompt", async () => {
		vi.stubEnv("MAESTRO_CEREBRO_URL", "https://cerebro.test/");
		vi.stubEnv("MAESTRO_CEREBRO_TOKEN", "cerebro-token");
		vi.stubEnv("MAESTRO_CEREBRO_WORKSPACE_ID", "workspace_1");

		const requests: Array<{
			url: string;
			headers: Record<string, string>;
			body: Record<string, unknown>;
		}> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = headersToRecord(init?.headers);
				const body = parseRequestBody(init?.body);
				requests.push({ url, headers, body });

				if (url.endsWith("/cerebro.v1.CerebroService/Search")) {
					expect(headers).toMatchObject({
						authorization: "Bearer cerebro-token",
						"content-type": "application/json",
					});
					expect(body).toMatchObject({
						workspaceId: "workspace_1",
						query: "triage pipeline regressions",
						limit: 5,
						includeMap: true,
					});
					return Response.json({
						things: [
							{
								id: "thing_pipeline",
								name: "Pipeline",
								kind: "THING_KIND_SERVICE",
							},
						],
						evidence: [{ id: "evidence_search", uri: "https://repo.test" }],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/GetThing")) {
					expect(body).toMatchObject({
						workspaceId: "workspace_1",
						thingId: "thing_pipeline",
					});
					return Response.json({
						thing: {
							id: "thing_pipeline",
							name: "Pipeline",
							kind: "THING_KIND_SERVICE",
						},
						facts: [
							{
								id: "fact_pipeline_owner",
								subjectThingId: "thing_pipeline",
								statement: "Pipeline is owned by Platform",
							},
						],
						recentEvents: [
							{
								id: "event_pipeline_deploy",
								summary: "Pipeline deployed",
							},
						],
						evidence: [{ id: "evidence_owner", uri: "https://owner.test" }],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/ListChanges")) {
					expect(body).toMatchObject({
						workspaceId: "workspace_1",
						thingIds: ["thing_pipeline"],
						limit: 10,
					});
					return Response.json({
						changes: [
							{
								id: "change_pipeline_recent",
								thingId: "thing_pipeline",
								summary: "Pipeline ownership changed",
							},
						],
					});
				}

				return new Response("unexpected endpoint", { status: 404 });
			}),
		);

		try {
			const capturedRuns: Array<{ systemPrompt: string }> = [];

			class CaptureTransport implements AgentTransport {
				async *run(
					_messages: Message[],
					_userMessage: Message,
					config: AgentRunConfig,
				): AsyncGenerator<AgentEvent, void, unknown> {
					capturedRuns.push({ systemPrompt: config.systemPrompt });
					const assistant = createAssistantMessage("Cerebro facts applied");
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
				}
			}

			const agent = new Agent({
				transport: new CaptureTransport(),
				initialState: {
					model: mockModel,
					tools: [],
					systemPrompt: "Base system prompt",
				},
			});

			await runUserPromptWithRecovery({
				agent,
				sessionManager: {
					getSessionId: () => "session-cerebro-facts",
				} as never,
				cwd: "/tmp/cerebro-facts",
				prompt: "triage pipeline regressions",
				execute: () => agent.prompt("triage pipeline regressions"),
			});

			expect(requests.map((request) => request.url)).toEqual([
				"https://cerebro.test/cerebro.v1.CerebroService/Search",
				"https://cerebro.test/cerebro.v1.CerebroService/GetThing",
				"https://cerebro.test/cerebro.v1.CerebroService/ListChanges",
			]);
			expect(capturedRuns).toHaveLength(1);
			expect(capturedRuns[0]?.systemPrompt).toContain(
				"# Cerebro Facts Context",
			);
			expect(capturedRuns[0]?.systemPrompt).toContain(
				"triage pipeline regressions",
			);
			expect(capturedRuns[0]?.systemPrompt).toContain("Pipeline");
			expect(capturedRuns[0]?.systemPrompt).toContain(
				"Pipeline is owned by Platform",
			);
			expect(capturedRuns[0]?.systemPrompt).toContain("change_pipeline_recent");
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it("propagates cancellation while loading optional Cerebro facts context", async () => {
		vi.stubEnv("MAESTRO_CEREBRO_URL", "https://cerebro.test/");
		vi.stubEnv("MAESTRO_CEREBRO_WORKSPACE_ID", "workspace_1");

		const abortError = new Error("Operation aborted");
		abortError.name = "AbortError";
		const abortController = new AbortController();
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				abortController.abort(abortError);
				expect(init?.signal?.aborted).toBe(true);
				throw abortError;
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		class NeverRunTransport implements AgentTransport {
			async *run(): AsyncGenerator<AgentEvent, void, unknown> {
				yield {
					type: "message_start",
					message: createAssistantMessage("never"),
				};
				throw new Error("transport should not run after cancellation");
			}
		}

		const agent = new Agent({
			transport: new NeverRunTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		try {
			await expect(
				runUserPromptWithRecovery({
					agent,
					sessionManager: {
						getSessionId: () => "session-cerebro-abort",
					} as never,
					cwd: "/tmp/cerebro-abort",
					prompt: "triage pipeline regressions",
					signal: abortController.signal,
					execute: () => agent.prompt("triage pipeline regressions"),
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it("combines multiple SessionStart initial user messages in hook order", async () => {
		const queueNextRunHistoryMessage = vi.fn();

		registerHook("SessionStart", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					initialUserMessage: "Read the repository guide first.",
				},
			}),
		});
		registerHook("SessionStart", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					initialUserMessage: "Then check the package-specific commands.",
				},
			}),
		});

		await applySessionStartHooks({
			agent: {
				queueNextRunPromptOnlyMessage: vi.fn(),
				queueNextRunSystemPromptAddition: vi.fn(),
				queueNextRunHistoryMessage,
			} as unknown as Agent,
			sessionManager: {
				getSessionId: () => "session-start-multi",
			} as never,
			cwd: "/tmp/session-start-hooks",
			source: "cli",
		});

		expect(queueNextRunHistoryMessage).toHaveBeenCalledOnce();
		expect(queueNextRunHistoryMessage).toHaveBeenCalledWith({
			role: "user",
			content:
				"Read the repository guide first.\nThen check the package-specific commands.",
			metadata: {
				kind: SESSION_START_INITIAL_USER_METADATA_KIND,
				source: "cli",
			},
			timestamp: expect.any(Number),
		});
	});

	it("persists compact SessionStart hook context immediately when requested", async () => {
		const appendMessage = vi.fn();
		const queueNextRunPromptOnlyMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();
		const queueNextRunHistoryMessage = vi.fn();
		const saveMessage = vi.fn();

		registerHook("SessionStart", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: "Restored compacted repo context.",
					initialUserMessage: "Resume from the compacted state.",
				},
				systemMessage: "Preserve compacted constraints.",
			}),
		});

		await applySessionStartHooks({
			agent: {
				appendMessage,
				queueNextRunPromptOnlyMessage,
				queueNextRunSystemPromptAddition,
				queueNextRunHistoryMessage,
			} as unknown as Agent,
			sessionManager: {
				getSessionId: () => "compact-session-start",
				saveMessage,
			} as never,
			cwd: "/tmp/session-start-hooks",
			source: "compact",
			delivery: "persistHistory",
		});

		expect(appendMessage).toHaveBeenNthCalledWith(1, {
			role: "hookMessage",
			customType: "SessionStart",
			content:
				"SessionStart hook system guidance:\nPreserve compacted constraints.",
			display: true,
			timestamp: expect.any(Number),
		});
		expect(appendMessage).toHaveBeenNthCalledWith(2, {
			role: "hookMessage",
			customType: "SessionStart",
			content: "Restored compacted repo context.",
			display: true,
			timestamp: expect.any(Number),
		});
		expect(appendMessage).toHaveBeenNthCalledWith(3, {
			role: "user",
			content: "Resume from the compacted state.",
			metadata: {
				kind: SESSION_START_INITIAL_USER_METADATA_KIND,
				source: "compact",
			},
			timestamp: expect.any(Number),
		});
		expect(saveMessage).toHaveBeenCalledTimes(3);
		expect(saveMessage).toHaveBeenNthCalledWith(1, {
			role: "hookMessage",
			customType: "SessionStart",
			content:
				"SessionStart hook system guidance:\nPreserve compacted constraints.",
			display: true,
			timestamp: expect.any(Number),
		});
		expect(saveMessage).toHaveBeenNthCalledWith(2, {
			role: "hookMessage",
			customType: "SessionStart",
			content: "Restored compacted repo context.",
			display: true,
			timestamp: expect.any(Number),
		});
		expect(saveMessage).toHaveBeenNthCalledWith(3, {
			role: "user",
			content: "Resume from the compacted state.",
			metadata: {
				kind: SESSION_START_INITIAL_USER_METADATA_KIND,
				source: "compact",
			},
			timestamp: expect.any(Number),
		});
		expect(queueNextRunSystemPromptAddition).not.toHaveBeenCalled();
		expect(queueNextRunHistoryMessage).not.toHaveBeenCalled();
		expect(queueNextRunPromptOnlyMessage).not.toHaveBeenCalled();
	});

	it("ignores SessionStart blocking directives without throwing", async () => {
		const queueNextRunPromptOnlyMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();
		const queueNextRunHistoryMessage = vi.fn();

		registerHook("SessionStart", {
			type: "callback",
			callback: async () => ({
				continue: false,
				reason: "SessionStart should not block startup",
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: "Startup context still applies.",
				},
			}),
		});

		await applySessionStartHooks({
			agent: {
				queueNextRunPromptOnlyMessage,
				queueNextRunSystemPromptAddition,
				queueNextRunHistoryMessage,
			} as unknown as Agent,
			sessionManager: {
				getSessionId: () => "session-start-blocked",
			} as never,
			cwd: "/tmp/session-start-hooks",
			source: "interactive",
		});

		expect(queueNextRunSystemPromptAddition).not.toHaveBeenCalled();
		expect(queueNextRunPromptOnlyMessage).not.toHaveBeenCalled();
		expect(queueNextRunHistoryMessage).not.toHaveBeenCalled();
	});

	it("queues PreMessage hook context for the current run", async () => {
		const queueNextRunPromptOnlyMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();
		const queueNextRunHistoryMessage = vi.fn();

		registerHook("PreMessage", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "PreMessage",
					additionalContext: "Read the migration plan before editing.",
				},
				systemMessage: "Prefer migration-safe edits.",
			}),
		});

		await applyPreMessageHooks({
			agent: {
				state: {
					model: mockModel,
				},
				queueNextRunPromptOnlyMessage,
				queueNextRunSystemPromptAddition,
				queueNextRunHistoryMessage,
			} as unknown as Agent,
			sessionManager: {
				getSessionId: () => "session-pre-message",
			} as never,
			cwd: "/tmp/pre-message-hooks",
			prompt: "Update the migration",
			attachmentNames: ["plan.md"],
		});

		expect(queueNextRunSystemPromptAddition).toHaveBeenCalledWith(
			"PreMessage hook system guidance:\nPrefer migration-safe edits.",
		);
		expect(queueNextRunPromptOnlyMessage).toHaveBeenCalledWith({
			role: "user",
			content: [
				{
					type: "text",
					text: "PreMessage hook context:\nRead the migration plan before editing.",
				},
			],
			timestamp: expect.any(Number),
		});
		expect(queueNextRunHistoryMessage).not.toHaveBeenCalled();
	});

	it("stops prompt execution when a PreMessage hook blocks the run", async () => {
		const execute = vi.fn(async () => {});

		registerHook("PreMessage", {
			type: "callback",
			callback: async () => ({
				continue: false,
				stopReason: "Prompt blocked by PreMessage hook",
			}),
		});

		await expect(
			runUserPromptWithRecovery({
				agent: {
					state: {
						model: mockModel,
						messages: [],
					},
					queueNextRunPromptOnlyMessage: vi.fn(),
					queueNextRunSystemPromptAddition: vi.fn(),
					queueNextRunHistoryMessage: vi.fn(),
				} as unknown as Agent,
				sessionManager: {
					getSessionId: () => "session-pre-message-blocked",
				} as never,
				cwd: "/tmp/pre-message-hooks",
				prompt: "Blocked prompt",
				execute,
			}),
		).rejects.toThrow("Prompt blocked by PreMessage hook");
		expect(execute).not.toHaveBeenCalled();
	});

	it("runs PostMessage hooks after a successful prompt turn", async () => {
		let captured: PostMessageHookInput | undefined;

		registerHook("PostMessage", {
			type: "callback",
			callback: async (input) => {
				captured = input as PostMessageHookInput;
				return {};
			},
		});

		class PromptCaptureTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				_userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessageWithUsage("Done", {
					inputTokens: 12,
					outputTokens: 34,
					stopReason: "stop",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}

			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessage("Continued");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new PromptCaptureTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-post-message",
			} as never,
			cwd: "/tmp/post-message-hooks",
			prompt: "first",
			execute: () => agent.prompt("first"),
		});

		expect(captured).toMatchObject({
			hook_event_name: "PostMessage",
			cwd: "/tmp/post-message-hooks",
			session_id: "session-post-message",
			response: "Done",
			input_tokens: 12,
			output_tokens: 34,
			stop_reason: "stop",
		});
		expect(captured?.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("continues toward an explicit token budget from the user prompt", async () => {
		const continuationPrompts: string[] = [];
		const runtimeStatuses: Array<{
			status: string;
			details: Record<string, unknown>;
		}> = [];
		let continuationCount = 0;

		class BudgetTransport implements AgentTransport {
			async *run(
				messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (Array.isArray(userMessage.content)) {
					continuationCount += 1;
					const lastMessage = messages[messages.length - 1];
					if (
						lastMessage?.role === "user" &&
						typeof lastMessage.content === "string"
					) {
						continuationPrompts.push(lastMessage.content);
					}
				}

				const nextAssistant =
					continuationCount === 0
						? createAssistantMessageWithUsage("Phase 1", {
								inputTokens: 50,
								outputTokens: 200,
								stopReason: "stop",
							})
						: continuationCount === 1
							? createAssistantMessageWithUsage("Phase 2", {
									inputTokens: 40,
									outputTokens: 400,
									stopReason: "stop",
								})
							: createAssistantMessageWithUsage("Phase 3", {
									inputTokens: 35,
									outputTokens: 350,
									stopReason: "stop",
								});

				yield { type: "message_start", message: nextAssistant };
				yield { type: "message_end", message: nextAssistant };
			}
		}

		const agent = new Agent({
			transport: new BudgetTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		agent.subscribe((event) => {
			if (event.type === "status") {
				runtimeStatuses.push({
					status: event.status,
					details: event.details,
				});
			}
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-token-budget",
			} as never,
			cwd: "/tmp/token-budget",
			prompt: "Investigate this issue thoroughly +1k",
			execute: () => agent.prompt("Investigate this issue thoroughly +1k"),
		});

		expect(continuationPrompts).toEqual([
			"Stopped at 20% of token target (200 / 1,000). Keep working - do not summarize.",
			"Stopped at 60% of token target (600 / 1,000). Keep working - do not summarize.",
		]);
		expect(runtimeStatuses).toEqual([
			{
				status: "Target: 200 / 1,000 (20%)",
				details: {
					kind: "token_budget_continuation",
					budget: 1_000,
					pct: 20,
					turnOutputTokens: 200,
					continuationCount: 1,
				},
			},
			{
				status: "Target: 600 / 1,000 (60%)",
				details: {
					kind: "token_budget_continuation",
					budget: 1_000,
					pct: 60,
					turnOutputTokens: 600,
					continuationCount: 2,
				},
			},
		]);
		expect(
			agent.state.messages.filter((message) => message.role === "assistant"),
		).toHaveLength(3);
		expect(
			extractAssistantText(
				agent.state.messages[
					agent.state.messages.length - 1
				] as AssistantMessage,
			),
		).toBe("Phase 3");
	});

	it("reruns compact SessionStart hooks during token-budget continuation recovery", async () => {
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		let sessionStartInput: Record<string, unknown> | undefined;
		let continuationCount = 0;

		registerHook("SessionStart", {
			type: "callback",
			callback: async (input) => {
				sessionStartInput = input as Record<string, unknown>;
				return {
					systemMessage: "Re-establish compacted continuation context.",
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: "Token budget continuation hook context",
						initialUserMessage: "Token budget continuation hook prompt",
					},
				};
			},
		});

		class BudgetOverflowTransport implements AgentTransport {
			async *run(
				messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (typeof userMessage.content === "string") {
					const assistant = createAssistantMessageWithUsage("Phase 1", {
						inputTokens: 50,
						outputTokens: 200,
						stopReason: "stop",
					});
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					return;
				}

				continuationCount += 1;
				if (continuationCount === 1) {
					const assistant = {
						...createAssistantMessage("Too much context"),
						stopReason: "error" as const,
						errorMessage: overflowMessage,
					};
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					return;
				}

				const assistant = createAssistantMessageWithUsage("Phase 2", {
					inputTokens: 40,
					outputTokens: 750,
					stopReason: "stop",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new BudgetOverflowTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		const appendMessage = vi.spyOn(agent, "appendMessage");
		agent.replaceMessages(buildConversation(5));
		vi.spyOn(agent, "generateSummary").mockResolvedValue(
			createAssistantMessage("LLM summary"),
		);
		const sessionManager = {
			getSessionId: () => "session-token-budget-overflow-compact",
			buildSessionContext: () => ({
				messageEntries: Array.from({ length: 50 }, (_, index) => ({
					id: `entry-${index}`,
				})),
			}),
			saveCompaction: vi.fn(),
			saveMessage: vi.fn(),
		};

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/token-budget-overflow-compact",
			prompt: "Investigate this issue thoroughly +1k",
			execute: () => agent.prompt("Investigate this issue thoroughly +1k"),
		});

		expect(sessionStartInput).toMatchObject({
			hook_event_name: "SessionStart",
			source: "compact",
		});
		expect(appendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
				content:
					"SessionStart hook system guidance:\nRe-establish compacted continuation context.",
			}),
		);
		expect(appendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
				content: "Token budget continuation hook context",
			}),
		);
		expect(appendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "user",
				content: "Token budget continuation hook prompt",
			}),
		);
		expect(continuationCount).toBeGreaterThanOrEqual(2);
	});

	it("aborts token-budget continuations when the caller signal is canceled", async () => {
		let continueSignal: AbortSignal | undefined;
		let resolveContinuationStarted: (() => void) | undefined;
		const continuationStarted = new Promise<void>((resolve) => {
			resolveContinuationStarted = resolve;
		});

		class BudgetTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
				signal?: AbortSignal,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (Array.isArray(userMessage.content)) {
					continueSignal = signal;
					resolveContinuationStarted?.();
					await new Promise<void>((_, reject) => {
						if (signal?.aborted) {
							const abortError = new Error("Operation aborted");
							abortError.name = "AbortError";
							reject(abortError);
							return;
						}

						signal?.addEventListener(
							"abort",
							() => {
								const abortError = new Error("Operation aborted");
								abortError.name = "AbortError";
								reject(abortError);
							},
							{ once: true },
						);
					});
					return;
				}

				const assistant = createAssistantMessageWithUsage("Phase 1", {
					inputTokens: 50,
					outputTokens: 200,
					stopReason: "stop",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new BudgetTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		const abortController = new AbortController();

		const runPromise = runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-token-budget-abort",
			} as never,
			cwd: "/tmp/token-budget-abort",
			prompt: "Investigate this issue thoroughly +1k",
			signal: abortController.signal,
			execute: () => agent.prompt("Investigate this issue thoroughly +1k"),
		});

		await continuationStarted;
		abortController.abort();

		await expect(runPromise).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(continueSignal?.aborted).toBe(true);
	});

	it("skips PostMessage hooks when recovery ends on a truncated response", async () => {
		let called = false;

		registerHook("PostMessage", {
			type: "callback",
			callback: async () => {
				called = true;
				return {};
			},
		});

		class LengthTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				_userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessageWithUsage("Partial", {
					inputTokens: 12,
					outputTokens: 34,
					stopReason: "length",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}

			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessageWithUsage("Still partial", {
					inputTokens: 12,
					outputTokens: 34,
					stopReason: "length",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new LengthTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-post-message-length",
			} as never,
			cwd: "/tmp/post-message-length",
			prompt: "first",
			execute: () => agent.prompt("first"),
		});

		expect(called).toBe(false);
	});

	it("runs PostMessage hooks after overflow recovery compacts the turn", async () => {
		let captured: PostMessageHookInput | undefined;
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";

		registerHook("PostMessage", {
			type: "callback",
			callback: async (input) => {
				captured = input as PostMessageHookInput;
				return {};
			},
		});

		class OverflowThenSuccessTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (typeof userMessage.content === "string") {
					const assistantStart = createAssistantMessage("Too much context");
					const assistantEnd = {
						...assistantStart,
						stopReason: "error" as const,
						errorMessage: overflowMessage,
					};
					yield { type: "message_start", message: assistantStart };
					yield { type: "message_end", message: assistantEnd };
					return;
				}

				const assistant = createAssistantMessageWithUsage(
					"Recovered response",
					{
						inputTokens: 21,
						outputTokens: 55,
						stopReason: "stop",
					},
				);
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new OverflowThenSuccessTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		agent.replaceMessages(buildConversation(5));
		vi.spyOn(agent, "generateSummary").mockResolvedValue(
			createAssistantMessage("LLM summary"),
		);

		const sessionManager = {
			getSessionId: () => "session-post-message-overflow",
			buildSessionContext: () => ({
				messageEntries: Array.from({ length: 50 }, (_, index) => ({
					id: `entry-${index}`,
				})),
			}),
			saveCompaction: vi.fn(),
			saveMessage: vi.fn(),
		};

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/post-message-overflow",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		expect(captured).toMatchObject({
			hook_event_name: "PostMessage",
			cwd: "/tmp/post-message-overflow",
			session_id: "session-post-message-overflow",
			response: "Recovered response",
			input_tokens: 21,
			output_tokens: 55,
			stop_reason: "stop",
		});
		expect(captured?.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("carries Anthropic task-budget remaining across overflow compaction and resets it next turn", async () => {
		const configs: Array<AgentRunConfig["taskBudget"]> = [];
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		let turn = 0;

		class OverflowThenSuccessTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				configs.push(config.taskBudget);
				if (typeof userMessage.content === "string" && turn === 0) {
					turn += 1;
					const assistant = {
						...createAssistantMessageWithUsage("Too much context", {
							inputTokens: 20_000,
							outputTokens: 0,
							stopReason: "error",
						}),
						errorMessage: overflowMessage,
					};
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					return;
				}

				const assistant = createAssistantMessageWithUsage("Recovered", {
					inputTokens: 21,
					outputTokens: 55,
					stopReason: "stop",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new OverflowThenSuccessTransport(),
			initialState: {
				model: {
					...mockModel,
					api: "anthropic-messages",
					provider: "anthropic",
				} as Model<"anthropic-messages">,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		agent.setTaskBudgetTotal(50_000);
		agent.replaceMessages(buildConversation(5));
		vi.spyOn(agent, "generateSummary").mockResolvedValue(
			createAssistantMessage("LLM summary"),
		);

		const sessionManager = {
			getSessionId: () => "session-task-budget-overflow",
			buildSessionContext: () => ({
				messageEntries: Array.from({ length: 50 }, (_, index) => ({
					id: `entry-${index}`,
				})),
			}),
			saveCompaction: vi.fn(),
			saveMessage: vi.fn(),
		};

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/task-budget-overflow",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/task-budget-overflow",
			prompt: "follow up",
			execute: () => agent.prompt("follow up"),
		});

		expect(configs).toEqual([
			{ total: 50_000 },
			{ total: 50_000, remaining: 30_000 },
			{ total: 50_000 },
		]);
	});

	it("runs SessionStart hooks with compact source before overflow recovery continues", async () => {
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		let sessionStartInput: Record<string, unknown> | undefined;

		registerHook("SessionStart", {
			type: "callback",
			callback: async (input) => {
				sessionStartInput = input as Record<string, unknown>;
				return {
					systemMessage: "Re-establish compacted context.",
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: "Compaction hook context",
						initialUserMessage: "Compaction hook prompt",
					},
				};
			},
		});

		class OverflowThenSuccessTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (typeof userMessage.content === "string") {
					const assistant = {
						...createAssistantMessage("Too much context"),
						stopReason: "error" as const,
						errorMessage: overflowMessage,
					};
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					return;
				}

				const assistant = createAssistantMessage("Recovered response");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new OverflowThenSuccessTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		const appendMessage = vi.spyOn(agent, "appendMessage");
		const queueNextRunSystemPromptAddition = vi.spyOn(
			agent,
			"queueNextRunSystemPromptAddition",
		);
		const queueNextRunHistoryMessage = vi.spyOn(
			agent,
			"queueNextRunHistoryMessage",
		);
		agent.replaceMessages(buildConversation(5));
		vi.spyOn(agent, "generateSummary").mockResolvedValue(
			createAssistantMessage("LLM summary"),
		);
		const sessionManager = {
			getSessionId: () => "session-compact-session-start",
			buildSessionContext: () => ({
				messageEntries: Array.from({ length: 50 }, (_, index) => ({
					id: `entry-${index}`,
				})),
			}),
			saveCompaction: vi.fn(),
			saveMessage: vi.fn(),
		};

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/compact-session-start",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
		});

		expect(sessionStartInput).toMatchObject({
			hook_event_name: "SessionStart",
			source: "compact",
		});
		expect(appendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
				content:
					"SessionStart hook system guidance:\nRe-establish compacted context.",
			}),
		);
		expect(appendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
				content: "Compaction hook context",
			}),
		);
		expect(appendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "user",
				content: "Compaction hook prompt",
			}),
		);
		expect(sessionManager.saveMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
				content:
					"SessionStart hook system guidance:\nRe-establish compacted context.",
			}),
		);
		expect(sessionManager.saveMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
				content: "Compaction hook context",
			}),
		);
		expect(sessionManager.saveMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "user",
				content: "Compaction hook prompt",
			}),
		);
		expect(queueNextRunSystemPromptAddition).not.toHaveBeenCalled();
		expect(queueNextRunHistoryMessage).not.toHaveBeenCalled();
		expect(agent.state.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "hookMessage",
					customType: "SessionStart",
					content:
						"SessionStart hook system guidance:\nRe-establish compacted context.",
				}),
				expect.objectContaining({
					role: "hookMessage",
					customType: "SessionStart",
					content: "Compaction hook context",
				}),
				expect.objectContaining({
					role: "user",
					content: "Compaction hook prompt",
				}),
			]),
		);
	});

	it("prepends plan restoration and caller post-keep messages before compact SessionStart output during overflow recovery", async () => {
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		const planDir = mkdtempSync(join(tmpdir(), "maestro-plan-compaction-"));
		const maestroHome = mkdtempSync(join(tmpdir(), "maestro-home-compaction-"));
		const previousPlanDir = process.env.MAESTRO_PLAN_DIR;
		const previousPlanFile = process.env.MAESTRO_PLAN_FILE;
		const previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_PLAN_DIR = planDir;
		process.env.MAESTRO_PLAN_FILE = join(planDir, "active-plan.md");
		process.env.MAESTRO_HOME = maestroHome;

		try {
			enterPlanMode({ name: "Compaction test plan" });
			registerHook("SessionStart", {
				type: "callback",
				callback: async () => ({
					systemMessage: "Re-establish compacted context.",
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: "Compaction hook context",
					},
				}),
			});

			class OverflowThenSuccessTransport implements AgentTransport {
				async *run(
					_messages: Message[],
					userMessage: Message,
					_config: AgentRunConfig,
				): AsyncGenerator<AgentEvent, void, unknown> {
					if (typeof userMessage.content === "string") {
						const assistant = {
							...createAssistantMessage("Too much context"),
							stopReason: "error" as const,
							errorMessage: overflowMessage,
						};
						yield { type: "message_start", message: assistant };
						yield { type: "message_end", message: assistant };
						return;
					}

					const assistant = createAssistantMessage("Recovered response");
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
				}
			}

			const agent = new Agent({
				transport: new OverflowThenSuccessTransport(),
				initialState: {
					model: mockModel,
					tools: [],
					systemPrompt: "Base system prompt",
				},
			});
			agent.replaceMessages(buildConversation(5));
			vi.spyOn(agent, "generateSummary").mockResolvedValue(
				createAssistantMessage("LLM summary"),
			);
			const sessionManager = {
				getSessionId: () => "session-compact-skill-restore",
				buildSessionContext: () => ({
					messageEntries: Array.from({ length: 50 }, (_, index) => ({
						id: `entry-${index}`,
					})),
				}),
				saveCompaction: vi.fn(),
				saveMessage: vi.fn(),
			};
			const getPostKeepMessages = vi.fn().mockResolvedValue([
				{
					role: "hookMessage" as const,
					customType: "skill" as const,
					content: "Injected instructions for debug",
					display: false,
					details: { name: "debug", action: "activate" },
					timestamp: Date.now(),
				},
			]);

			await runUserPromptWithRecovery({
				agent,
				sessionManager: sessionManager as never,
				cwd: "/tmp/compact-skill-restore",
				prompt: "latest question",
				execute: () => agent.prompt("latest question"),
				getPostKeepMessages,
			});

			expect(getPostKeepMessages).toHaveBeenCalledTimes(1);
			const planFileIndex = agent.state.messages.findIndex(
				(message) =>
					message.role === "hookMessage" && message.customType === "plan-file",
			);
			const planIndex = agent.state.messages.findIndex(
				(message) =>
					message.role === "hookMessage" && message.customType === "plan-mode",
			);
			const skillIndex = agent.state.messages.findIndex(
				(message) =>
					message.role === "hookMessage" && message.customType === "skill",
			);
			const sessionStartIndex = agent.state.messages.findIndex(
				(message) =>
					message.role === "hookMessage" &&
					message.customType === "SessionStart",
			);
			expect(planFileIndex).toBeGreaterThan(-1);
			expect(planIndex).toBeGreaterThan(planFileIndex);
			expect(skillIndex).toBeGreaterThan(planIndex);
			expect(sessionStartIndex).toBeGreaterThan(skillIndex);
		} finally {
			clearPlanModeState();
			if (previousPlanDir === undefined) {
				delete process.env.MAESTRO_PLAN_DIR;
			} else {
				process.env.MAESTRO_PLAN_DIR = previousPlanDir;
			}
			if (previousPlanFile === undefined) {
				delete process.env.MAESTRO_PLAN_FILE;
			} else {
				process.env.MAESTRO_PLAN_FILE = previousPlanFile;
			}
			if (previousMaestroHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = previousMaestroHome;
			}
			rmSync(planDir, { recursive: true, force: true });
			rmSync(maestroHome, { recursive: true, force: true });
		}
	});

	it("withholds recoverable overflow assistant errors until recovery succeeds", async () => {
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";

		class OverflowThenSuccessTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (typeof userMessage.content === "string") {
					const assistant = {
						...createAssistantMessage("Too much context"),
						stopReason: "error" as const,
						errorMessage: overflowMessage,
					};
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					return;
				}

				const assistant = createAssistantMessage("Recovered response");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const agent = new Agent({
			transport: new OverflowThenSuccessTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		agent.replaceMessages(buildConversation(5));
		vi.spyOn(agent, "generateSummary").mockResolvedValue(
			createAssistantMessage("LLM summary"),
		);

		const emittedAssistantStarts: AssistantMessage[] = [];
		const emittedAssistantEnds: AssistantMessage[] = [];
		const emittedTurnEnds: AssistantMessage[] = [];
		agent.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "assistant"
			) {
				emittedAssistantStarts.push(event.message);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				emittedAssistantEnds.push(event.message);
			}
			if (event.type === "turn_end" && event.message.role === "assistant") {
				emittedTurnEnds.push(event.message as AssistantMessage);
			}
		});

		const sessionManager = {
			getSessionId: () => "session-overflow-withheld",
			buildSessionContext: () => ({
				messageEntries: Array.from({ length: 50 }, (_, index) => ({
					id: `entry-${index}`,
				})),
			}),
			saveCompaction: vi.fn(),
			saveMessage: vi.fn(),
		};

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/overflow-withheld",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		expect(emittedAssistantStarts).toHaveLength(1);
		expect(emittedAssistantStarts[0]?.stopReason).toBe("stop");
		expect(extractAssistantText(emittedAssistantStarts[0])).toBe(
			"Recovered response",
		);
		expect(emittedAssistantEnds).toHaveLength(1);
		expect(emittedAssistantEnds[0]?.stopReason).toBe("stop");
		expect(extractAssistantText(emittedAssistantEnds[0])).toBe(
			"Recovered response",
		);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "assistant" && message.stopReason === "error",
			),
		).toBe(false);
	});

	it("withholds recoverable max-output turns until continuation succeeds", async () => {
		class LengthThenSuccessTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (typeof userMessage.content === "string") {
					const assistant = createAssistantMessageWithUsage("Partial ", {
						inputTokens: 12,
						outputTokens: 34,
						stopReason: "length",
					});
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					yield { type: "turn_end", message: assistant, toolResults: [] };
					return;
				}

				const assistant = createAssistantMessageWithUsage("rest", {
					inputTokens: 8,
					outputTokens: 21,
					stopReason: "stop",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
				yield { type: "turn_end", message: assistant, toolResults: [] };
			}
		}

		const agent = new Agent({
			transport: new LengthThenSuccessTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		const emittedAssistantStarts: AssistantMessage[] = [];
		const emittedAssistantEnds: AssistantMessage[] = [];
		const emittedTurnEnds: AssistantMessage[] = [];
		const agentEndStopReasons: StopReason[] = [];
		agent.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "assistant"
			) {
				emittedAssistantStarts.push(event.message);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				emittedAssistantEnds.push(event.message);
			}
			if (event.type === "turn_end" && event.message.role === "assistant") {
				emittedTurnEnds.push(event.message as AssistantMessage);
			}
			if (event.type === "agent_end" && event.stopReason) {
				agentEndStopReasons.push(event.stopReason);
			}
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-length-withheld",
			} as never,
			cwd: "/tmp/length-withheld",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
		});

		expect(emittedAssistantStarts).toHaveLength(1);
		expect(extractAssistantText(emittedAssistantStarts[0])).toBe(
			"Partial rest",
		);
		expect(emittedAssistantStarts[0]?.stopReason).toBe("stop");
		expect(emittedAssistantEnds).toHaveLength(1);
		expect(extractAssistantText(emittedAssistantEnds[0])).toBe("Partial rest");
		expect(emittedAssistantEnds[0]?.stopReason).toBe("stop");
		expect(emittedTurnEnds).toHaveLength(1);
		expect(extractAssistantText(emittedTurnEnds[0])).toBe("Partial rest");
		expect(agentEndStopReasons.at(-1)).toBe("stop");
		expect(
			agent.state.messages.filter((message) => message.role === "assistant"),
		).toHaveLength(1);
		expect(
			extractAssistantText(
				agent.state.messages[
					agent.state.messages.length - 1
				] as AssistantMessage,
			),
		).toBe("Partial rest");
	});

	it("ignores duplicate recoverable max-output endings when merging continuations", async () => {
		class DuplicateLengthThenSuccessTransport implements AgentTransport {
			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				if (typeof userMessage.content === "string") {
					const assistant = createAssistantMessageWithUsage("Partial ", {
						inputTokens: 12,
						outputTokens: 34,
						stopReason: "length",
					});
					yield { type: "message_start", message: assistant };
					yield { type: "message_end", message: assistant };
					yield { type: "message_end", message: assistant };
					yield { type: "turn_end", message: assistant, toolResults: [] };
					return;
				}

				const assistant = createAssistantMessageWithUsage("rest", {
					inputTokens: 8,
					outputTokens: 21,
					stopReason: "stop",
				});
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
				yield { type: "turn_end", message: assistant, toolResults: [] };
			}
		}

		const agent = new Agent({
			transport: new DuplicateLengthThenSuccessTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-length-duplicate",
			} as never,
			cwd: "/tmp/length-duplicate",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
		});

		expect(
			agent.state.messages.filter((message) => message.role === "user"),
		).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: "latest question",
			}),
		);
		expect(
			agent.state.messages.filter((message) => message.role === "assistant"),
		).toHaveLength(1);
		expect(
			extractAssistantText(
				agent.state.messages[
					agent.state.messages.length - 1
				] as AssistantMessage,
			),
		).toBe("Partial rest");
	});

	it("flushes a merged truncated assistant message when max-output recovery exhausts", async () => {
		class LengthOnlyTransport implements AgentTransport {
			private attempts = 0;

			async *run(
				_messages: Message[],
				_userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				this.attempts += 1;
				const assistant = createAssistantMessageWithUsage(
					this.attempts === 1 ? "Partial " : "rest",
					{
						inputTokens: 12,
						outputTokens: 34,
						stopReason: "length",
					},
				);
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
				yield { type: "turn_end", message: assistant, toolResults: [] };
			}

			async *continue(
				messages: Message[],
				config: AgentRunConfig,
				signal?: AbortSignal,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield* this.run(
					messages,
					{ role: "user", content: [], timestamp: 0 },
					config,
					signal,
				);
			}
		}

		const agent = new Agent({
			transport: new LengthOnlyTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		const emittedAssistantStarts: AssistantMessage[] = [];
		const emittedAssistantEnds: AssistantMessage[] = [];
		const emittedTurnEnds: AssistantMessage[] = [];
		agent.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "assistant"
			) {
				emittedAssistantStarts.push(event.message);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				emittedAssistantEnds.push(event.message);
			}
			if (event.type === "turn_end" && event.message.role === "assistant") {
				emittedTurnEnds.push(event.message as AssistantMessage);
			}
		});

		await runUserPromptWithRecovery({
			agent,
			sessionManager: {
				getSessionId: () => "session-length-exhausted",
			} as never,
			cwd: "/tmp/length-exhausted",
			prompt: "latest question",
			execute: () => agent.prompt("latest question"),
			maxOutputContinuations: 1,
		});

		expect(emittedAssistantStarts).toHaveLength(1);
		expect(extractAssistantText(emittedAssistantStarts[0])).toBe(
			"Partial rest",
		);
		expect(emittedAssistantStarts[0]?.stopReason).toBe("length");
		expect(emittedAssistantEnds).toHaveLength(1);
		expect(extractAssistantText(emittedAssistantEnds[0])).toBe("Partial rest");
		expect(emittedAssistantEnds[0]?.stopReason).toBe("length");
		expect(emittedTurnEnds).toHaveLength(1);
		expect(extractAssistantText(emittedTurnEnds[0])).toBe("Partial rest");
		expect(emittedTurnEnds[0]?.stopReason).toBe("length");
		expect(
			agent.state.messages.filter((message) => message.role === "assistant"),
		).toHaveLength(1);
		expect(
			extractAssistantText(
				agent.state.messages[
					agent.state.messages.length - 1
				] as AssistantMessage,
			),
		).toBe("Partial rest");
	});

	it("persists hook additional context as a hook message for the next run", async () => {
		class PromptCaptureTransport implements AgentTransport {
			capturedMessages: Message[][] = [];

			async *run(
				messages: Message[],
				_userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				this.capturedMessages.push(messages);
				const assistant = createAssistantMessage("Done");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}

			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessage("Continued");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const transport = new PromptCaptureTransport();
		const agent = new Agent({
			transport,
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		agent.queueNextRunHistoryMessage({
			role: "hookMessage",
			customType: "SessionStart",
			content: "Workspace conventions from hook",
			display: true,
			timestamp: Date.now(),
		});

		await agent.prompt("first");

		expect(
			agent.state.messages.find(
				(message) =>
					message.role === "hookMessage" &&
					message.customType === "SessionStart" &&
					message.content === "Workspace conventions from hook",
			),
		).toBeDefined();
		expect(transport.capturedMessages[0]).toEqual([
			expect.objectContaining({
				role: "user",
				content: [
					{ type: "text", text: "Workspace conventions from hook" },
					{ type: "text", text: "\n\n" },
					{ type: "text", text: "first" },
				],
			}),
		]);
	});

	it("delivers a queued SessionStart initial user message once and persists it", async () => {
		class PromptCaptureTransport implements AgentTransport {
			capturedMessages: Message[][] = [];

			async *run(
				messages: Message[],
				_userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				this.capturedMessages.push(messages);
				const assistant = createAssistantMessage("Done");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}

			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessage("Continued");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const transport = new PromptCaptureTransport();
		const agent = new Agent({
			transport,
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		const deliveredMessages: Message[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				deliveredMessages.push(event.message);
			}
		});

		agent.queueNextRunHistoryMessage({
			role: "user",
			content: "SessionStart seeded prompt",
			timestamp: Date.now(),
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(
			deliveredMessages.filter(
				(message) => message.content === "SessionStart seeded prompt",
			),
		).toHaveLength(1);
		expect(
			agent.state.messages.filter(
				(message) =>
					message.role === "user" &&
					message.content === "SessionStart seeded prompt",
			),
		).toHaveLength(1);
		expect(transport.capturedMessages[0]).toEqual([
			expect.objectContaining({
				role: "user",
				content: [
					{ type: "text", text: "SessionStart seeded prompt" },
					{ type: "text", text: "\n\n" },
					{ type: "text", text: "first" },
				],
			}),
		]);
	});

	it("collapses consecutive user turns before summary generation", async () => {
		class SummaryCaptureTransport implements AgentTransport {
			capturedMessages: Message[][] = [];

			async *run(
				messages: Message[],
				_userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				this.capturedMessages.push(messages);
				const assistant = createAssistantMessage("Summary");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}

			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessage("Continued");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const transport = new SummaryCaptureTransport();
		const agent = new Agent({
			transport,
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		await agent.generateSummary(
			[
				{
					role: "user",
					content: "SessionStart seeded prompt",
					timestamp: Date.now(),
				},
				{
					role: "user",
					content: "latest question",
					timestamp: Date.now(),
				},
			],
			"Summarize this conversation.",
		);

		expect(transport.capturedMessages[0]).toEqual([
			expect.objectContaining({
				role: "user",
				content: [
					{ type: "text", text: "SessionStart seeded prompt" },
					{ type: "text", text: "\n\n" },
					{ type: "text", text: "latest question" },
					{ type: "text", text: "\n\n" },
					{ type: "text", text: "Summarize this conversation." },
				],
			}),
		]);
	});

	it("delivers next-run prompt context once without persisting it", async () => {
		class PromptCaptureTransport implements AgentTransport {
			systemPrompts: string[] = [];
			promptOnlyMessages: Message[][] = [];

			async *run(
				_messages: Message[],
				_userMessage: Message,
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				this.systemPrompts.push(config.systemPrompt);
				this.promptOnlyMessages.push(
					(await config.getPromptOnlyMessages?.()) ?? [],
				);
				const assistant = createAssistantMessage("Done");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}

			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				const assistant = createAssistantMessage("Continued");
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
			}
		}

		const transport = new PromptCaptureTransport();
		const agent = new Agent({
			transport,
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});

		agent.queueNextRunSystemPromptAddition("Ephemeral system guidance");
		agent.queueNextRunPromptOnlyMessage({
			role: "user",
			content: [{ type: "text", text: "Ephemeral prompt context" }],
			timestamp: Date.now(),
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(transport.systemPrompts[0]).toContain("Base system prompt");
		expect(transport.systemPrompts[0]).toContain("Ephemeral system guidance");
		expect(transport.systemPrompts[1]).toBe("Base system prompt");
		expect(transport.promptOnlyMessages[0]).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Ephemeral prompt context" }],
				timestamp: expect.any(Number),
			},
		]);
		expect(transport.promptOnlyMessages[1]).toEqual([]);

		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(
						(block): block is TextContent =>
							block.type === "text" &&
							block.text.includes("Ephemeral prompt context"),
					),
			),
		).toBe(false);
	});
});
