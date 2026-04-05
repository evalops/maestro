import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent/agent.js";
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
			timestamp: expect.any(Number),
		});
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

		const emittedAssistantEnds: AssistantMessage[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				emittedAssistantEnds.push(event.message);
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
				content: [{ type: "text", text: "Workspace conventions from hook" }],
			}),
			expect.objectContaining({
				role: "user",
				content: "first",
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
				content: "SessionStart seeded prompt",
			}),
			expect.objectContaining({
				role: "user",
				content: "first",
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
