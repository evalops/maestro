import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import type {
	AgentEvent,
	AgentTool,
	AgentToolResult,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	StreamOptions,
} from "../../src/agent/types.js";

const mocks = vi.hoisted(() => ({
	createProviderStream: vi.fn(),
}));

vi.mock("../../src/agent/transport/create-provider-stream.js", () => ({
	createProviderStream: mocks.createProviderStream,
}));

const { ProviderTransport } = await import("../../src/agent/transport.js");

const codexModel: Model<"openai-codex-app-server"> = {
	id: "gpt-5.5",
	name: "GPT-5.5 (Codex)",
	api: "openai-codex-app-server",
	provider: "openai-codex",
	baseUrl: "codex-app-server://local",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "delegated" }],
		api: "openai-codex-app-server",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function withTimeout<T>(
	promise: Promise<T>,
	message: string,
	ms = 1000,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout) {
			clearTimeout(timeout);
		}
	});
}

describe("ProviderTransport provider-owned tool events", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("forwards Codex subagent tool events without local tool execution", async () => {
		const localToolExecute = vi.fn(async () => ({
			content: [{ type: "text", text: "local tool should not run" }],
		}));
		const localTool: AgentTool = {
			name: "codex.subagent.spawnAgent",
			description:
				"A local tool with the same visible name as the provider event.",
			parameters: Type.Object({}),
			execute: localToolExecute,
		};
		const assistant = assistantMessage();
		mocks.createProviderStream.mockImplementationOnce(async function* () {
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			yield {
				type: "provider_tool_execution_start",
				toolCallId: "collab-call-1",
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				summaryLabel: "spawn agent 1 agent",
				args: {
					codexTool: "spawnAgent",
					receiverThreadIds: ["child-thread-1"],
				},
				partial: assistant,
			} satisfies AssistantMessageEvent;
			yield {
				type: "provider_tool_execution_end",
				toolCallId: "collab-call-1",
				toolName: "codex.subagent.spawnAgent",
				displayName: "Codex subagent: spawn agent",
				summaryLabel: "spawn agent 1 agent",
				result: {
					role: "toolResult",
					toolCallId: "collab-call-1",
					toolName: "codex.subagent.spawnAgent",
					content: [{ type: "text", text: "Codex subagent completed." }],
					details: {
						codexTool: "spawnAgent",
						receiverThreadIds: ["child-thread-1"],
					},
					isError: false,
					timestamp: 2,
				},
				isError: false,
				partial: assistant,
			} satisfies AssistantMessageEvent;
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport();
		const userMessage: Message = {
			role: "user",
			content: "Delegate this to a Codex subagent.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [localTool],
			model: codexModel,
		})) {
			events.push(event);
		}

		expect(localToolExecute).not.toHaveBeenCalled();
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool_execution_start",
					toolCallId: "collab-call-1",
					toolName: "codex.subagent.spawnAgent",
					displayName: "Codex subagent: spawn agent",
					args: expect.objectContaining({
						codexTool: "spawnAgent",
						receiverThreadIds: ["child-thread-1"],
					}),
				}),
				expect.objectContaining({
					type: "tool_execution_end",
					toolCallId: "collab-call-1",
					toolName: "codex.subagent.spawnAgent",
					isError: false,
					result: expect.objectContaining({
						role: "toolResult",
						toolName: "codex.subagent.spawnAgent",
					}),
				}),
			]),
		);
		const turnEnd = events.find((event) => event.type === "turn_end");
		expect(turnEnd).toMatchObject({
			type: "turn_end",
			toolResults: [],
		});
	});

	it("lets Codex dynamic tool callbacks wait for user approval instead of auto-denying", async () => {
		const approvalService = new ActionApprovalService("prompt");
		const toolExecute = vi.fn(async () => ({
			content: [{ type: "text", text: "mutation completed" }],
		}));
		const destructiveTool: AgentTool = {
			name: "mcp_ticket_update",
			description: "Update an internal ticket.",
			parameters: Type.Object({
				id: Type.String(),
			}),
			annotations: {
				destructiveHint: true,
			},
			execute: toolExecute,
		};
		const assistant = assistantMessage();
		const dynamicResults: AgentToolResult[] = [];
		mocks.createProviderStream.mockImplementationOnce(async function* (
			_model: unknown,
			_context: unknown,
			options: StreamOptions,
		) {
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (!options.executeDynamicTool) {
				throw new Error("expected dynamic tool callback");
			}
			yield {
				type: "provider_tool_execution_start",
				toolCallId: "codex-dynamic-call-1",
				toolName: "mcp_ticket_update",
				displayName: "Codex dynamic tool: mcp_ticket_update",
				summaryLabel: "mcp_ticket_update",
				args: { id: "ABC-123" },
				partial: assistant,
			} satisfies AssistantMessageEvent;
			const dynamicResultPromise = options.executeDynamicTool({
				type: "toolCall",
				id: "codex-dynamic-call-1",
				name: "mcp_ticket_update",
				arguments: { id: "ABC-123" },
			});
			yield {
				type: "text_delta",
				contentIndex: 0,
				delta: "waiting on approval",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			const dynamicResult = await dynamicResultPromise;
			dynamicResults.push(dynamicResult);
			yield {
				type: "provider_tool_execution_end",
				toolCallId: "codex-dynamic-call-1",
				toolName: "mcp_ticket_update",
				displayName: "Codex dynamic tool: mcp_ticket_update",
				summaryLabel: "mcp_ticket_update",
				result: {
					role: "toolResult",
					toolCallId: "codex-dynamic-call-1",
					toolName: "mcp_ticket_update",
					content: dynamicResult.content,
					details: dynamicResult.details,
					isError: dynamicResult.isError === true,
					timestamp: 2,
				},
				isError: dynamicResult.isError === true,
				partial: assistant,
			} satisfies AssistantMessageEvent;
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({ approvalService });
		const userMessage: Message = {
			role: "user",
			content: "Use Codex dynamic tools to update the ticket.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		await withTimeout(
			(async () => {
				for await (const event of transport.run([userMessage], userMessage, {
					systemPrompt: "Be concise.",
					tools: [destructiveTool],
					model: codexModel,
				})) {
					events.push(event);
					if (event.type === "action_approval_required") {
						expect(event.request).toMatchObject({
							id: "codex-dynamic-call-1",
							toolName: "mcp_ticket_update",
							reason: expect.stringContaining("marked as destructive"),
						});
						expect(toolExecute).not.toHaveBeenCalled();
						expect(
							approvalService.approve(event.request.id, "Looks safe"),
						).toBe(true);
					}
				}
			})(),
			"Timed out waiting for Codex dynamic tool approval event",
		);

		expect(toolExecute).toHaveBeenCalledWith(
			"codex-dynamic-call-1",
			{ id: "ABC-123" },
			undefined,
			undefined,
			expect.any(Function),
		);
		expect(dynamicResults).toEqual([
			{
				content: [{ type: "text", text: "mutation completed" }],
				isError: false,
				details: undefined,
			},
		]);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "message_start" }),
				expect.objectContaining({
					type: "tool_execution_start",
					toolCallId: "codex-dynamic-call-1",
					toolName: "mcp_ticket_update",
				}),
				expect.objectContaining({
					type: "action_approval_required",
					request: expect.objectContaining({
						id: "codex-dynamic-call-1",
						toolName: "mcp_ticket_update",
					}),
				}),
				expect.objectContaining({
					type: "message_update",
					assistantMessageEvent: expect.objectContaining({
						type: "text_delta",
						delta: "waiting on approval",
					}),
				}),
				expect.objectContaining({
					type: "action_approval_resolved",
					request: expect.objectContaining({ id: "codex-dynamic-call-1" }),
					decision: expect.objectContaining({
						approved: true,
						resolvedBy: "user",
					}),
				}),
				expect.objectContaining({
					type: "tool_execution_end",
					toolCallId: "codex-dynamic-call-1",
					toolName: "mcp_ticket_update",
					isError: false,
				}),
				expect.objectContaining({ type: "turn_end" }),
			]),
		);
		const approvalResolvedIndex = events.findIndex(
			(event) => event.type === "action_approval_resolved",
		);
		const toolExecutionEndIndex = events.findIndex(
			(event) =>
				event.type === "tool_execution_end" &&
				event.toolCallId === "codex-dynamic-call-1",
		);
		expect(approvalResolvedIndex).toBeGreaterThan(-1);
		expect(toolExecutionEndIndex).toBeGreaterThan(approvalResolvedIndex);
	});
});
