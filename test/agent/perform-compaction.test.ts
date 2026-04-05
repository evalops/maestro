/**
 * Tests for performCompaction() — the consolidated compaction function.
 */

import { describe, expect, it, vi } from "vitest";
import {
	registerPostCompactionCleanup,
	resetPostCompactionCleanupRegistry,
} from "../../src/agent/compaction-cleanup.js";
import type { CompactionHookService } from "../../src/agent/compaction-hooks.js";
import {
	type CompactionAgent,
	type CompactionSessionManager,
	performCompaction,
} from "../../src/agent/compaction.js";
import type {
	AppMessage,
	AssistantMessage,
	Attachment,
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

function createUserMessageWithAttachments(
	text = "see attachments",
	attachments?: Attachment[],
): AppMessage {
	return {
		role: "user",
		content: text,
		attachments: attachments ?? [
			{
				id: "image-1",
				type: "image",
				fileName: "diagram.png",
				mimeType: "image/png",
				size: 3,
				content: "abc",
			},
			{
				id: "doc-1",
				type: "document",
				fileName: "notes.txt",
				mimeType: "text/plain",
				size: 5,
				content: "def",
				extractedText:
					"full document text that should not be in compaction input",
			},
		],
		timestamp: Date.now(),
	};
}

function createUserMessageWithInlineImage(
	text = "see screenshot",
	imageLabel = "before image",
): AppMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: "image-bytes", mimeType: "image/png" },
			{ type: "text", text: imageLabel },
		],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(
	text = "response",
	usage = createUsage(100, 50),
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createDecoratedCompactionSummaryMessage(
	text = "Summarized prior work.",
): AssistantMessage {
	return {
		...createAssistantMessage(text),
		content: [
			{
				type: "text",
				text: `Another language model started to solve this problem and produced a summary of its thinking process. ${text}\n\n(Compacted 12 messages on 4/5/2026, 2:00:00 AM)`,
			},
		],
	};
}

function createToolResultMessage(
	toolName = "bash",
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	> = [
		{ type: "text", text: "tool output" },
		{ type: "image", data: "image-bytes", mimeType: "image/png" },
	],
): AppMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}`,
		toolName,
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

function createHookMessageWithInlineImage(text = "hook context"): AppMessage {
	return {
		role: "hookMessage",
		customType: "status",
		content: [
			{ type: "text", text },
			{ type: "image", data: "image-bytes", mimeType: "image/png" },
		],
		display: false,
		timestamp: Date.now(),
	};
}

function createActiveSkillHookMessage(name = "debug"): AppMessage {
	return {
		role: "hookMessage",
		customType: "skill",
		content: `Injected instructions for ${name}`,
		display: false,
		details: { name, action: "activate" },
		timestamp: Date.now(),
	};
}

function createPostCompactHookMessage(
	content = "Re-apply compacted constraints.",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "PostCompact",
		content,
		display: true,
		timestamp: Date.now(),
	};
}

function createErrorAssistantMessage(
	text = "provider failed",
	errorMessage = "Anthropic API error (429): rate limit exceeded.",
): AssistantMessage {
	return {
		...createAssistantMessage(text, createUsage(100, 50)),
		stopReason: "error",
		errorMessage,
	};
}

/** Build a conversation with the given number of turn pairs (user + assistant). */
function buildConversation(turns: number): AppMessage[] {
	const messages: AppMessage[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push(createUserMessage(`message ${i}`));
		messages.push(
			createAssistantMessage(`response ${i}`, createUsage(100 * (i + 1), 50)),
		);
	}
	return messages;
}

function createMockAgent(messages: AppMessage[]): CompactionAgent {
	const state = {
		messages: [...messages],
		model: {
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			id: "claude-3-5-sonnet",
		},
	};
	return {
		state,
		generateSummary: vi
			.fn()
			.mockResolvedValue(createAssistantMessage("LLM summary of conversation")),
		replaceMessages: vi.fn((nextMessages: AppMessage[]) => {
			state.messages = [...nextMessages];
		}),
		appendMessage: vi.fn((message: AppMessage) => {
			state.messages.push(message);
		}),
		clearTransientRunState: vi.fn(),
	};
}

function createMockSessionManager(): CompactionSessionManager {
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

function createMockHookService(
	overrides?: Partial<{
		blocked: boolean;
		blockReason?: string;
		additionalContext?: string;
		systemMessage?: string;
		preventContinuation: boolean;
		stopReason?: string;
	}>,
): CompactionHookService {
	return {
		hasHooks: vi.fn().mockReturnValue(true),
		runPreCompactHooks: vi.fn().mockResolvedValue({
			blocked: false,
			preventContinuation: false,
			...overrides,
		}),
		runPostCompactHooks: vi.fn().mockResolvedValue({
			blocked: false,
			preventContinuation: false,
		}),
	};
}

/** Extract the messages passed to replaceMessages from the mock. */
function getReplacedMessages(agent: CompactionAgent): AppMessage[] {
	return [...agent.state.messages];
}

describe("performCompaction", () => {
	it("runs registered post-compaction cleanup hooks", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const cleanup = vi.fn();
		const dispose = registerPostCompactionCleanup("test-cleanup", cleanup);

		try {
			await performCompaction({
				agent,
				sessionManager,
				auto: true,
				customInstructions: "Focus on APIs",
			});
		} finally {
			dispose();
			resetPostCompactionCleanupRegistry();
		}

		expect(cleanup).toHaveBeenCalledWith(
			expect.objectContaining({
				auto: true,
				customInstructions: "Focus on APIs",
				compactedCount: expect.any(Number),
				firstKeptEntryIndex: expect.any(Number),
			}),
		);
	});

	it("returns failure when too few messages", async () => {
		const messages = buildConversation(2); // 4 messages, below keepCount+1=7
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Not enough history");
	});

	it("compacts successfully with sufficient messages", async () => {
		const messages = buildConversation(10); // 20 messages
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		expect(result.compactedCount).toBeGreaterThan(0);
		expect(result.summary).toBeDefined();
		expect(typeof result.summary).toBe("string");
		expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(typeof result.tokensBefore).toBe("number");
		expect(agent.replaceMessages).toHaveBeenCalledOnce();
		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		// Should save summary + resume messages
		expect(sessionManager.saveMessage).toHaveBeenCalledTimes(2);
	});

	it("merges PreCompact hook guidance into the summarization prompt", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService({
			systemMessage: "Preserve unresolved risks.",
			additionalContext: "Pending migration notes remain open.",
		});

		await performCompaction({
			agent,
			sessionManager,
			customInstructions: "Focus on APIs",
			hookService,
		});

		expect(hookService.runPreCompactHooks).toHaveBeenCalledWith(
			"manual",
			1050,
			20000,
			undefined,
		);
		expect(agent.generateSummary).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining("Focus on APIs"),
			expect.any(String),
		);
		expect(agent.generateSummary).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining(
				"Hook system guidance:\nPreserve unresolved risks.",
			),
			expect.any(String),
		);
		expect(agent.generateSummary).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining(
				"Hook context:\nPending migration notes remain open.",
			),
			expect.any(String),
		);
	});

	it("excludes assistant error turns from summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createErrorAssistantMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "assistant",
				stopReason: "error",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: [{ type: "text", text: "provider failed" }],
			}),
		);
	});

	it("downgrades attachments to compact markers in summarization input", async () => {
		const messages = buildConversation(10);
		messages[0] = createUserMessageWithAttachments("see attached context");
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();

		const attachmentMessage = summaryInput?.find(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.includes("see attached context"),
		);
		expect(attachmentMessage).toMatchObject({
			role: "user",
			content: expect.stringContaining("[image]"),
		});
		expect(attachmentMessage).toMatchObject({
			role: "user",
			content: expect.stringContaining("[document]"),
		});
		expect(attachmentMessage).not.toHaveProperty("attachments");
		expect(attachmentMessage).not.toMatchObject({
			content: expect.stringContaining(
				"full document text that should not be in compaction input",
			),
		});
	});

	it("downgrades inline image blocks to compact markers in summarization input", async () => {
		const messages = buildConversation(10);
		messages[0] = createUserMessageWithInlineImage("see screenshot");
		messages.splice(2, 0, createToolResultMessage());
		messages.splice(3, 0, createHookMessageWithInlineImage("hook context"));
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).toContainEqual({
			role: "user",
			content: [
				{ type: "text", text: "see screenshot" },
				{ type: "text", text: "[image]" },
				{ type: "text", text: "before image" },
			],
			timestamp: expect.any(Number),
		});
		expect(summaryInput).toContainEqual({
			role: "toolResult",
			toolCallId: "call-bash",
			toolName: "bash",
			content: [
				{ type: "text", text: "tool output" },
				{ type: "text", text: "[image]" },
			],
			isError: false,
			timestamp: expect.any(Number),
		});
		expect(summaryInput).toContainEqual({
			role: "hookMessage",
			customType: "status",
			content: [
				{ type: "text", text: "hook context" },
				{ type: "text", text: "[image]" },
			],
			display: false,
			timestamp: expect.any(Number),
		});
	});

	it("skips reinjected active skill hooks in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createActiveSkillHookMessage("debug"));
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: "Injected instructions for debug",
			}),
		);
	});

	it("skips PostCompact hook guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createPostCompactHookMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "PostCompact",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: "Re-apply compacted constraints.",
			}),
		);
	});

	it("uses the previous summary preamble without re-summarizing compact summary messages", async () => {
		const messages = buildConversation(10);
		messages.unshift({
			role: "user",
			content:
				"Use the above summary to resume the plan from where we left off.",
			timestamp: Date.now(),
		});
		messages.unshift(createDecoratedCompactionSummaryMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput?.[0]).toMatchObject({
			role: "user",
			content: expect.stringContaining("Previous session summary:\n"),
		});
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining(
							"Another language model started to solve this problem",
						),
					}),
				]),
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "user",
				content:
					"Use the above summary to resume the plan from where we left off.",
			}),
		);
	});

	it("returns failure when a PreCompact hook blocks compaction", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService({
			blocked: true,
			blockReason: "Compaction blocked by test hook",
		});

		const result = await performCompaction({
			agent,
			sessionManager,
			hookService,
		});

		expect(result).toEqual({
			success: false,
			error: "Compaction blocked by test hook",
		});
		expect(agent.generateSummary).not.toHaveBeenCalled();
		expect(sessionManager.saveCompaction).not.toHaveBeenCalled();
	});

	it("runs PostCompact hooks with the generated summary", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService();

		const result = await performCompaction({
			agent,
			sessionManager,
			hookService,
		});

		expect(result.success).toBe(true);
		expect(hookService.runPostCompactHooks).toHaveBeenCalledWith(
			"manual",
			"LLM summary of conversation",
			undefined,
		);
	});

	it("persists PostCompact hook guidance into the compacted transcript", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService();
		(
			hookService.runPostCompactHooks as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			blocked: false,
			preventContinuation: false,
			systemMessage: "Keep using the compacted summary as the source of truth.",
			additionalContext: "The active plan still expects migration cleanup.",
		});

		const result = await performCompaction({
			agent,
			sessionManager,
			hookService,
		});

		expect(result.success).toBe(true);
		const replaced = getReplacedMessages(agent);
		expect(replaced[0]?.role).toBe("assistant");
		expect(replaced[1]?.role).toBe("user");
		expect(replaced.at(-2)).toMatchObject({
			role: "hookMessage",
			customType: "PostCompact",
			content: expect.stringContaining(
				"PostCompact hook system guidance:\nKeep using the compacted summary as the source of truth.",
			),
		});
		expect(replaced.at(-1)).toMatchObject({
			role: "hookMessage",
			customType: "PostCompact",
			content: "The active plan still expects migration cleanup.",
		});
		expect(sessionManager.saveMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "PostCompact",
			}),
		);
	});

	it("ignores unsupported PostCompact control flow output", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService();
		(
			hookService.runPostCompactHooks as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			blocked: true,
			blockReason: "too late to block",
			preventContinuation: true,
			stopReason: "also too late",
		});

		const result = await performCompaction({
			agent,
			sessionManager,
			hookService,
		});

		expect(result.success).toBe(true);
		const replaced = getReplacedMessages(agent);
		expect(replaced[0]?.role).toBe("assistant");
		expect(replaced[1]?.role).toBe("user");
		expect(replaced.at(-1)?.role).not.toBe("hookMessage");
	});

	it("replaced messages start with summary and resume then kept messages", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const replaced = getReplacedMessages(agent);
		// First message is the summary (assistant)
		expect(replaced[0]?.role).toBe("assistant");
		// Second message is the resume prompt (user)
		expect(replaced[1]?.role).toBe("user");
		// Must contain some kept messages from the end
		expect(replaced.length).toBeGreaterThan(2);
	});

	it("clears transient agent state after compaction when supported", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		expect(agent.clearTransientRunState).toHaveBeenCalledOnce();
	});

	it("uses renderSummaryText callback when provided", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const renderSummaryText = vi.fn().mockReturnValue("custom rendered text");

		await performCompaction({
			agent,
			sessionManager,
			renderSummaryText,
		});

		expect(renderSummaryText).toHaveBeenCalledOnce();
		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("custom rendered text");
	});

	it("falls back to local summary when LLM fails", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		(agent.generateSummary as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("API failure"),
		);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("Local summary");
	});

	it("preserves attachment markers in the local summary fallback", async () => {
		const messages = buildConversation(10);
		messages[0] = createUserMessageWithAttachments("see attached context");
		const agent = createMockAgent(messages);
		(agent.generateSummary as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("API failure"),
		);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("[image]");
		expect(firstBlock.text).toContain("[document]");
	});

	it("preserves inline image markers in the local summary fallback", async () => {
		const messages = buildConversation(10);
		messages[0] = createUserMessageWithInlineImage("see screenshot");
		messages.splice(2, 0, createToolResultMessage());
		messages.splice(3, 0, createHookMessageWithInlineImage("hook context"));
		const agent = createMockAgent(messages);
		(agent.generateSummary as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("API failure"),
		);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("see screenshot [image] before image");
		expect(firstBlock.text).toContain("Tool bash: tool output [image]");
	});

	it("retries summary generation after a thrown overflow error", async () => {
		const messages = buildConversation(20);
		const agent = createMockAgent(messages);
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		(agent.generateSummary as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error(overflowMessage))
			.mockResolvedValueOnce(createAssistantMessage("summary after retry"));
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		expect(agent.generateSummary).toHaveBeenCalledTimes(2);
		const firstInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AppMessage[];
		const secondInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[1]?.[0] as AppMessage[];
		expect(secondInput.length).toBeLessThan(firstInput.length);
		expect(secondInput[0]).toMatchObject({
			role: "user",
			content: "[earlier conversation truncated for compaction retry]",
		});

		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("summary after retry");
	});

	it("retries summary generation after an assistant overflow response", async () => {
		const messages = buildConversation(20);
		const agent = createMockAgent(messages);
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		(agent.generateSummary as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(
				createErrorAssistantMessage("still overflowing", overflowMessage),
			)
			.mockResolvedValueOnce(createAssistantMessage("summary after retry"));
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		expect(agent.generateSummary).toHaveBeenCalledTimes(2);
		const firstInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AppMessage[];
		const secondInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[1]?.[0] as AppMessage[];
		expect(secondInput.length).toBeLessThan(firstInput.length);
		expect(secondInput[0]).toMatchObject({
			role: "user",
			content: "[earlier conversation truncated for compaction retry]",
		});
	});

	it("keeps a single truncation marker across repeated overflow retries", async () => {
		const messages = buildConversation(30);
		const agent = createMockAgent(messages);
		const overflowMessage =
			"Anthropic rejected this request because the prompt exceeded 200,000 tokens. Use /compact to summarize prior messages or remove large attachments, then retry.";
		(agent.generateSummary as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error(overflowMessage))
			.mockRejectedValueOnce(new Error(overflowMessage))
			.mockResolvedValueOnce(createAssistantMessage("summary after retry"));
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		expect(agent.generateSummary).toHaveBeenCalledTimes(3);
		const secondInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[1]?.[0] as AppMessage[];
		const thirdInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[2]?.[0] as AppMessage[];
		expect(
			secondInput.filter(
				(message) =>
					message.role === "user" &&
					message.content ===
						"[earlier conversation truncated for compaction retry]",
			),
		).toHaveLength(1);
		expect(
			thirdInput.filter(
				(message) =>
					message.role === "user" &&
					message.content ===
						"[earlier conversation truncated for compaction retry]",
			),
		).toHaveLength(1);
		expect(thirdInput.length).toBeLessThan(secondInput.length);
	});

	it("uses parsed overflow gap to skip multiple turns in one retry", async () => {
		const messages: AppMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(createUserMessage(`message ${i} ${"x".repeat(1000)}`));
			messages.push(
				createAssistantMessage(
					`response ${i} ${"y".repeat(1000)}`,
					createUsage(100 * (i + 1), 50),
				),
			);
		}
		const agent = createMockAgent(messages);
		(agent.generateSummary as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(
				new Error("prompt is too long: 2500 tokens > 1600 maximum"),
			)
			.mockResolvedValueOnce(createAssistantMessage("summary after retry"));
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		expect(agent.generateSummary).toHaveBeenCalledTimes(2);
		const firstInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AppMessage[];
		const secondInput = (agent.generateSummary as ReturnType<typeof vi.fn>).mock
			.calls[1]?.[0] as AppMessage[];
		expect(firstInput.length - secondInput.length).toBeGreaterThanOrEqual(3);
		expect(secondInput[0]).toMatchObject({
			role: "user",
			content: "[earlier conversation truncated for compaction retry]",
		});
	});

	it("passes auto and customInstructions to saveCompaction", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({
			agent,
			sessionManager,
			auto: true,
			customInstructions: "Focus on database changes",
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Number),
			expect.any(Number),
			expect.objectContaining({
				auto: true,
				customInstructions: "Focus on database changes",
			}),
		);
	});

	it("handles edge case where boundary leaves no older messages", async () => {
		// 16 messages with very high token counts — boundary may be pushed high
		const messages: AppMessage[] = [];
		for (let i = 0; i < 8; i++) {
			messages.push(createUserMessage(`msg ${i}`));
			messages.push(
				createAssistantMessage(
					`resp ${i}`,
					createUsage(50000 * (i + 1), 25000),
				),
			);
		}
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });
		// Either succeeds or fails gracefully — no throws
		expect(typeof result.success).toBe("boolean");
	});
});
