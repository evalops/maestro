/**
 * Tests for performCompaction() — the consolidated compaction function.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	registerPostCompactionCleanup,
	resetPostCompactionCleanupRegistry,
} from "../../src/agent/compaction-cleanup.js";
import type { CompactionHookService } from "../../src/agent/compaction-hooks.js";
import {
	collectMcpMessagesForCompaction,
	collectPlanMessagesForCompaction,
} from "../../src/agent/compaction-restoration.js";
import {
	type CompactionAgent,
	type CompactionSessionManager,
	performCompaction,
} from "../../src/agent/compaction.js";
import {
	clearPlanModeState,
	enterPlanMode,
	exitPlanMode,
} from "../../src/agent/plan-mode.js";
import type {
	AppMessage,
	AssistantMessage,
	Attachment,
	Usage,
} from "../../src/agent/types.js";
import { clearConfigCache } from "../../src/config/index.js";

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

function createReadToolCallMessage(
	filePath = "/tmp/notes.md",
	toolCallId = "call-read",
): AssistantMessage {
	return {
		...createAssistantMessage("reading file"),
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "read",
				arguments: { path: filePath },
			},
		],
	};
}

function createReadToolResultMessage(
	filePath = "/tmp/notes.md",
	toolCallId = "call-read",
	text = `contents of ${filePath}`,
): AppMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSkillToolCallMessage(
	skill = "my-skill",
	toolCallId = "call-skill",
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "Skill",
				arguments: { skill },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage: createUsage(120, 30),
		stopReason: "tool_use",
		timestamp: Date.now(),
	};
}

function createSkillToolResultMessage(
	skill = "my-skill",
	toolCallId = "call-skill",
	content = "# Skill: my-skill\n\n> Test skill\n\n## Instructions\n\nFollow the skill instructions.",
): AppMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "Skill",
		content: [{ type: "text", text: content.replaceAll("my-skill", skill) }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createReadRestoreHookMessage(
	filePath = "/tmp/notes.md",
	text = "contents of /tmp/notes.md",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "read-file",
		content: [
			{
				type: "text",
				text: [
					"# Recently read file restored after compaction",
					"",
					`File: ${filePath}`,
					"",
					"Last read result:",
				].join("\n"),
			},
			{ type: "text", text },
		],
		display: false,
		details: { filePath },
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

function createRestoredSkillHookMessage(
	name = "reviewer",
	content = "# Skill: reviewer\n\n> Review specialist\n\n## Instructions\n\nInspect the diff for regressions.",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "skill",
		content: [{ type: "text", text: content.replaceAll("reviewer", name) }],
		display: false,
		details: { name, source: "tool" },
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

function createSessionStartHookMessage(
	content = "Restored compacted repo context.",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "SessionStart",
		content,
		display: true,
		timestamp: Date.now(),
	};
}

function createBackgroundTasksHookMessage(
	content = "# Background tasks restored after compaction\n\n- id=task-running; status=running; shell=exec; cwd=/tmp/app; command=npm run dev",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "background-tasks",
		content,
		display: false,
		timestamp: Date.now(),
	};
}

function createMcpServersHookMessage(
	content = "# Connected MCP servers restored after compaction\n\n- context7; transport=stdio; tools=2; resources=1; prompts=0",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "mcp-servers",
		content,
		display: false,
		timestamp: Date.now(),
	};
}

function createPlanModeHookMessage(
	content = "Plan file: /tmp/plan.md",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "plan-mode",
		content,
		display: false,
		details: { filePath: "/tmp/plan.md" },
		timestamp: Date.now(),
	};
}

function createPlanFileHookMessage(
	content = "# Active plan file restored after compaction\n\nPlan file: /tmp/plan.md\n\nCurrent plan contents:\n# Plan",
	filePath = "/tmp/plan.md",
): AppMessage {
	return {
		role: "hookMessage",
		customType: "plan-file",
		content,
		display: false,
		details: { filePath },
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

function createMockAgent(
	messages: AppMessage[],
	options?: { systemPromptSourcePaths?: string[] },
): CompactionAgent {
	const state = {
		messages: [...messages],
		model: {
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			id: "claude-3-5-sonnet",
		},
		systemPromptSourcePaths: options?.systemPromptSourcePaths,
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

function createMockAgentWithoutAppendMessage(
	messages: AppMessage[],
	options?: { systemPromptSourcePaths?: string[] },
): CompactionAgent {
	const state = {
		messages: [...messages],
		model: {
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			id: "claude-3-5-sonnet",
		},
		systemPromptSourcePaths: options?.systemPromptSourcePaths,
	};
	return {
		state,
		generateSummary: vi
			.fn()
			.mockResolvedValue(createAssistantMessage("LLM summary of conversation")),
		replaceMessages: vi.fn((nextMessages: AppMessage[]) => {
			state.messages = [...nextMessages];
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

	it("skips successful Skill tool results in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createSkillToolCallMessage("reviewer", "call-skill-reviewer"),
			createSkillToolResultMessage(
				"reviewer",
				"call-skill-reviewer",
				"# Skill: reviewer\n\n> Review specialist\n\n## Instructions\n\nInspect the diff for regressions.",
			),
		);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolName: "Skill",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: expect.arrayContaining([
					expect.objectContaining({
						text: expect.stringContaining("Inspect the diff for regressions."),
					}),
				]),
			}),
		);
		expect(getReplacedMessages(agent)).toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
				details: { name: "reviewer", source: "tool" },
			}),
		);
	});

	it("skips read tool results that will be restored after compaction", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createReadToolCallMessage("/tmp/restored.ts", "call-read-restore"),
			createReadToolResultMessage(
				"/tmp/restored.ts",
				"call-read-restore",
				"export const restored = true;",
			),
		);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolName: "read",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: [
					{
						type: "text",
						text: "export const restored = true;",
					},
				],
			}),
		);
		expect(getReplacedMessages(agent)).toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "read-file",
				details: { filePath: "/tmp/restored.ts" },
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

	it("skips SessionStart hook guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createSessionStartHookMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: "Restored compacted repo context.",
			}),
		);
	});

	it("skips background task restoration guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createBackgroundTasksHookMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "background-tasks",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: expect.stringContaining(
					"Background tasks restored after compaction",
				),
			}),
		);
	});

	it("replaces stale background task restoration messages in the kept tail", async () => {
		const messages = [
			...buildConversation(10),
			createBackgroundTasksHookMessage(
				"# Background tasks restored after compaction\n\n- id=task-running; status=running; shell=exec; cwd=/tmp/app; command=npm run dev",
			),
		];
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({
			agent,
			sessionManager,
			getPostKeepMessages: async () => [
				createBackgroundTasksHookMessage(
					"# Background tasks restored after compaction\n\n- id=task-running; status=restarting; shell=exec; cwd=/tmp/app; command=npm run dev",
				),
			],
		});

		const backgroundMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" &&
				message.customType === "background-tasks",
		);
		expect(backgroundMessages).toHaveLength(1);
		expect(backgroundMessages[0]).toEqual(
			expect.objectContaining({
				content: expect.stringContaining("status=restarting"),
			}),
		);
		expect(backgroundMessages[0]).not.toEqual(
			expect.objectContaining({
				content: expect.stringContaining("status=running"),
			}),
		);
	});

	it("skips MCP restoration guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createMcpServersHookMessage(
				[
					"# Connected MCP servers restored after compaction",
					"",
					"- context7; transport=stdio; tools=2; resources=1; prompts=0",
				].join("\n"),
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();
		const generateSummary = vi
			.spyOn(agent, "generateSummary")
			.mockResolvedValue(createAssistantMessage("LLM summary"));

		await performCompaction({ agent, sessionManager });

		const summaryInput = generateSummary.mock.calls[0]?.[0] ?? [];
		expect(JSON.stringify(summaryInput)).not.toContain(
			"Connected MCP servers restored after compaction",
		);
	});

	it("replaces stale MCP restoration messages in the kept tail", async () => {
		const messages = buildConversation(10);
		messages.splice(
			10,
			0,
			createMcpServersHookMessage(
				"# Connected MCP servers restored after compaction\n\n- context7; transport=stdio; tools=1; resources=0; prompts=0",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({
			agent,
			sessionManager,
			getPostKeepMessages: async () => [
				createMcpServersHookMessage(
					"# Connected MCP servers restored after compaction\n\n- context7; transport=stdio; tools=2; resources=1; prompts=0",
				),
			],
		});

		const mcpMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "mcp-servers",
		);
		expect(mcpMessages).toHaveLength(1);
		expect(mcpMessages[0]).toEqual(
			expect.objectContaining({
				content: expect.stringContaining("tools=2; resources=1"),
			}),
		);
		expect(mcpMessages[0]).not.toEqual(
			expect.objectContaining({
				content: expect.stringContaining("tools=1; resources=0"),
			}),
		);
	});

	it("skips plan-mode restoration guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createPlanModeHookMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "plan-mode",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: "Plan file: /tmp/plan.md",
			}),
		);
	});

	it("skips plan-file restoration guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createPlanFileHookMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "plan-file",
			}),
		);
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				content: expect.stringContaining("Current plan contents:"),
			}),
		);
	});

	it("skips restored read-file guidance in summarization input", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createReadRestoreHookMessage());
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const summaryInput = (agent.generateSummary as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as AppMessage[] | undefined;
		expect(summaryInput).toBeDefined();
		expect(summaryInput).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "read-file",
			}),
		);
		expect(
			summaryInput?.some(
				(message) =>
					message.role === "hookMessage" &&
					Array.isArray(message.content) &&
					message.content.some(
						(part) =>
							part.type === "text" &&
							part.text.includes(
								"Recently read file restored after compaction",
							),
					),
			),
		).toBe(false);
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

	it("inserts compact restoration messages before PostCompact hook guidance", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();
		const hookService = createMockHookService();
		(
			hookService.runPostCompactHooks as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			blocked: false,
			preventContinuation: false,
			systemMessage: "Keep using the compacted summary as the source of truth.",
		});

		const result = await performCompaction({
			agent,
			sessionManager,
			hookService,
			getPostKeepMessages: async () => [createSessionStartHookMessage()],
		});

		expect(result.success).toBe(true);
		const replaced = getReplacedMessages(agent);
		const sessionStartIndex = replaced.findIndex(
			(message) =>
				message.role === "hookMessage" && message.customType === "SessionStart",
		);
		const postCompactIndex = replaced.findIndex(
			(message) =>
				message.role === "hookMessage" && message.customType === "PostCompact",
		);
		expect(sessionStartIndex).toBeGreaterThan(1);
		expect(postCompactIndex).toBeGreaterThan(sessionStartIndex);
		expect(sessionManager.saveMessage).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				role: "hookMessage",
				customType: "SessionStart",
			}),
		);
		expect(sessionManager.saveMessage).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({
				role: "hookMessage",
				customType: "PostCompact",
			}),
		);
	});

	it("restores recent read results before caller post-keep messages", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createReadToolCallMessage("/tmp/restored.ts", "call-read-restore"),
			createReadToolResultMessage(
				"/tmp/restored.ts",
				"call-read-restore",
				"export const restored = true;",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({
			agent,
			sessionManager,
			getPostKeepMessages: async () => [createSessionStartHookMessage()],
		});

		expect(result.success).toBe(true);
		const replaced = getReplacedMessages(agent);
		const readRestoreIndex = replaced.findIndex(
			(message) =>
				message.role === "hookMessage" && message.customType === "read-file",
		);
		const sessionStartIndex = replaced.findIndex(
			(message) =>
				message.role === "hookMessage" && message.customType === "SessionStart",
		);
		expect(readRestoreIndex).toBeGreaterThan(1);
		expect(sessionStartIndex).toBeGreaterThan(readRestoreIndex);
		expect(replaced[readRestoreIndex]).toMatchObject({
			role: "hookMessage",
			customType: "read-file",
			display: false,
			details: { filePath: "/tmp/restored.ts" },
		});
	});

	it("restores up to five recent read results after compaction", async () => {
		const messages = buildConversation(10);
		for (let i = 0; i < 5; i += 1) {
			messages.splice(
				2 + i * 2,
				0,
				createReadToolCallMessage(`/tmp/restored-${i}.ts`, `call-read-${i}`),
				createReadToolResultMessage(
					`/tmp/restored-${i}.ts`,
					`call-read-${i}`,
					`export const restored${i} = true;`,
				),
			);
		}
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const restoredReadMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "read-file",
		);
		expect(restoredReadMessages).toHaveLength(5);
	});

	it("re-restores prior hidden read-file context across repeated compactions", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createReadRestoreHookMessage(
				"/tmp/restored-twice.ts",
				"export const restoredTwice = true;",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const restoredReadMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "read-file",
		);
		expect(restoredReadMessages).toHaveLength(1);
		expect(restoredReadMessages[0]).toMatchObject({
			role: "hookMessage",
			customType: "read-file",
			display: false,
			details: { filePath: "/tmp/restored-twice.ts" },
		});
		expect(JSON.stringify(restoredReadMessages[0]?.content)).toContain(
			"restoredTwice = true",
		);
	});

	it("refreshes restored read results from disk instead of replaying stale output", async () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "maestro-read-restore-")),
			"restored.ts",
		);
		writeFileSync(filePath, "export const restored = 'fresh';\n");

		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createReadToolCallMessage(filePath, "call-read-refresh"),
			createReadToolResultMessage(
				filePath,
				"call-read-refresh",
				"export const restored = 'stale';",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const readRestore = getReplacedMessages(agent).find(
			(message) =>
				message.role === "hookMessage" &&
				message.customType === "read-file" &&
				message.details?.filePath === filePath,
		);
		expect(readRestore).toBeDefined();
		const readRestoreText = JSON.stringify(readRestore?.content);
		expect(readRestoreText).toContain("fresh");
		expect(readRestoreText).not.toContain("stale");
	});

	it("does not restore read results that are still visible in the kept tail", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createReadToolCallMessage("/tmp/shared.ts", "call-read-old"),
			createReadToolResultMessage(
				"/tmp/shared.ts",
				"call-read-old",
				"old visible contents",
			),
		);
		messages.splice(
			messages.length - 2,
			0,
			createReadToolCallMessage("/tmp/shared.ts", "call-read-new"),
			createReadToolResultMessage(
				"/tmp/shared.ts",
				"call-read-new",
				"new visible contents",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		expect(getReplacedMessages(agent)).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "read-file",
			}),
		);
	});

	it("does not restore agent context files that are already layered into the prompt", async () => {
		const originalCwd = process.cwd();
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-agent-context-"));
		const agentContextPath = join(workspaceDir, "AGENTS.md");
		writeFileSync(agentContextPath, "# AGENTS\nProject instructions");
		process.chdir(workspaceDir);
		clearConfigCache();

		try {
			const messages = buildConversation(10);
			messages.splice(
				2,
				0,
				createReadToolCallMessage(agentContextPath, "call-read-agents"),
				createReadToolResultMessage(
					agentContextPath,
					"call-read-agents",
					"# AGENTS\nProject instructions",
				),
			);
			const agent = createMockAgentWithoutAppendMessage(messages);
			const sessionManager = createMockSessionManager();

			const result = await performCompaction({ agent, sessionManager });

			expect(result.success).toBe(true);
			expect(getReplacedMessages(agent)).not.toContainEqual(
				expect.objectContaining({
					role: "hookMessage",
					customType: "read-file",
					details: { filePath: agentContextPath },
				}),
			);
		} finally {
			process.chdir(originalCwd);
			clearConfigCache();
		}
	});

	it("does not restore custom project doc fallback files already layered into the prompt", async () => {
		const originalCwd = process.cwd();
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-project-doc-"));
		mkdirSync(join(workspaceDir, ".maestro"), { recursive: true });
		const contextPath = join(workspaceDir, "CONTEXT.md");
		writeFileSync(contextPath, "# Context\nCurrent project instructions");
		writeFileSync(
			join(workspaceDir, ".maestro", "config.toml"),
			'project_doc_fallback_filenames = ["CONTEXT.md"]\n',
		);
		process.chdir(workspaceDir);
		clearConfigCache();

		try {
			const messages = buildConversation(10);
			messages.splice(
				2,
				0,
				createReadToolCallMessage(contextPath, "call-read-context-doc"),
				createReadToolResultMessage(
					contextPath,
					"call-read-context-doc",
					"# Context\nCustom project instructions",
				),
			);
			const agent = createMockAgentWithoutAppendMessage(messages);
			const sessionManager = createMockSessionManager();

			const result = await performCompaction({ agent, sessionManager });

			expect(result.success).toBe(true);
			expect(getReplacedMessages(agent)).not.toContainEqual(
				expect.objectContaining({
					role: "hookMessage",
					customType: "read-file",
					details: { filePath: contextPath },
				}),
			);
		} finally {
			process.chdir(originalCwd);
			clearConfigCache();
		}
	});

	it("restores nested fallback-named files that are not prompt-loaded project docs", async () => {
		const originalCwd = process.cwd();
		const workspaceDir = mkdtempSync(
			join(tmpdir(), "maestro-nested-project-doc-"),
		);
		const nestedDir = join(workspaceDir, "docs");
		const nestedContextPath = join(nestedDir, "CONTEXT.md");
		mkdirSync(join(workspaceDir, ".maestro"), { recursive: true });
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(
			join(workspaceDir, ".maestro", "config.toml"),
			'project_doc_fallback_filenames = ["CONTEXT.md"]\n',
		);
		writeFileSync(nestedContextPath, "# Context\nNested file contents");
		process.chdir(workspaceDir);
		clearConfigCache();

		try {
			const messages = buildConversation(10);
			messages.splice(
				2,
				0,
				createReadToolCallMessage(
					nestedContextPath,
					"call-read-nested-context-doc",
				),
				createReadToolResultMessage(
					nestedContextPath,
					"call-read-nested-context-doc",
					"# Context\nStale nested file contents",
				),
			);
			const agent = createMockAgentWithoutAppendMessage(messages);
			const sessionManager = createMockSessionManager();

			const result = await performCompaction({ agent, sessionManager });

			expect(result.success).toBe(true);
			expect(getReplacedMessages(agent)).toContainEqual(
				expect.objectContaining({
					role: "hookMessage",
					customType: "read-file",
					details: { filePath: nestedContextPath },
					content: expect.arrayContaining([
						expect.objectContaining({
							text: expect.stringContaining("Nested file contents"),
						}),
					]),
				}),
			);
		} finally {
			process.chdir(originalCwd);
			clearConfigCache();
		}
	});

	it("does not restore append system prompt files already layered into the prompt", async () => {
		const originalCwd = process.cwd();
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-append-system-"));
		const appendSystemPath = join(workspaceDir, ".maestro", "APPEND_SYSTEM.md");
		mkdirSync(join(workspaceDir, ".maestro"), { recursive: true });
		writeFileSync(appendSystemPath, "Append these extra system instructions.");
		process.chdir(workspaceDir);
		clearConfigCache();

		try {
			const messages = buildConversation(10);
			messages.splice(
				2,
				0,
				createReadToolCallMessage(
					appendSystemPath,
					"call-read-append-system-prompt",
				),
				createReadToolResultMessage(
					appendSystemPath,
					"call-read-append-system-prompt",
					"Append these extra system instructions.",
				),
			);
			const agent = createMockAgentWithoutAppendMessage(messages);
			const sessionManager = createMockSessionManager();

			const result = await performCompaction({ agent, sessionManager });

			expect(result.success).toBe(true);
			expect(getReplacedMessages(agent)).not.toContainEqual(
				expect.objectContaining({
					role: "hookMessage",
					customType: "read-file",
					details: { filePath: appendSystemPath },
				}),
			);
		} finally {
			process.chdir(originalCwd);
			clearConfigCache();
		}
	});

	it("does not restore explicit system prompt files already layered into the prompt", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-system-prompt-"));
		const promptsDir = join(workspaceDir, "prompts");
		const systemPromptPath = join(promptsDir, "custom-system.md");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(systemPromptPath, "Follow the custom system prompt.");

		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createReadToolCallMessage(
				systemPromptPath,
				"call-read-explicit-system-prompt",
			),
			createReadToolResultMessage(
				systemPromptPath,
				"call-read-explicit-system-prompt",
				"Follow the custom system prompt.",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages, {
			systemPromptSourcePaths: [systemPromptPath],
		});
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		expect(getReplacedMessages(agent)).not.toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "read-file",
				details: { filePath: systemPromptPath },
			}),
		);
	});

	it("does not restore tracked plan files through read-file restore when plan restoration already covers them", async () => {
		const originalCwd = process.cwd();
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-plan-read-"));
		const planDir = join(workspaceDir, ".maestro", "plans");
		const previousPlanDir = process.env.MAESTRO_PLAN_DIR;
		const previousPlanFile = process.env.MAESTRO_PLAN_FILE;
		process.chdir(workspaceDir);
		process.env.MAESTRO_PLAN_DIR = planDir;
		process.env.MAESTRO_PLAN_FILE = join(planDir, "tracked-plan.md");
		clearConfigCache();

		try {
			const state = enterPlanMode({ name: "Tracked plan" });
			writeFileSync(state.filePath, "# Plan\n\n1. Ship the fix");
			exitPlanMode();

			const messages = buildConversation(10);
			messages.splice(
				2,
				0,
				createReadToolCallMessage(state.filePath, "call-read-plan"),
				createReadToolResultMessage(
					state.filePath,
					"call-read-plan",
					"# Plan\n\nStale plan snapshot",
				),
			);
			const agent = createMockAgentWithoutAppendMessage(messages);
			const sessionManager = createMockSessionManager();
			const planMessages = collectPlanMessagesForCompaction([]);

			expect(planMessages).toContainEqual(
				expect.objectContaining({
					role: "hookMessage",
					customType: "plan-file",
					details: { filePath: state.filePath },
					content: expect.stringContaining("Ship the fix"),
				}),
			);

			const result = await performCompaction({ agent, sessionManager });

			expect(result.success).toBe(true);
			expect(getReplacedMessages(agent)).not.toContainEqual(
				expect.objectContaining({
					role: "hookMessage",
					customType: "read-file",
					details: { filePath: state.filePath },
				}),
			);
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
			process.chdir(originalCwd);
			clearConfigCache();
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("re-restores prior hidden plan-file context across repeated compactions", async () => {
		const originalCwd = process.cwd();
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-plan-repeat-"));
		const planDir = join(workspaceDir, ".maestro", "plans");
		const previousPlanDir = process.env.MAESTRO_PLAN_DIR;
		const previousPlanFile = process.env.MAESTRO_PLAN_FILE;
		process.chdir(workspaceDir);
		process.env.MAESTRO_PLAN_DIR = planDir;
		process.env.MAESTRO_PLAN_FILE = join(planDir, "tracked-plan.md");
		clearConfigCache();

		try {
			const state = enterPlanMode({ name: "Repeated plan" });
			writeFileSync(state.filePath, "# Plan\n\n1. Ship the current fix");
			exitPlanMode();

			const messages = buildConversation(10);
			messages.splice(
				2,
				0,
				createPlanFileHookMessage(
					`# Active plan file restored after compaction

Plan file: ${state.filePath}

Current plan contents:
# Plan

1. Stale snapshot`,
					state.filePath,
				),
			);
			const agent = createMockAgentWithoutAppendMessage(messages);
			const sessionManager = createMockSessionManager();

			const result = await performCompaction({
				agent,
				sessionManager,
				getPostKeepMessages: async (preservedMessages) =>
					collectPlanMessagesForCompaction(preservedMessages),
			});

			expect(result.success).toBe(true);
			const restoredPlanMessages = getReplacedMessages(agent).filter(
				(message) =>
					message.role === "hookMessage" && message.customType === "plan-file",
			);
			expect(restoredPlanMessages).toHaveLength(1);
			expect(restoredPlanMessages[0]).toMatchObject({
				role: "hookMessage",
				customType: "plan-file",
				display: false,
				details: { filePath: state.filePath },
			});
			expect(String(restoredPlanMessages[0]?.content)).toContain(
				"Ship the current fix",
			);
			expect(String(restoredPlanMessages[0]?.content)).not.toContain(
				"Stale snapshot",
			);
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
			process.chdir(originalCwd);
			clearConfigCache();
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("restores recently loaded skills after compaction", async () => {
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createSkillToolCallMessage("reviewer", "call-skill-reviewer"),
			createSkillToolResultMessage(
				"reviewer",
				"call-skill-reviewer",
				"# Skill: reviewer\n\n> Review specialist\n\n## Instructions\n\nInspect the diff for regressions.",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		expect(getReplacedMessages(agent)).toContainEqual(
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
				display: false,
				details: { name: "reviewer", source: "tool" },
				content: expect.arrayContaining([
					expect.objectContaining({
						text: expect.stringContaining("Inspect the diff for regressions."),
					}),
				]),
			}),
		);
	});

	it("re-restores prior hidden tool skill context across repeated compactions", async () => {
		const messages = buildConversation(10);
		messages.splice(2, 0, createRestoredSkillHookMessage("reviewer"));
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const restoredSkillMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "skill",
		);
		expect(restoredSkillMessages).toHaveLength(1);
		expect(restoredSkillMessages[0]).toMatchObject({
			role: "hookMessage",
			customType: "skill",
			display: false,
			details: { name: "reviewer", source: "tool" },
		});
		expect(JSON.stringify(restoredSkillMessages[0]?.content)).toContain(
			"Inspect the diff for regressions.",
		);
	});

	it("re-restores prior hidden MCP context across repeated compactions", async () => {
		const servers = [
			{
				name: "context7",
				connected: true,
				transport: "stdio",
				tools: [{ name: "resolve" }, { name: "get-docs" }],
				resources: ["lib://react"],
				prompts: [],
			},
		] as const;
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createMcpServersHookMessage(
				"# Connected MCP servers restored after compaction\n\n- context7; transport=stdio; tools=1; resources=0; prompts=0",
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({
			agent,
			sessionManager,
			getPostKeepMessages: async (preservedMessages) =>
				collectMcpMessagesForCompaction(preservedMessages, servers),
		});

		expect(result.success).toBe(true);
		const restoredMcpMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "mcp-servers",
		);
		expect(restoredMcpMessages).toHaveLength(1);
		expect(String(restoredMcpMessages[0]?.content)).toContain(
			"tools=2; resources=1",
		);
		expect(String(restoredMcpMessages[0]?.content)).not.toContain(
			"tools=1; resources=0",
		);
	});

	it("restores up to five recently loaded skills after compaction", async () => {
		const messages = buildConversation(10);
		for (let i = 0; i < 5; i += 1) {
			messages.splice(
				2 + i * 2,
				0,
				createSkillToolCallMessage(`skill-${i}`, `call-skill-${i}`),
				createSkillToolResultMessage(
					`skill-${i}`,
					`call-skill-${i}`,
					`# Skill: skill-${i}\n\n> Skill ${i}\n\n## Instructions\n\nFollow skill ${i}.`,
				),
			);
		}
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const restoredSkillMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "skill",
		);
		expect(restoredSkillMessages).toHaveLength(5);
	});

	it("restores more than five small skills when they fit under the token budget", async () => {
		const messages = buildConversation(10);
		for (let i = 0; i < 6; i += 1) {
			messages.splice(
				2 + i * 2,
				0,
				createSkillToolCallMessage(`skill-${i}`, `call-skill-${i}`),
				createSkillToolResultMessage(
					`skill-${i}`,
					`call-skill-${i}`,
					`# Skill: skill-${i}\n\n> Skill ${i}\n\n## Instructions\n\nFollow skill ${i}.`,
				),
			);
		}
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const restoredSkillMessages = getReplacedMessages(agent).filter(
			(message) =>
				message.role === "hookMessage" && message.customType === "skill",
		);
		expect(restoredSkillMessages).toHaveLength(6);
	});

	it("deduplicates restored skills against caller post-keep skill messages", async () => {
		const skillContent =
			"# Skill: reviewer\n\n> Review specialist\n\n## Instructions\n\nInspect the diff for regressions.";
		const messages = buildConversation(10);
		messages.splice(
			2,
			0,
			createSkillToolCallMessage("reviewer", "call-skill-reviewer"),
			createSkillToolResultMessage(
				"reviewer",
				"call-skill-reviewer",
				skillContent,
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({
			agent,
			sessionManager,
			getPostKeepMessages: async () => [
				{
					role: "hookMessage",
					customType: "skill",
					content: skillContent,
					display: false,
					details: { name: "reviewer" },
					timestamp: Date.now(),
				},
			],
		});

		expect(result.success).toBe(true);
		expect(
			getReplacedMessages(agent).filter(
				(message) =>
					message.role === "hookMessage" &&
					message.customType === "skill" &&
					typeof message.details === "object" &&
					message.details !== null &&
					"name" in message.details &&
					message.details.name === "reviewer",
			),
		).toHaveLength(1);
	});

	it("truncates oversized restored read results to the per-file budget", async () => {
		const messages = buildConversation(10);
		const oversizedContent = `${"x".repeat(30_000)}TRUNCATE_ME_SUFFIX`;
		messages.splice(
			2,
			0,
			createReadToolCallMessage("/tmp/large.ts", "call-read-large"),
			createReadToolResultMessage(
				"/tmp/large.ts",
				"call-read-large",
				oversizedContent,
			),
		);
		const agent = createMockAgentWithoutAppendMessage(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const readRestore = getReplacedMessages(agent).find(
			(message) =>
				message.role === "hookMessage" &&
				message.customType === "read-file" &&
				message.details?.filePath === "/tmp/large.ts",
		);
		expect(readRestore).toBeDefined();
		expect(JSON.stringify(readRestore?.content)).toContain(
			"restored read result truncated for compaction",
		);
		expect(JSON.stringify(readRestore?.content)).not.toContain(
			"TRUNCATE_ME_SUFFIX",
		);
	});

	it("keeps PostCompact hook guidance after preserved messages without appendMessage", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgentWithoutAppendMessage(messages);
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
		expect(replaced.at(-3)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "response 9" }],
		});
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
