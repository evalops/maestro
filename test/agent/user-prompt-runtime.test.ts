import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	Model,
	TextContent,
} from "../../src/agent/types.js";
import { applyUserPromptSubmitHooks } from "../../src/agent/user-prompt-runtime.js";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";

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

describe("user prompt runtime", () => {
	afterEach(() => {
		clearRegisteredHooks();
	});

	it("queues UserPromptSubmit hook context for the next run", async () => {
		const queueNextRunPromptOnlyMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();

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
		expect(queueNextRunPromptOnlyMessage).toHaveBeenCalledWith({
			role: "user",
			content: [
				{
					type: "text",
					text: "UserPromptSubmit hook context:\nRemember the migration checklist.",
				},
			],
			timestamp: expect.any(Number),
		});
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
