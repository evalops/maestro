import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	CompactionHookService,
	StopFailureHookService,
} from "../../src/agent/compaction-hooks.js";
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

function createMockHookService(): CompactionHookService {
	return {
		hasHooks: vi.fn().mockReturnValue(true),
		runPreCompactHooks: vi.fn().mockResolvedValue({
			blocked: false,
			preventContinuation: false,
		}),
	};
}

function createMockOverflowHookService() {
	return {
		hasHooks: vi.fn().mockReturnValue(true),
		runOverflowHooks: vi.fn().mockResolvedValue({
			blocked: false,
			preventContinuation: false,
		}),
	};
}

function createMockStopFailureHookService(): StopFailureHookService {
	return {
		hasHooks: vi.fn().mockReturnValue(true),
		runStopFailureHooks: vi.fn().mockResolvedValue({
			blocked: false,
			preventContinuation: false,
		}),
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
		agent.state.model.provider = "openai";
		agent.state.model.api = "openai-completions";

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

	it("tries a larger Anthropic output cap before using continuation prompts", async () => {
		const agent = createMockAgent([
			createUserMessage("question"),
			createAssistantMessage({ stopReason: "length", text: "partial" }),
		]);

		agent.continue.mockImplementationOnce(async (options?: unknown) => {
			expect(options).toMatchObject({ maxTokensOverride: 64_000 });
			agent.state.messages = [
				...agent.state.messages,
				createAssistantMessage({
					text: "expanded response",
					stopReason: "stop",
				}),
			];
		});

		const onContinue = vi.fn();

		await recoverFromMaxOutput(agent as never, {
			callbacks: { onMaxOutputContinue: onContinue },
		});

		expect(agent.continue).toHaveBeenCalledTimes(1);
		expect(agent.continue).toHaveBeenCalledWith({
			maxTokensOverride: 64_000,
		});
		expect(onContinue).not.toHaveBeenCalled();
	});

	it("falls back to continuation prompts when the escalated cap still truncates", async () => {
		const agent = createMockAgent([
			createUserMessage("question"),
			createAssistantMessage({ stopReason: "length", text: "partial" }),
		]);

		agent.continue
			.mockImplementationOnce(async (options?: unknown) => {
				expect(options).toMatchObject({ maxTokensOverride: 64_000 });
				agent.state.messages = [
					...agent.state.messages,
					createAssistantMessage({
						text: "still partial",
						stopReason: "length",
					}),
				];
			})
			.mockImplementationOnce(async (options?: unknown) => {
				expect(options).toMatchObject({
					continuationPrompt: expect.stringContaining("Resume directly"),
				});
				agent.state.messages = [
					...agent.state.messages,
					createAssistantMessage({ text: "rest", stopReason: "stop" }),
				];
			});

		await recoverFromMaxOutput(agent as never);

		expect(agent.continue).toHaveBeenCalledTimes(2);
		expect(agent.continue.mock.calls[0]?.[0]).toMatchObject({
			maxTokensOverride: 64_000,
		});
		expect(agent.continue.mock.calls[1]?.[0]).toMatchObject({
			continuationPrompt: expect.stringContaining("Resume directly"),
		});
	});
});

