import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import type { PlatformToolExecutionBridge } from "../../src/agent/transport/tool-execution-bridge.js";
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
import {
	clearEventBuffer,
	onSecurityEvent,
} from "../../src/telemetry/security-events.js";

const mocks = vi.hoisted(() => ({
	createProviderStream: vi.fn(),
}));

vi.mock("../../src/agent/transport/create-provider-stream.js", () => ({
	createProviderStream: mocks.createProviderStream,
}));

const { ProviderTransport } = await import("../../src/agent/transport.js");
const { StreamIdleTimeoutError } = await import(
	"../../src/providers/stream-idle-timeout.js"
);

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

function createObservingPlatformBridge(): {
	bridge: PlatformToolExecutionBridge;
	recordObservation: ReturnType<typeof vi.fn>;
} {
	const recordObservation = vi.fn(async (_plan, result) => ({
		metadata: {
			toolExecutionId: `observed:${result.toolCallId}`,
			approvalRequestId: `approval:${result.toolCallId}`,
		},
	}));
	return {
		bridge: {
			prepare: vi.fn(async (input) => ({
				status: "observe",
				plan: {
					kind: "observe",
					mode: "observe",
					classification: {} as never,
					config: {} as never,
					request: {
						metadata: {
							maestro_tool_call_id: input.toolCall.id,
						},
					} as never,
					metadata: {
						toolExecutionId: `prepared:${input.toolCall.id}`,
					},
				},
			})),
			resolveApproval: vi.fn(async (_input, plan) => ({
				status: "allow",
				plan,
			})),
			recordObservation,
			recordGovernedOutput: vi.fn(async (_plan, result) => ({
				metadata: {
					toolExecutionId: `governed:${result.toolCallId}`,
					approvalRequestId: `approval:${result.toolCallId}`,
				},
			})),
		},
		recordObservation,
	};
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
					type: "message_start",
					message: expect.objectContaining({
						role: "toolResult",
						toolCallId: "collab-call-1",
						toolName: "codex.subagent.spawnAgent",
					}),
				}),
				expect.objectContaining({
					type: "message_end",
					message: expect.objectContaining({
						role: "toolResult",
						toolCallId: "collab-call-1",
						toolName: "codex.subagent.spawnAgent",
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
			toolResults: [
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "collab-call-1",
					toolName: "codex.subagent.spawnAgent",
				}),
			],
		});
	});

	it("preserves provider-owned tool results when local tool calls run in the same turn", async () => {
		const localToolExecute = vi.fn(async () => ({
			content: [{ type: "text", text: "local read completed" }],
		}));
		const localTool: AgentTool = {
			name: "read",
			description: "Read a file locally.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: localToolExecute,
		};
		let streamCount = 0;
		let secondTurnMessages: Message[] | undefined;
		mocks.createProviderStream.mockImplementation(async function* (
			_model: unknown,
			context: { messages: Message[] },
		) {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = {
					...assistantMessage(),
					content: [],
					stopReason: "tool_use",
					timestamp: 1,
				};
				yield {
					type: "start",
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
						isError: false,
						timestamp: 2,
					},
					isError: false,
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "toolcall_end",
					toolCall: {
						id: "read-call-1",
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "done",
					reason: "tool_use",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			secondTurnMessages = context.messages;
			const assistant = {
				...assistantMessage(),
				content: [{ type: "text" as const, text: "done" }],
				stopReason: "stop",
				timestamp: 3,
			};
			yield {
				type: "start",
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
			content: "Delegate and then read the file.",
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

		expect(localToolExecute).toHaveBeenCalledTimes(1);
		const turnEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "turn_end" }> =>
				event.type === "turn_end",
		);
		expect(turnEnds[0]).toMatchObject({
			type: "turn_end",
			toolResults: [
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "collab-call-1",
					toolName: "codex.subagent.spawnAgent",
				}),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "read-call-1",
					toolName: "read",
				}),
			],
		});
		expect(secondTurnMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "collab-call-1",
					toolName: "codex.subagent.spawnAgent",
				}),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "read-call-1",
					toolName: "read",
				}),
			]),
		);
	});

	it("drops provider-owned tool results from abandoned stream retry attempts", async () => {
		const localToolExecute = vi.fn(async () => ({
			content: [{ type: "text", text: "local read completed" }],
		}));
		const localTool: AgentTool = {
			name: "read",
			description: "Read a file locally.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: localToolExecute,
		};
		let streamCount = 0;
		let secondTurnMessages: Message[] | undefined;
		mocks.createProviderStream.mockImplementation(async function* (
			_model: unknown,
			context: { messages: Message[] },
		) {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = {
					...assistantMessage(),
					content: [],
					stopReason: "tool_use",
					timestamp: 1,
				};
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "provider_tool_execution_end",
					toolCallId: "stale-provider-call",
					toolName: "codex.subagent.spawnAgent",
					result: {
						role: "toolResult",
						toolCallId: "stale-provider-call",
						toolName: "codex.subagent.spawnAgent",
						content: [{ type: "text", text: "abandoned result" }],
						isError: false,
						timestamp: 2,
					},
					isError: false,
					partial: assistant,
				} satisfies AssistantMessageEvent;
				throw new StreamIdleTimeoutError(1, "openai-codex");
			}

			if (streamCount === 2) {
				const assistant = {
					...assistantMessage(),
					content: [],
					stopReason: "tool_use",
					timestamp: 3,
				};
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "provider_tool_execution_end",
					toolCallId: "fresh-provider-call",
					toolName: "codex.subagent.spawnAgent",
					result: {
						role: "toolResult",
						toolCallId: "fresh-provider-call",
						toolName: "codex.subagent.spawnAgent",
						content: [{ type: "text", text: "fresh result" }],
						isError: false,
						timestamp: 4,
					},
					isError: false,
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "toolcall_end",
					toolCall: {
						id: "read-call-1",
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "done",
					reason: "tool_use",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			secondTurnMessages = context.messages;
			const assistant = {
				...assistantMessage(),
				content: [{ type: "text" as const, text: "done" }],
				stopReason: "stop",
				timestamp: 5,
			};
			yield {
				type: "start",
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
			content: "Delegate after a retry.",
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

		expect(streamCount).toBe(3);
		expect(localToolExecute).toHaveBeenCalledTimes(1);
		const turnEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "turn_end" }> =>
				event.type === "turn_end",
		);
		expect(turnEnd?.toolResults).toEqual([
			expect.objectContaining({
				toolCallId: "fresh-provider-call",
				toolName: "codex.subagent.spawnAgent",
			}),
			expect.objectContaining({
				toolCallId: "read-call-1",
				toolName: "read",
			}),
		]);
		expect(secondTurnMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "fresh-provider-call",
					toolName: "codex.subagent.spawnAgent",
				}),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "read-call-1",
					toolName: "read",
				}),
			]),
		);
		expect(secondTurnMessages).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "stale-provider-call",
				}),
			]),
		);
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

	it("reuses dynamic read callback results only after repeated guarded-file approvals", async () => {
		const approvalService = new ActionApprovalService("prompt");
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `dynamic:${String(params.file_path)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a guarded file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
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
			for (let index = 1; index <= 2; index++) {
				const toolCallId = `codex-dynamic-read-${index}`;
				yield {
					type: "provider_tool_execution_start",
					toolCallId,
					toolName: "read",
					displayName: "Codex dynamic tool: read",
					summaryLabel: "read",
					args: { file_path: "/workspace/project/guarded.txt" },
					partial: assistant,
				} satisfies AssistantMessageEvent;
				const result = await options.executeDynamicTool({
					type: "toolCall",
					id: toolCallId,
					name: "read",
					arguments: { file_path: "/workspace/project/guarded.txt" },
				});
				dynamicResults.push(result);
				yield {
					type: "provider_tool_execution_end",
					toolCallId,
					toolName: "read",
					displayName: "Codex dynamic tool: read",
					summaryLabel: "read",
					result: {
						role: "toolResult",
						toolCallId,
						toolName: "read",
						content: result.content,
						details: result.details,
						isError: result.isError === true,
						timestamp: index,
					},
					isError: result.isError === true,
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({ approvalService });
		const userMessage: Message = {
			role: "user",
			content: "Use Codex dynamic reads twice.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		await withTimeout(
			(async () => {
				for await (const event of transport.run([userMessage], userMessage, {
					systemPrompt: "Be concise.",
					tools: [readTool],
					model: codexModel,
					guardedFiles: {
						organization: {
							rules: [
								{
									key: "guarded-test",
									description: "Guarded test files",
									patterns: ["**/guarded.txt"],
									defaultBehavior: "ask",
								},
							],
						},
					},
				})) {
					events.push(event);
					if (event.type === "action_approval_required") {
						approvalService.approve(event.request.id, "Approved in test");
					}
				}
			})(),
			"Timed out waiting for repeated Codex dynamic read approvals",
		);

		expect(toolExecute).toHaveBeenCalledTimes(1);
		expect(
			events.filter((event) => event.type === "action_approval_required"),
		).toHaveLength(2);
		expect(dynamicResults).toEqual([
			{
				content: [
					{ type: "text", text: "dynamic:/workspace/project/guarded.txt:1" },
				],
				isError: false,
				details: undefined,
			},
			{
				content: [
					{ type: "text", text: "dynamic:/workspace/project/guarded.txt:1" },
				],
				isError: false,
				details: undefined,
			},
		]);
	});

	it("reuses repeated dynamic read callbacks beyond the loop threshold", async () => {
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `dynamic:${String(params.path)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: toolExecute,
		};
		const assistant = assistantMessage();
		const dynamicResults: AgentToolResult[] = [];
		const repeatedToolCalls = 6;
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
			const resultPromises: Array<Promise<AgentToolResult>> = [];
			for (let index = 1; index <= repeatedToolCalls; index++) {
				const toolCallId = `codex-dynamic-loop-read-${index}`;
				yield {
					type: "provider_tool_execution_start",
					toolCallId,
					toolName: "read",
					displayName: "Codex dynamic tool: read",
					summaryLabel: "read",
					args: { path: "/tmp/evalops.txt" },
					partial: assistant,
				} satisfies AssistantMessageEvent;
				resultPromises.push(
					options.executeDynamicTool({
						type: "toolCall",
						id: toolCallId,
						name: "read",
						arguments: { path: "/tmp/evalops.txt" },
					}),
				);
			}
			const results = await Promise.all(resultPromises);
			for (let index = 1; index <= repeatedToolCalls; index++) {
				const toolCallId = `codex-dynamic-loop-read-${index}`;
				const result = results[index - 1];
				if (!result) {
					throw new Error(`missing dynamic read result ${index}`);
				}
				dynamicResults.push(result);
				yield {
					type: "provider_tool_execution_end",
					toolCallId,
					toolName: "read",
					displayName: "Codex dynamic tool: read",
					summaryLabel: "read",
					result: {
						role: "toolResult",
						toolCallId,
						toolName: "read",
						content: result.content,
						details: result.details,
						isError: result.isError === true,
						timestamp: index,
					},
					isError: result.isError === true,
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport();
		const userMessage: Message = {
			role: "user",
			content: "Use Codex dynamic reads until you are sure.",
			timestamp: 1,
		};

		await withTimeout(
			(async () => {
				for await (const _event of transport.run([userMessage], userMessage, {
					systemPrompt: "Be concise.",
					tools: [readTool],
					model: codexModel,
				})) {
					// Drain the stream.
				}
			})(),
			"Timed out waiting for repeated Codex dynamic read callbacks",
		);

		expect(toolExecute).toHaveBeenCalledTimes(1);
		expect(dynamicResults).toEqual(
			Array.from({ length: repeatedToolCalls }, () => ({
				content: [{ type: "text", text: "dynamic:/tmp/evalops.txt:1" }],
				isError: false,
				details: undefined,
			})),
		);
	});

	it("does not reuse cached dynamic reads while a mutating callback is pending", async () => {
		const readToolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `dynamic:${String(params.path)}:${readToolExecute.mock.calls.length}`,
				},
			],
		}));
		let resolveWriteStarted: (() => void) | undefined;
		let resolveWrite: (() => void) | undefined;
		const writeStarted = new Promise<void>((resolve) => {
			resolveWriteStarted = resolve;
		});
		const writeRelease = new Promise<void>((resolve) => {
			resolveWrite = resolve;
		});
		const writeToolExecute = vi.fn(async () => {
			resolveWriteStarted?.();
			await writeRelease;
			return {
				content: [{ type: "text" as const, text: "write:done" }],
			};
		});
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: readToolExecute,
		};
		const writeTool: AgentTool = {
			name: "write",
			description: "Write a file.",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
			},
			execute: writeToolExecute,
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
			dynamicResults.push(
				await options.executeDynamicTool({
					type: "toolCall",
					id: "dynamic-read-before-write",
					name: "read",
					arguments: { path: "/tmp/evalops.txt" },
				}),
			);
			const writePromise = options.executeDynamicTool({
				type: "toolCall",
				id: "dynamic-write",
				name: "write",
				arguments: {
					path: "/tmp/evalops.txt",
					content: "new content",
				},
			});
			await writeStarted;
			dynamicResults.push(
				await options.executeDynamicTool({
					type: "toolCall",
					id: "dynamic-read-during-write",
					name: "read",
					arguments: { path: "/tmp/evalops.txt" },
				}),
			);
			resolveWrite?.();
			dynamicResults.push(await writePromise);
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport();
		const userMessage: Message = {
			role: "user",
			content: "Read, write, and read the same file.",
			timestamp: 1,
		};

		await withTimeout(
			(async () => {
				for await (const _event of transport.run([userMessage], userMessage, {
					systemPrompt: "Be concise.",
					tools: [readTool, writeTool],
					model: codexModel,
				})) {
					// Drain the stream.
				}
			})(),
			"Timed out waiting for dynamic read/write callbacks",
		);

		expect(readToolExecute).toHaveBeenCalledTimes(2);
		expect(writeToolExecute).toHaveBeenCalledTimes(1);
		expect(dynamicResults).toEqual([
			{
				content: [{ type: "text", text: "dynamic:/tmp/evalops.txt:1" }],
				isError: false,
				details: undefined,
			},
			{
				content: [{ type: "text", text: "dynamic:/tmp/evalops.txt:2" }],
				isError: false,
				details: undefined,
			},
			{
				content: [{ type: "text", text: "write:done" }],
				isError: false,
				details: undefined,
			},
		]);
	});

	it("records Platform observations for cached dynamic read callbacks", async () => {
		const { bridge, recordObservation } = createObservingPlatformBridge();
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `dynamic:${String(params.path)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: toolExecute,
		};
		const assistant = assistantMessage();
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
			for (let index = 1; index <= 2; index++) {
				const toolCallId = `dynamic-observed-read-${index}`;
				const result = await options.executeDynamicTool({
					type: "toolCall",
					id: toolCallId,
					name: "read",
					arguments: { path: "/tmp/evalops.txt" },
				});
				yield {
					type: "provider_tool_execution_end",
					toolCallId,
					toolName: "read",
					displayName: "Codex dynamic tool: read",
					summaryLabel: "read",
					result: {
						role: "toolResult",
						toolCallId,
						toolName: "read",
						content: result.content,
						details: result.details,
						isError: result.isError === true,
						timestamp: index,
					},
					isError: result.isError === true,
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({
			platformToolExecutionBridge: bridge,
		});
		const userMessage: Message = {
			role: "user",
			content: "Use Codex dynamic reads twice.",
			timestamp: 1,
		};

		await withTimeout(
			(async () => {
				for await (const _event of transport.run([userMessage], userMessage, {
					systemPrompt: "Be concise.",
					tools: [readTool],
					model: codexModel,
				})) {
					// Drain the stream.
				}
			})(),
			"Timed out waiting for observed Codex dynamic reads",
		);

		expect(toolExecute).toHaveBeenCalledTimes(1);
		expect(recordObservation).toHaveBeenCalledTimes(2);
		expect(
			recordObservation.mock.calls.map(([, result]) => result.toolCallId),
		).toEqual(["dynamic-observed-read-1", "dynamic-observed-read-2"]);
	});

	it("reuses repeated read-only tool results across provider turns", async () => {
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `read:${String(params.file_path)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: toolExecute,
		};
		const repeatedToolCalls = 6;
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content:
					streamCount <= repeatedToolCalls
						? []
						: [{ type: "text" as const, text: "done" }],
				stopReason: streamCount <= repeatedToolCalls ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount <= repeatedToolCalls) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: `read-call-${streamCount}`,
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport();
		const userMessage: Message = {
			role: "user",
			content: "Read the same file until you are sure.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [readTool],
			model: codexModel,
		})) {
			events.push(event);
		}

		expect(toolExecute).toHaveBeenCalledTimes(1);
		expect(mocks.createProviderStream).toHaveBeenCalledTimes(
			repeatedToolCalls + 1,
		);
		const readResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === "read",
		);
		expect(readResults).toHaveLength(repeatedToolCalls);
		expect(
			readResults.map((event) =>
				event.result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join(""),
			),
		).toEqual(Array(repeatedToolCalls).fill("read:/tmp/evalops.txt:1"));
		expect(readResults.every((event) => event.isError === false)).toBe(true);
	});

	it("records Platform observations for cached provider read results", async () => {
		const { bridge, recordObservation } = createObservingPlatformBridge();
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `read:${String(params.file_path)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: toolExecute,
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content:
					streamCount <= 2 ? [] : [{ type: "text" as const, text: "done" }],
				stopReason: streamCount <= 2 ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount <= 2) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: `observed-read-call-${streamCount}`,
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({
			platformToolExecutionBridge: bridge,
		});
		const userMessage: Message = {
			role: "user",
			content: "Read the same file twice.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [readTool],
			model: codexModel,
		})) {
			events.push(event);
		}

		expect(toolExecute).toHaveBeenCalledTimes(1);
		expect(recordObservation).toHaveBeenCalledTimes(2);
		expect(
			recordObservation.mock.calls.map(([, result]) => result.toolCallId),
		).toEqual(["observed-read-call-1", "observed-read-call-2"]);
		const readResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === "read",
		);
		expect(readResults.map((event) => event.toolExecutionId)).toEqual([
			"observed:observed-read-call-1",
			"observed:observed-read-call-2",
		]);
		expect(readResults.map((event) => event.approvalRequestId)).toEqual([
			"approval:observed-read-call-1",
			"approval:observed-read-call-2",
		]);
	});

	it("invalidates cached read results after mutating provider tools", async () => {
		const readExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `read:${String(params.file_path)}:${readExecute.mock.calls.length}`,
				},
			],
		}));
		const mutateExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `mutated:${String(params.file_path)}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: readExecute,
		};
		const writeTool: AgentTool = {
			name: "write",
			description: "Write a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			execute: mutateExecute,
		};
		const calls = [
			{ name: "read", id: "read-before-mutation" },
			{ name: "write", id: "write-mutation" },
			{ name: "read", id: "read-after-mutation" },
		] as const;
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			const call = calls[streamCount];
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content: call ? [] : [{ type: "text" as const, text: "done" }],
				stopReason: call ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (call) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: call.id,
						name: call.name,
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport();
		const userMessage: Message = {
			role: "user",
			content: "Read, mutate, then read the same file again.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [readTool, writeTool],
			model: codexModel,
		})) {
			events.push(event);
		}

		expect(readExecute).toHaveBeenCalledTimes(2);
		expect(mutateExecute).toHaveBeenCalledTimes(1);
		const readResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === "read",
		);
		expect(
			readResults.map((event) =>
				event.result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join(""),
			),
		).toEqual(["read:/tmp/evalops.txt:1", "read:/tmp/evalops.txt:2"]);
	});

	it("does not reuse cached read results while mutating provider tools are pending", async () => {
		const readExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `read:${String(params.file_path)}:${readExecute.mock.calls.length}`,
				},
			],
		}));
		const mutateExecute = vi.fn(async (_toolCallId, params) => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return {
				content: [
					{
						type: "text" as const,
						text: `mutated:${String(params.file_path)}`,
					},
				],
			};
		});
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: readExecute,
		};
		const writeTool: AgentTool = {
			name: "write",
			description: "Write a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			execute: mutateExecute,
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content:
					streamCount <= 2 ? [] : [{ type: "text" as const, text: "done" }],
				stopReason: streamCount <= 2 ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount === 1) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: "read-cache-primer",
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			} else if (streamCount === 2) {
				for (const toolCall of [
					{
						id: "write-pending-mutation",
						name: "write",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					{
						id: "read-while-mutation-pending",
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall,
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
		});
		const userMessage: Message = {
			role: "user",
			content: "Read, mutate, then read the same file again.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [readTool, writeTool],
			model: codexModel,
		})) {
			events.push(event);
		}

		expect(readExecute).toHaveBeenCalledTimes(2);
		expect(mutateExecute).toHaveBeenCalledTimes(1);
		const readResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === "read",
		);
		expect(
			readResults.map((event) =>
				event.result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join(""),
			),
		).toEqual(["read:/tmp/evalops.txt:1", "read:/tmp/evalops.txt:2"]);
	});

	it("does not skip loop detection when cached reads run behind pending mutations", async () => {
		clearEventBuffer();
		const securityEvents: unknown[] = [];
		const unsubscribe = onSecurityEvent((event) => {
			securityEvents.push(event);
		});
		const readExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `read:${String(params.file_path)}:${readExecute.mock.calls.length}`,
				},
			],
		}));
		const mutateExecute = vi.fn(async (_toolCallId, params) => {
			await new Promise((resolve) => setTimeout(resolve, 250));
			return {
				content: [
					{
						type: "text" as const,
						text: `mutated:${String(params.file_path)}`,
					},
				],
			};
		});
		const readTool: AgentTool = {
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: readExecute,
		};
		const writeTool: AgentTool = {
			name: "write",
			description: "Write a file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			execute: mutateExecute,
		};
		const repeatedReadCalls = 4;
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content:
					streamCount <= 2 ? [] : [{ type: "text" as const, text: "done" }],
				stopReason: streamCount <= 2 ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount === 1) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: "read-cache-primer-for-loop-detection",
						name: "read",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			} else if (streamCount === 2) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: "write-pending-during-loop-detection",
						name: "write",
						arguments: { file_path: "/tmp/evalops.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (let index = 0; index < repeatedReadCalls; index += 1) {
					yield {
						type: "toolcall_end",
						toolCall: {
							id: `repeated-read-while-write-pending-${index + 1}`,
							name: "read",
							arguments: { file_path: "/tmp/evalops.txt" },
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
		});
		const userMessage: Message = {
			role: "user",
			content: "Read, mutate, then keep rereading the same file.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		try {
			for await (const event of transport.run([userMessage], userMessage, {
				systemPrompt: "Be concise.",
				tools: [readTool, writeTool],
				model: codexModel,
			})) {
				events.push(event);
			}
		} finally {
			unsubscribe();
		}

		expect(securityEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "loop_detected",
					toolName: "read",
					metadata: expect.objectContaining({
						action: "warn",
						loopType: "exact",
						repetitions: expect.any(Number),
					}),
				}),
			]),
		);
		expect(mutateExecute).toHaveBeenCalledTimes(1);
		const readResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === "read",
		);
		expect(
			readResults.map((event) =>
				event.result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join(""),
			),
		).toEqual(
			Array.from(
				{ length: 1 + repeatedReadCalls },
				(_, index) => `read:/tmp/evalops.txt:${index + 1}`,
			),
		);
	});

	it("reuses provider read results only after repeated guarded-file approvals", async () => {
		const approvalService = new ActionApprovalService("prompt");
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `guarded:${String(params.file_path)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const readTool: AgentTool = {
			name: "read",
			description: "Read a guarded file.",
			parameters: Type.Object({
				file_path: Type.String(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: toolExecute,
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content:
					streamCount <= 2 ? [] : [{ type: "text" as const, text: "done" }],
				stopReason: streamCount <= 2 ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount <= 2) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: `guarded-read-call-${streamCount}`,
						name: "read",
						arguments: { file_path: "/workspace/project/guarded.txt" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport({ approvalService });
		const userMessage: Message = {
			role: "user",
			content: "Read the guarded file twice.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [readTool],
			model: codexModel,
			guardedFiles: {
				organization: {
					rules: [
						{
							key: "guarded-test",
							description: "Guarded test files",
							patterns: ["**/guarded.txt"],
							defaultBehavior: "ask",
						},
					],
				},
			},
		})) {
			events.push(event);
			if (event.type === "action_approval_required") {
				approvalService.approve(event.request.id, "Approved in test");
			}
		}

		expect(toolExecute).toHaveBeenCalledTimes(1);
		const approvalRequests = events.filter(
			(event) => event.type === "action_approval_required",
		);
		expect(approvalRequests).toHaveLength(2);
		const readResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === "read",
		);
		expect(
			readResults.map((event) =>
				event.result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join(""),
			),
		).toEqual([
			"guarded:/workspace/project/guarded.txt:1",
			"guarded:/workspace/project/guarded.txt:1",
		]);
	});

	it("executes repeated non-read-only provider tool calls independently", async () => {
		const toolExecute = vi.fn(async (_toolCallId, params) => ({
			content: [
				{
					type: "text" as const,
					text: `mutation:${String(params.id)}:${toolExecute.mock.calls.length}`,
				},
			],
		}));
		const mutatingTool: AgentTool = {
			name: "counter_update",
			description: "Update a counter.",
			parameters: Type.Object({
				id: Type.String(),
			}),
			execute: toolExecute,
		};
		const repeatedToolCalls = 2;
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant = {
				...assistantMessage(),
				content:
					streamCount <= repeatedToolCalls
						? []
						: [{ type: "text" as const, text: "done" }],
				stopReason: streamCount <= repeatedToolCalls ? "tool_use" : "stop",
				timestamp: streamCount,
			};
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount <= repeatedToolCalls) {
				yield {
					type: "toolcall_end",
					toolCall: {
						id: `counter-call-${streamCount}`,
						name: "counter_update",
						arguments: { id: "ABC-123" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: assistant.stopReason,
				message: assistant,
			} satisfies AssistantMessageEvent;
		});
		const transport = new ProviderTransport();
		const userMessage: Message = {
			role: "user",
			content: "Update the counter twice.",
			timestamp: 1,
		};
		const events: AgentEvent[] = [];

		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Be concise.",
			tools: [mutatingTool],
			model: codexModel,
		})) {
			events.push(event);
		}

		expect(toolExecute).toHaveBeenCalledTimes(repeatedToolCalls);
		const mutationResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" &&
				event.toolName === "counter_update",
		);
		expect(
			mutationResults.map((event) =>
				event.result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join(""),
			),
		).toEqual(["mutation:ABC-123:1", "mutation:ABC-123:2"]);
	});
});
