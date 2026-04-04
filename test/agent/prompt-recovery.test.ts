import { describe, expect, it, vi } from "vitest";
import {
	recoverFromMaxOutput,
	runWithPromptRecovery,
} from "../../src/agent/prompt-recovery.js";
import type {
	AppMessage,
	AssistantMessage,
	Usage,
} from "../../src/agent/types.js";

function createUsage(input = 0, output = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text = "hello"): AppMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(params?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	usage?: Usage;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: params?.text ?? "response" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: params?.usage ?? createUsage(100, 50),
		stopReason: params?.stopReason ?? "stop",
		errorMessage: params?.errorMessage,
		timestamp: Date.now(),
	};
}

function buildConversation(turns: number): AppMessage[] {
	const messages: AppMessage[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push(createUserMessage(`message ${i}`));
		messages.push(
			createAssistantMessage({
				text: `response ${i}`,
				usage: createUsage(100 * (i + 1), 50),
			}),
		);
	}
	return messages;
}

function createMockSessionManager() {
	return {
		buildSessionContext: vi.fn().mockReturnValue({
			messageEntries: Array.from({ length: 50 }, (_, i) => ({
				id: `entry-${i}`,
			})),
		}),
		saveCompaction: vi.fn(),
		saveMessage: vi.fn(),
	};
}

function createMockAgent(messages: AppMessage[]) {
	const state = {
		messages: [...messages],
		model: {
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			contextWindow: 200_000,
			maxTokens: 8_192,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		},
	};

	const agent = {
		state,
		generateSummary: vi
			.fn()
			.mockResolvedValue(createAssistantMessage({ text: "LLM summary" })),
		replaceMessages: vi.fn((nextMessages: AppMessage[]) => {
			state.messages = nextMessages;
		}),
		clearTransientRunState: vi.fn(),
		continue: vi.fn(async () => {
			state.messages = [
				...state.messages,
				createAssistantMessage({ text: "continued response" }),
			];
		}),
	};

	return agent;
}

describe("recoverFromMaxOutput", () => {
	it("continues until the latest assistant message no longer ends for length", async () => {
		const agent = createMockAgent([
			createUserMessage("question"),
			createAssistantMessage({ stopReason: "length", text: "partial" }),
		]);

		agent.continue.mockImplementationOnce(async () => {
			agent.state.messages = [
				...agent.state.messages,
				createAssistantMessage({ text: "rest", stopReason: "stop" }),
			];
		});

		const onContinue = vi.fn();

		await recoverFromMaxOutput(agent as never, {
			callbacks: { onMaxOutputContinue: onContinue },
		});

		expect(agent.continue).toHaveBeenCalledTimes(1);
		expect(agent.continue).toHaveBeenCalledWith(
			expect.objectContaining({
				continuationPrompt: expect.stringContaining("Resume directly"),
			}),
		);
		expect(onContinue).toHaveBeenCalledWith(1, 3);
	});
});

describe("runWithPromptRecovery", () => {
	it("compacts and continues after a thrown prompt-overflow error", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			execute: async () => {
				throw new Error(
					"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
				);
			},
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledWith(
			expect.objectContaining({
				continuationPrompt: expect.stringContaining(
					"Continue directly with the user's unresolved request",
				),
			}),
		);
		expect(agent.replaceMessages).toHaveBeenCalledOnce();
	});

	it("compacts and continues after an assistant overflow error message", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			execute: async () => {
				agent.state.messages = [
					...agent.state.messages,
					createAssistantMessage({
						stopReason: "error",
						errorMessage:
							"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
					}),
				];
			},
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledWith(
			expect.objectContaining({
				continuationPrompt: expect.stringContaining(
					"Continue directly with the user's unresolved request",
				),
			}),
		);
	});

	it("rethrows the original overflow error if compaction cannot run", async () => {
		const error = new Error(
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
		);
		const agent = createMockAgent([
			createUserMessage("short"),
			createAssistantMessage(),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				execute: async () => {
					throw error;
				},
			}),
		).rejects.toThrow(error.message);

		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
	});

	it("rethrows assistant overflow errors if compaction cannot run", async () => {
		const agent = createMockAgent([
			createUserMessage("short"),
			createAssistantMessage(),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				execute: async () => {
					agent.state.messages = [
						...agent.state.messages,
						createAssistantMessage({
							stopReason: "error",
							errorMessage: overflowMessage,
						}),
					];
				},
			}),
		).rejects.toThrow(overflowMessage);

		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
	});

	it("rethrows non-overflow errors without attempting compaction", async () => {
		const agent = createMockAgent(buildConversation(5));
		const sessionManager = createMockSessionManager();

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				execute: async () => {
					throw new Error("network timeout");
				},
			}),
		).rejects.toThrow("network timeout");

		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
	});

	it("does not auto-compact after a successful silent-overflow style response", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			execute: async () => {
				agent.state.messages = [
					...agent.state.messages,
					createAssistantMessage({
						text: "apparently complete",
						stopReason: "stop",
						usage: createUsage(250_000, 50),
					}),
				];
			},
		});

		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
	});

	it("does not swallow non-overflow errors because of stale overflow messages", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createAssistantMessage({
				stopReason: "error",
				errorMessage:
					"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
			}),
		]);
		const sessionManager = createMockSessionManager();

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				execute: async () => {
					throw new Error("network timeout");
				},
			}),
		).rejects.toThrow("network timeout");

		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
	});

	it("surfaces continuation failures after successful compaction", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		agent.continue.mockRejectedValueOnce(new Error("continue failed"));

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				execute: async () => {
					throw new Error(
						"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
					);
				},
			}),
		).rejects.toThrow("continue failed");

		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledOnce();
	});
});