describe("runWithPromptRecovery", () => {
	it("compacts and continues after a thrown prompt-overflow error", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		const onCompacting = vi.fn();
		const onCompacted = vi.fn();

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			callbacks: {
				onCompacting,
				onCompacted,
			},
			execute: async () => {
				throw new Error(
					"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
				);
			},
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledOnce();
		expect(onCompacting).toHaveBeenCalledOnce();
		expect(onCompacted).toHaveBeenCalledOnce();
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

	it("uses the token_limit trigger for overflow recovery hooks", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService();

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			hookService,
			execute: async () => {
				throw new Error(
					"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
				);
			},
		});

		expect(hookService.runPreCompactHooks).toHaveBeenCalledWith(
			"token_limit",
			550,
			20000,
			undefined,
		);
	});

	it("runs Overflow hooks with parsed token counts before compaction", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		const overflowHookService = createMockOverflowHookService();

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			overflowHookService,
			execute: async () => {
				throw new Error("prompt is too long: 213462 tokens > 200000 maximum");
			},
		});

		expect(overflowHookService.runOverflowHooks).toHaveBeenCalledWith(
			213462,
			200000,
			"claude-sonnet-4",
			undefined,
		);
	});

	it("passes Overflow hook guidance through the auto-compaction prompt", async () => {
		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		const overflowHookService = createMockOverflowHookService();
		overflowHookService.runOverflowHooks.mockResolvedValue({
			blocked: false,
			preventContinuation: false,
			systemMessage: "Retain security-sensitive decisions.",
			additionalContext: "The last overflow happened during a release fix.",
		});

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			overflowHookService,
			execute: async () => {
				throw new Error(
					"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
				);
			},
		});

		expect(agent.generateSummary).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining(
				"Overflow hook system guidance:\nRetain security-sensitive decisions.",
			),
			expect.any(String),
		);
		expect(agent.generateSummary).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining(
				"Overflow hook context:\nThe last overflow happened during a release fix.",
			),
			expect.any(String),
		);
		expect(sessionManager.saveCompaction).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Number),
			expect.any(Number),
			expect.objectContaining({
				customInstructions: undefined,
			}),
		);
	});

	it("creates an Overflow hook service from hook context when none is provided", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prompt-recovery-overflow-"));
		const hookDir = join(testDir, ".maestro");
		const hookScriptPath = join(hookDir, "overflow-hook.sh");
		mkdirSync(hookDir, { recursive: true });
		writeFileSync(
			hookScriptPath,
			`#!/bin/bash
echo '{"continue": true, "systemMessage": "Preserve operator guidance from overflow hook."}'
`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(hookDir, "hooks.json"),
			JSON.stringify({
				hooks: {
					Overflow: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: hookScriptPath }],
						},
					],
				},
			}),
		);

		const agent = createMockAgent([
			...buildConversation(5),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();

		try {
			await runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				hookContext: { cwd: testDir },
				execute: async () => {
					throw new Error(
						"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
					);
				},
			});
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}

		expect(agent.generateSummary).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining(
				"Overflow hook system guidance:\nPreserve operator guidance from overflow hook.",
			),
			expect.any(String),
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
		const onCompactionFailed = vi.fn();

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				callbacks: {
					onCompactionFailed,
				},
				execute: async () => {
					throw error;
				},
			}),
		).rejects.toThrow(error.message);

		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
		expect(onCompactionFailed).toHaveBeenCalledWith(
			"Not enough history to compact",
		);
	});

	it("runs StopFailure hooks when prompt overflow recovery cannot compact", async () => {
		const error = new Error(
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.",
		);
		const agent = createMockAgent([
			createUserMessage("short"),
			createAssistantMessage(),
			createUserMessage("latest question"),
		]);
		const sessionManager = createMockSessionManager();
		const stopFailureHookService = createMockStopFailureHookService();

		await expect(
			runWithPromptRecovery({
				agent: agent as never,
				sessionManager,
				stopFailureHookService,
				execute: async () => {
					throw error;
				},
			}),
		).rejects.toThrow(error.message);

		expect(stopFailureHookService.runStopFailureHooks).toHaveBeenCalledWith(
			"prompt_overflow",
			error.message,
			undefined,
			undefined,
		);
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

	it("runs StopFailure hooks when max-output recovery is exhausted", async () => {
		const agent = createMockAgent([
			createUserMessage("question"),
			createAssistantMessage({ stopReason: "length", text: "partial" }),
		]);
		const sessionManager = createMockSessionManager();
		const stopFailureHookService = createMockStopFailureHookService();

		agent.continue.mockImplementation(async (options?: unknown) => {
			const nextText =
				options && typeof options === "object" && "maxTokensOverride" in options
					? "expanded partial"
					: "still partial";
			agent.state.messages = [
				...agent.state.messages,
				createAssistantMessage({
					text: nextText,
					stopReason: "length",
				}),
			];
		});

		await runWithPromptRecovery({
			agent: agent as never,
			sessionManager,
			stopFailureHookService,
			execute: async () => {},
		});

		expect(stopFailureHookService.runStopFailureHooks).toHaveBeenCalledWith(
			"max_output_tokens",
			"Automatic continuation recovery exhausted before the model completed the response.",
			"still partial",
			undefined,
		);
	});
});
