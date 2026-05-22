import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentEvent,
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
} from "../../src/agent/types.js";
import type { ToolHookService } from "../../src/hooks/tool-integration.js";

const mocks = vi.hoisted(() => ({
	createProviderStream: vi.fn(),
}));

vi.mock("../../src/agent/transport/create-provider-stream.js", () => ({
	createProviderStream: mocks.createProviderStream,
}));

const { ProviderTransport } = await import("../../src/agent/transport.js");

const model: Model<"openai-codex-app-server"> = {
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

type TimedToolRecord = {
	id: string;
	phase: "inspect" | "commit" | "verify";
	startedAt: number;
	endedAt?: number;
};

function assistantMessage(
	content: AssistantMessage["content"] = [],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: Date.now(),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

function spread(records: Array<{ startedAt: number }>): number {
	if (records.length === 0) {
		return 0;
	}
	return (
		Math.max(...records.map((record) => record.startedAt)) -
		Math.min(...records.map((record) => record.startedAt))
	);
}

describe("ProviderTransport tool scheduling", () => {
	it("emits tool phase telemetry with parallelization and serialization reasons", async () => {
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { readOnlyHint: true },
			execute: async (_toolCallId, args) => {
				await sleep(20);
				return {
					content: [{ type: "text", text: `read:${String(args.slot)}` }],
				};
			},
		};
		const pathWriteTool: AgentTool = {
			name: "path_write",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
				slot: Type.Integer(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(20);
				return {
					content: [
						{ type: "text", text: `write:${String(args.path)}:${args.slot}` },
					],
				};
			},
		};
		const trustedMcpTool = {
			name: "mcp__trusted_fs__probe",
			description: "Trusted MCP latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { openWorldHint: true },
			source: {
				type: "mcp",
				server: "trusted-fs",
				tool: "probe",
				supportsParallelToolCalls: true,
			},
			execute: async (_toolCallId: string, args: Record<string, unknown>) => {
				await sleep(20);
				return {
					content: [{ type: "text" as const, text: `mcp:${args.slot}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				const calls = [
					{ id: "read-1", name: "read_probe", arguments: { slot: 1 } },
					{ id: "read-2", name: "read_probe", arguments: { slot: 2 } },
					{
						id: "write-a",
						name: "path_write",
						arguments: { path: "src/a.ts", slot: 1 },
					},
					{
						id: "write-b",
						name: "path_write",
						arguments: { path: "src/b.ts", slot: 2 },
					},
					{
						id: "write-b-overlap",
						name: "path_write",
						arguments: { path: resolve(process.cwd(), "src/b.ts"), slot: 3 },
					},
					{
						id: "trusted-1",
						name: "mcp__trusted_fs__probe",
						arguments: { slot: 1 },
					},
					{
						id: "trusted-2",
						name: "mcp__trusted_fs__probe",
						arguments: { slot: 2 },
					},
				];
				for (const call of calls) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: call.id,
							name: call.name,
							arguments: call.arguments,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "telemetry captured" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content: "Collect scheduler telemetry.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool, pathWriteTool, trustedMcpTool],
				model,
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);

		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 7,
			schedulableWaveCount: 4,
			parallelizedCallCount: 5,
			blockedByMutationCount: 2,
			mcpOptInCallCount: 2,
			cacheHitCount: 0,
		});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "read-1",
					outcome: "parallelized",
					reason: "read_only_parallel_safe",
				}),
				expect.objectContaining({
					toolCallId: "write-b",
					outcome: "parallelized",
					reason: "path_scoped_mutation",
				}),
				expect.objectContaining({
					toolCallId: "write-b-overlap",
					outcome: "delayed",
					reason: "mutation_scope_overlap",
				}),
				expect.objectContaining({
					toolCallId: "trusted-1",
					outcome: "delayed",
					reason: "mutation_unknown_write_set",
				}),
				expect.objectContaining({
					toolCallId: "trusted-2",
					outcome: "parallelized",
					reason: "mcp_parallel_opt_in",
				}),
			]),
		);
		expect(
			phaseSummary?.decisions.every((decision) => decision.waitMs >= 0),
		).toBe(true);
		expect(
			phaseSummary?.decisions.some((decision) => "arguments" in decision),
		).toBe(false);
	});

	it("reports unknown write sets when a mutation cannot join a pending mutation island", async () => {
		const pathWriteTool: AgentTool = {
			name: "path_write",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
				slot: Type.Integer(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(20);
				return {
					content: [
						{ type: "text", text: `write:${String(args.path)}:${args.slot}` },
					],
				};
			},
		};
		const unknownWriteTool: AgentTool = {
			name: "unknown_write",
			description: "Mutating probe without a declared write set.",
			parameters: Type.Object({
				label: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(20);
				return {
					content: [{ type: "text", text: `unknown:${String(args.label)}` }],
				};
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount > 1) {
				const assistant = assistantMessage(
					[{ type: "text", text: "unknown write-set telemetry captured" }],
					"stop",
				);
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "done",
					reason: "stop",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage([], "toolUse");
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			for (const call of [
				{
					id: "write-a",
					name: "path_write",
					arguments: { path: "src/a.ts", slot: 1 },
				},
				{
					id: "write-b",
					name: "path_write",
					arguments: { path: "src/b.ts", slot: 2 },
				},
				{
					id: "write-unknown",
					name: "unknown_write",
					arguments: { label: "mutates an unknown write set" },
				},
			]) {
				yield {
					type: "toolcall_end",
					toolCall: {
						type: "toolCall",
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: "toolUse",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});

		const userMessage: Message = {
			role: "user",
			content: "Collect unknown write-set telemetry.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [pathWriteTool, unknownWriteTool],
				model,
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		const schedulingById = new Map(
			toolResults.map((event) => [event.toolCallId, event.scheduling]),
		);

		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 3,
			parallelizedCallCount: 2,
			blockedByMutationCount: 1,
			serializationReasons: {
				mutation_unknown_write_set: 1,
			},
		});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "write-unknown",
					outcome: "delayed",
					reason: "mutation_unknown_write_set",
					blockedByMutation: true,
				}),
			]),
		);
		expect(schedulingById.get("write-unknown")).toMatchObject({
			classification: "serialized_mutation",
			reason: "pending_mutation",
			pendingMutations: 1,
		});
		expect(JSON.stringify(phaseSummary)).not.toContain(
			"mutates an unknown write set",
		);
	});

	it("counts skipped calls before summarizing interrupted tool phases", async () => {
		const toolCalls = Array.from({ length: 9 }, (_, index) => ({
			type: "toolCall" as const,
			id: `read-${index + 1}`,
			name: "read_probe",
			arguments: { slot: index + 1 },
		}));
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { readOnlyHint: true },
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `read:${String(args.slot)}` }],
			}),
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant =
				streamCount === 1
					? assistantMessage(toolCalls, "toolUse")
					: assistantMessage(
							[{ type: "text", text: "steering handled" }],
							"stop",
						);
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount === 1) {
				for (const toolCall of toolCalls) {
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
		let steeringChecks = 0;
		const userMessage: Message = {
			role: "user",
			content: "Inspect three files, then accept steering.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});
		let steeringDelivered = false;

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool],
				model,
				getSteeringMessages: async () => {
					steeringChecks += 1;
					if (steeringChecks === 1 || steeringDelivered) return [];
					steeringDelivered = true;
					const steeringMessage: Message = {
						role: "user",
						content: "Actually stop after the first read.",
						timestamp: Date.now(),
					};
					return [
						{
							id: 1,
							createdAt: Date.now(),
							original: steeringMessage,
							llm: steeringMessage,
						},
					];
				},
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);
		const skippedIds = events
			.filter(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end" && event.isError === true,
			)
			.map((event) => event.toolCallId);

		expect(skippedIds).toEqual(["read-9"]);
		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 9,
			modelEmittedToolCallCount: 9,
			parallelizedCallCount: 8,
			serializedCallCount: 0,
			delayedCallCount: 0,
			serializationReasons: {},
			batchShapingFeedback: undefined,
		});
		expect(phaseSummary?.serializationReasons).toEqual({});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "read-1",
					outcome: "parallelized",
					reason: "read_only_parallel_safe",
				}),
				expect.objectContaining({
					toolCallId: "read-9",
					outcome: "skipped",
					reason: "steering_interrupted",
				}),
			]),
		);
	});

	it("counts safety-blocked calls before applying singleton batch feedback", async () => {
		const toolCalls = [
			{
				type: "toolCall" as const,
				id: "read-1",
				name: "read_probe",
				arguments: { slot: 1 },
			},
			{
				type: "toolCall" as const,
				id: "read-2",
				name: "read_probe",
				arguments: { slot: 2 },
			},
			{
				type: "toolCall" as const,
				id: "read-blocked",
				name: "read_probe",
				arguments: { slot: 3 },
			},
		];
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { readOnlyHint: true },
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `read:${String(args.slot)}` }],
			}),
		};
		const hookService: ToolHookService = {
			runPreToolUseHooks: vi.fn(async (toolCall) => ({
				blocked: toolCall.id === "read-blocked",
				blockReason: "Blocked for telemetry regression.",
				askPermission: false,
				hookResults: [],
			})),
			runPostToolUseHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runEvalGateHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runPostToolUseFailureHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runPermissionRequestHooks: vi.fn(async () => ({
				hookResults: [],
			})),
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant =
				streamCount === 1
					? assistantMessage(toolCalls, "toolUse")
					: assistantMessage(
							[{ type: "text", text: "blocked call counted" }],
							"stop",
						);
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount === 1) {
				for (const toolCall of toolCalls) {
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
		const userMessage: Message = {
			role: "user",
			content: "Read two files and try a blocked read.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			hookService,
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool],
				model,
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);
		const blockedEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" &&
				event.toolCallId === "read-blocked",
		);

		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 3,
			modelEmittedToolCallCount: 3,
			parallelizedCallCount: 2,
			batchShapingFeedback: undefined,
		});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "read-blocked",
					outcome: "skipped",
					reason: "safety_blocked",
				}),
			]),
		);
		expect(
			phaseSummary?.decisions.filter(
				(decision) => decision.toolCallId === "read-blocked",
			),
		).toHaveLength(1);
		expect(blockedEnd?.scheduling).toMatchObject({
			classification: "read_only",
			reason: "read_only_tool",
		});
	});

	it("labels workflow-forced serialization ahead of read and MCP labels", async () => {
		const toolCalls = [
			{
				type: "toolCall" as const,
				id: "read-1",
				name: "read_probe",
				arguments: { slot: 1 },
			},
			{
				type: "toolCall" as const,
				id: "collect-1",
				name: "collect_customer_context",
				arguments: { subject: "alpha" },
			},
			{
				type: "toolCall" as const,
				id: "mcp-1",
				name: "mcp__trusted_remote__mutate",
				arguments: { slot: 2 },
			},
		];
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { readOnlyHint: true },
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `read:${String(args.slot)}` }],
			}),
		};
		const collectCustomerContextTool: AgentTool = {
			name: "collect_customer_context",
			description: "Workflow-tracked customer context collector.",
			parameters: Type.Object({ subject: Type.String() }),
			annotations: { readOnlyHint: false },
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `context:${String(args.subject)}` }],
			}),
		};
		const trustedMcpMutationTool = {
			name: "mcp__trusted_remote__mutate",
			description: "Parallel-safe remote mutation probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { readOnlyHint: false },
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "mutate",
				supportsParallelToolCalls: true,
			},
			execute: async (_toolCallId: string, args: Record<string, unknown>) => ({
				content: [{ type: "text", text: `mutate:${String(args.slot)}` }],
			}),
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant =
				streamCount === 1
					? assistantMessage(toolCalls, "toolUse")
					: assistantMessage(
							[{ type: "text", text: "workflow serialization complete" }],
							"stop",
						);
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount === 1) {
				for (const toolCall of toolCalls) {
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
		const userMessage: Message = {
			role: "user",
			content: "Read context, collect customer context, and mutate remotely.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [
					readProbeTool,
					collectCustomerContextTool,
					trustedMcpMutationTool,
				],
				model,
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);

		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 3,
			serializedCallCount: 3,
			parallelizedCallCount: 0,
			batchShapingFeedback: undefined,
			serializationReasons: {
				workflow_state_serialized: 3,
			},
		});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "read-1",
					outcome: "serialized",
					reason: "workflow_state_serialized",
				}),
				expect.objectContaining({
					toolCallId: "collect-1",
					outcome: "serialized",
					reason: "workflow_state_serialized",
				}),
				expect.objectContaining({
					toolCallId: "mcp-1",
					outcome: "serialized",
					reason: "workflow_state_serialized",
					mcpOptIn: true,
				}),
			]),
		);
		expect(phaseSummary?.serializationReasons).not.toHaveProperty(
			"single_read_only_call",
		);
		expect(phaseSummary?.serializationReasons).not.toHaveProperty(
			"mcp_parallel_opt_in",
		);
	});

	it("does not call mixed-batch read serialization a singleton", async () => {
		const toolCalls = [
			{
				type: "toolCall" as const,
				id: "read-1",
				name: "read_probe",
				arguments: { slot: 1 },
			},
			{
				type: "toolCall" as const,
				id: "write-1",
				name: "write_probe",
				arguments: { subject: "alpha" },
			},
		];
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: { readOnlyHint: true },
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `read:${String(args.slot)}` }],
			}),
		};
		const writeProbeTool: AgentTool = {
			name: "write_probe",
			description: "Serialized write probe.",
			parameters: Type.Object({ subject: Type.String() }),
			annotations: { readOnlyHint: false },
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `write:${String(args.subject)}` }],
			}),
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const assistant =
				streamCount === 1
					? assistantMessage(toolCalls, "toolUse")
					: assistantMessage(
							[{ type: "text", text: "mixed batch complete" }],
							"stop",
						);
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			if (streamCount === 1) {
				for (const toolCall of toolCalls) {
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
		const userMessage: Message = {
			role: "user",
			content: "Read context and then write it.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool, writeProbeTool],
				model,
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);

		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 2,
			serializedCallCount: 2,
			parallelizedCallCount: 0,
			batchShapingFeedback: undefined,
			serializationReasons: {
				read_only_wave_start: 1,
				serialized_tool: 1,
			},
		});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "read-1",
					outcome: "serialized",
					reason: "read_only_wave_start",
				}),
				expect.objectContaining({
					toolCallId: "write-1",
					outcome: "serialized",
					reason: "serialized_tool",
				}),
			]),
		);
		expect(phaseSummary?.serializationReasons).not.toHaveProperty(
			"single_read_only_call",
		);
	});

	it("runs read-only waves concurrently around a serialized mutation", async () => {
		const records: TimedToolRecord[] = [];
		let activeReadOnlyTools = 0;
		let mutationOverlapCount = 0;

		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({
				phase: Type.Union([Type.Literal("inspect"), Type.Literal("verify")]),
				slot: Type.Integer(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: async (toolCallId, args) => {
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: args.phase as "inspect" | "verify",
					startedAt: performance.now(),
				};
				records.push(record);
				activeReadOnlyTools += 1;
				await sleep(80);
				activeReadOnlyTools -= 1;
				record.endedAt = performance.now();
				return {
					content: [
						{
							type: "text",
							text: `${String(args.phase)}:${String(args.slot)}`,
						},
					],
				};
			},
		};
		const commitStepTool: AgentTool = {
			name: "commit_step",
			description: "Mutating latency probe.",
			parameters: Type.Object({
				label: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
			},
			execute: async (toolCallId, args) => {
				if (activeReadOnlyTools > 0) {
					mutationOverlapCount += 1;
				}
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "commit",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(20);
				record.endedAt = performance.now();
				return {
					content: [{ type: "text", text: `commit:${String(args.label)}` }],
				};
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				const calls = [
					...Array.from({ length: 4 }, (_, index) => ({
						id: `inspect-${index + 1}`,
						name: "read_probe",
						arguments: { phase: "inspect", slot: index + 1 },
					})),
					{
						id: "commit-1",
						name: "commit_step",
						arguments: { label: "apply-plan" },
					},
					...Array.from({ length: 4 }, (_, index) => ({
						id: `verify-${index + 1}`,
						name: "read_probe",
						arguments: { phase: "verify", slot: index + 1 },
					})),
				];
				for (const call of calls) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: call.id,
							name: call.name,
							arguments: call.arguments,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "complex goal complete" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content:
				"Complete the complex goal: inspect four inputs, commit the plan, then verify four outputs.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool, commitStepTool],
				model,
			}),
		);

		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		const toolStartsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
						event.type === "tool_execution_start",
				)
				.map((event) => [event.toolCallId, event]),
		);
		const inspectRecords = records.filter(
			(record) => record.phase === "inspect",
		);
		const verifyRecords = records.filter((record) => record.phase === "verify");
		const commitRecord = records.find((record) => record.phase === "commit");
		if (!commitRecord?.endedAt) {
			throw new Error("Missing commit tool timing record");
		}

		const inspectStartSpread =
			Math.max(...inspectRecords.map((record) => record.startedAt)) -
			Math.min(...inspectRecords.map((record) => record.startedAt));
		const verifyStartSpread =
			Math.max(...verifyRecords.map((record) => record.startedAt)) -
			Math.min(...verifyRecords.map((record) => record.startedAt));
		const latestInspectEnd = Math.max(
			...inspectRecords.map((record) => record.endedAt ?? 0),
		);
		const earliestVerifyStart = Math.min(
			...verifyRecords.map((record) => record.startedAt),
		);

		expect(toolResults).toHaveLength(9);
		expect(inspectRecords).toHaveLength(4);
		expect(verifyRecords).toHaveLength(4);
		expect(toolStartsById.get("inspect-1")?.scheduling?.concurrencyLimit).toBe(
			8,
		);
		expect(toolStartsById.get("commit-1")?.scheduling?.concurrencyLimit).toBe(
			1,
		);
		expect(toolStartsById.get("commit-1")?.scheduling).toMatchObject({
			classification: "serialized_mutation",
			reason: "mutating_tool",
			pendingMutations: 0,
		});
		expect(inspectStartSpread).toBeLessThan(40);
		expect(commitRecord.startedAt).toBeGreaterThanOrEqual(latestInspectEnd);
		expect(mutationOverlapCount).toBe(0);
		expect(earliestVerifyStart).toBeGreaterThanOrEqual(commitRecord.endedAt);
		expect(verifyStartSpread).toBeLessThan(40);
	});

	it("preserves configured concurrency cap for parallel-safe MCP mutations", async () => {
		const records: TimedToolRecord[] = [];
		let activeMutations = 0;
		let maxActiveMutations = 0;

		const parallelSafeMutationTool = {
			name: "mcp__trusted_remote__mutate",
			description: "Parallel-safe remote mutation probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: false,
			},
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "mutate",
				supportsParallelToolCalls: true,
			},
			execute: async (toolCallId: string, args: Record<string, unknown>) => {
				activeMutations += 1;
				maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "commit",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(60);
				activeMutations -= 1;
				record.endedAt = performance.now();
				return {
					content: [{ type: "text", text: `mutate:${String(args.slot)}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const slot of [1, 2]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: `mutate-${slot}`,
							name: "mcp__trusted_remote__mutate",
							arguments: { slot },
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "mutations complete" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content: "Run two trusted remote mutations.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 1,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [parallelSafeMutationTool],
				model,
			}),
		);

		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);

		expect(toolResults).toHaveLength(2);
		expect(records).toHaveLength(2);
		expect(maxActiveMutations).toBe(1);
		expect(records[1]?.startedAt).toBeGreaterThanOrEqual(
			records[0]?.endedAt ?? 0,
		);
	});

	it("reports unknown write set when scoped writes wait behind unscoped parallel-safe mutations", async () => {
		const records: TimedToolRecord[] = [];
		const parallelSafeMutationTool = {
			name: "mcp__trusted_remote__mutate",
			description: "Parallel-safe remote mutation probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: false,
			},
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "mutate",
				supportsParallelToolCalls: true,
			},
			execute: async (toolCallId: string, args: Record<string, unknown>) => {
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "commit",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(50);
				record.endedAt = performance.now();
				return {
					content: [{ type: "text", text: `mutate:${String(args.slot)}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		const pathWriteTool: AgentTool = {
			name: "path_write",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
				slot: Type.Integer(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (toolCallId, args) => {
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "commit",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(10);
				record.endedAt = performance.now();
				return {
					content: [
						{ type: "text", text: `write:${String(args.path)}:${args.slot}` },
					],
				};
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount > 1) {
				const assistant = assistantMessage(
					[{ type: "text", text: "mutation telemetry captured" }],
					"stop",
				);
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "done",
					reason: "stop",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage([], "toolUse");
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			for (const call of [
				{
					id: "trusted-mutate-1",
					name: "mcp__trusted_remote__mutate",
					arguments: { slot: 1 },
				},
				{
					id: "trusted-mutate-2",
					name: "mcp__trusted_remote__mutate",
					arguments: { slot: 2 },
				},
				{
					id: "write-a",
					name: "path_write",
					arguments: { path: "src/a.ts", slot: 3 },
				},
			]) {
				yield {
					type: "toolcall_end",
					toolCall: {
						type: "toolCall",
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
			}
			yield {
				type: "done",
				reason: "toolUse",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});

		const userMessage: Message = {
			role: "user",
			content: "Run a trusted remote mutation, then write a file.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [parallelSafeMutationTool, pathWriteTool],
				model,
			}),
		);

		const phaseSummary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		const schedulingById = new Map(
			toolResults.map((event) => [event.toolCallId, event.scheduling]),
		);

		expect(records).toHaveLength(3);
		expect(phaseSummary).toMatchObject({
			modelToolCallCount: 3,
			parallelizedCallCount: 2,
			serializedCallCount: 1,
			blockedByMutationCount: 1,
			serializationReasons: {
				mutation_unknown_write_set: 1,
			},
		});
		expect(phaseSummary?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "write-a",
					outcome: "delayed",
					reason: "mutation_unknown_write_set",
					blockedByMutation: true,
				}),
			]),
		);
		expect(schedulingById.get("write-a")).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "pending_mutation",
			pendingMutations: 1,
		});
	});

	it("runs trusted MCP reads and disjoint path mutations without unsafe overlap", async () => {
		const records: Array<
			TimedToolRecord & { path?: string; trustedMcp?: boolean }
		> = [];
		let activeMutationPaths: string[] = [];
		let unsafeOverlapCount = 0;

		const trustedMcpProbeTool = {
			name: "mcp__trusted_fs__probe",
			description: "Trusted MCP latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				openWorldHint: true,
			},
			source: {
				type: "mcp",
				server: "trusted-fs",
				tool: "probe",
				supportsParallelToolCalls: true,
			},
			execute: async (toolCallId: string, args: Record<string, unknown>) => {
				const record = {
					id: toolCallId,
					phase: "inspect" as const,
					startedAt: performance.now(),
					trustedMcp: true,
				};
				records.push(record);
				await sleep(80);
				record.endedAt = performance.now();
				return {
					content: [{ type: "text" as const, text: `trusted:${args.slot}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		const untrustedMcpProbeTool = {
			name: "mcp__untrusted_fs__probe",
			description: "Untrusted MCP latency probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				openWorldHint: true,
			},
			source: {
				type: "mcp",
				server: "untrusted-fs",
				tool: "probe",
				supportsParallelToolCalls: false,
			},
			execute: async (toolCallId: string, args: Record<string, unknown>) => {
				const record = {
					id: toolCallId,
					phase: "inspect" as const,
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(30);
				record.endedAt = performance.now();
				return {
					content: [{ type: "text" as const, text: `untrusted:${args.slot}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		const pathWriteTool: AgentTool = {
			name: "path_write",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
				slot: Type.Integer(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (toolCallId, args) => {
				const path = String(args.path);
				if (
					activeMutationPaths.some(
						(activePath) =>
							activePath === path ||
							activePath.startsWith(`${path}/`) ||
							path.startsWith(`${activePath}/`),
					)
				) {
					unsafeOverlapCount += 1;
				}
				activeMutationPaths.push(path);
				const record = {
					id: toolCallId,
					phase: "commit" as const,
					path,
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(80);
				record.endedAt = performance.now();
				activeMutationPaths = activeMutationPaths.filter(
					(activePath) => activePath !== path,
				);
				return {
					content: [{ type: "text", text: `write:${path}:${args.slot}` }],
				};
			},
		};
		const readProbeTool: AgentTool = {
			name: "read_probe_next_wave",
			description: "Read-only verification probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: true,
			},
			execute: async (toolCallId, args) => {
				if (activeMutationPaths.length > 0) {
					unsafeOverlapCount += 1;
				}
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "verify",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(30);
				record.endedAt = performance.now();
				return {
					content: [{ type: "text", text: `verify:${String(args.slot)}` }],
				};
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				const calls = [
					{
						id: "trusted-1",
						name: "mcp__trusted_fs__probe",
						arguments: { slot: 1 },
					},
					{
						id: "trusted-2",
						name: "mcp__trusted_fs__probe",
						arguments: { slot: 1 },
					},
					{
						id: "untrusted-1",
						name: "mcp__untrusted_fs__probe",
						arguments: { slot: 1 },
					},
					{
						id: "untrusted-2",
						name: "mcp__untrusted_fs__probe",
						arguments: { slot: 2 },
					},
					{
						id: "write-a",
						name: "path_write",
						arguments: { path: "src/a.ts", slot: 1 },
					},
					{
						id: "write-b",
						name: "path_write",
						arguments: { path: "src/b.ts", slot: 2 },
					},
					{
						id: "write-b-overlap",
						name: "path_write",
						arguments: { path: resolve(process.cwd(), "src/b.ts"), slot: 3 },
					},
					{
						id: "verify-1",
						name: "read_probe_next_wave",
						arguments: { slot: 1 },
					},
					{
						id: "verify-2",
						name: "read_probe_next_wave",
						arguments: { slot: 2 },
					},
				];
				for (const call of calls) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: call.id,
							name: call.name,
							arguments: call.arguments,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "next wave complete" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content:
				"Use trusted MCP reads, disjoint path mutations, and verification reads.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [
					trustedMcpProbeTool,
					untrustedMcpProbeTool,
					pathWriteTool,
					readProbeTool,
				],
				model,
			}),
		);

		const trustedMcpRecords = records.filter(
			(record) => record.trustedMcp === true,
		);
		const untrustedMcpRecords = records.filter((record) =>
			record.id.startsWith("untrusted-"),
		);
		const writeARecord = records.find((record) => record.id === "write-a");
		const writeBRecord = records.find((record) => record.id === "write-b");
		const overlappingWriteRecord = records.find(
			(record) => record.id === "write-b-overlap",
		);
		const verifyRecords = records.filter((record) => record.phase === "verify");
		if (
			!writeARecord?.endedAt ||
			!writeBRecord?.endedAt ||
			!overlappingWriteRecord?.endedAt
		) {
			throw new Error("Missing mutation timing records");
		}

		const trustedMcpSpread = spread(trustedMcpRecords);
		const untrustedMcpSpread = spread(untrustedMcpRecords);
		const disjointMutationSpread = Math.abs(
			writeARecord.startedAt - writeBRecord.startedAt,
		);
		const verifyStartGap =
			Math.min(...verifyRecords.map((record) => record.startedAt)) -
			overlappingWriteRecord.endedAt;
		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		const toolResultsById = new Map(
			toolResults.map((event) => [event.toolCallId, event]),
		);
		const summary = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);
		const schedulingById = new Map(
			summary?.decisions.map((decision) => [decision.toolCallId, decision]),
		);

		expect(toolResults).toHaveLength(9);
		expect(schedulingById.get("trusted-2")).toMatchObject({
			decision: "parallelized",
			reason: "mcp_parallel_opt_in",
			mcpOptIn: true,
		});
		expect(schedulingById.get("write-b")).toMatchObject({
			decision: "parallelized",
			reason: "path_scoped_mutation",
		});
		expect(schedulingById.get("write-b-overlap")).toMatchObject({
			decision: "delayed",
			reason: "mutation_scope_overlap",
			blockedByMutation: true,
		});
		expect(schedulingById.get("verify-1")).toMatchObject({
			decision: "delayed",
			reason: "pending_mutation",
			blockedByMutation: true,
		});
		expect(trustedMcpSpread).toBeLessThan(40);
		expect(untrustedMcpSpread).toBeGreaterThanOrEqual(25);
		expect(disjointMutationSpread).toBeLessThan(40);
		expect(overlappingWriteRecord.startedAt).toBeGreaterThanOrEqual(
			writeBRecord.endedAt,
		);
		expect(verifyStartGap).toBeLessThan(25);
		expect(unsafeOverlapCount).toBe(0);
		expect(toolResultsById.get("trusted-1")?.scheduling?.classification).toBe(
			"parallel_safe_mutation",
		);
		expect(toolResultsById.get("write-b")?.scheduling?.reason).toBe(
			"path_scope_disjoint",
		);
		expect(toolResultsById.get("write-b-overlap")?.scheduling?.reason).toBe(
			"path_scope_overlap",
		);
		expect(toolResultsById.get("verify-1")?.scheduling?.classification).toBe(
			"read_only",
		);
	});

	it("labels path-scoped mutations blocked by unscoped pending mutations", async () => {
		const unscopedMutationTool = {
			name: "mcp__trusted_remote__unscoped_write",
			description: "Mutation without path-scope metadata.",
			parameters: Type.Object({ label: Type.String() }),
			annotations: {
				readOnlyHint: false,
			},
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "unscoped_write",
				supportsParallelToolCalls: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(40);
				return {
					content: [{ type: "text", text: `write:${String(args.label)}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		const pathWriteTool: AgentTool = {
			name: "path_write_after_unscoped",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `path:${String(args.path)}` }],
			}),
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const toolCall of [
					{
						id: "unscoped-1",
						name: "mcp__trusted_remote__unscoped_write",
						arguments: { label: "before" },
					},
					{
						id: "path-2",
						name: "path_write_after_unscoped",
						arguments: { path: "src/after.ts" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							...toolCall,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "complete" }],
				"stop",
			);
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
		const userMessage: Message = {
			role: "user",
			content: "Run an unscoped write, then a path-scoped write.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [unscopedMutationTool, pathWriteTool],
				model,
			}),
		);
		const toolResultsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
						event.type === "tool_execution_end",
				)
				.map((event) => [event.toolCallId, event]),
		);

		expect(toolResultsById.get("path-2")?.scheduling).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "pending_mutation",
			pendingMutations: 1,
			pathArgumentKeys: ["path"],
		});
	});

	it("recomputes path-scoped scheduling after PreToolUse hooks mutate path arguments", async () => {
		const unscopedMutationTool: AgentTool = {
			name: "unscoped_write_before_hook",
			description: "Mutation without path-scope metadata.",
			parameters: Type.Object({ label: Type.String() }),
			annotations: {
				readOnlyHint: false,
			},
			execute: async (_toolCallId, args) => {
				await sleep(40);
				return {
					content: [{ type: "text", text: `write:${String(args.label)}` }],
				};
			},
		};
		const pathWriteTool: AgentTool = {
			name: "path_write_hooked",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `path:${String(args.path)}` }],
			}),
		};
		const hookService = {
			runPreToolUseHooks: vi.fn(async (toolCall) => ({
				blocked: false,
				askPermission: false,
				updatedInput:
					toolCall.id === "path-2" ? { path: "src/after-hook.ts" } : undefined,
				hookResults: [],
			})),
			runPostToolUseHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runEvalGateHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runPostToolUseFailureHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runPermissionRequestHooks: vi.fn(async () => ({
				hookResults: [],
			})),
		} satisfies ToolHookService;

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const toolCall of [
					{
						id: "unscoped-1",
						name: "unscoped_write_before_hook",
						arguments: { label: "before" },
					},
					{
						id: "path-2",
						name: "path_write_hooked",
						arguments: { path: "src/after.ts" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							...toolCall,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "complete" }],
				"stop",
			);
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
		const userMessage: Message = {
			role: "user",
			content:
				"Run a queued write, then let the hook retarget the path-scoped one.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			hookService,
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [unscopedMutationTool, pathWriteTool],
				model,
			}),
		);
		const toolResultsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
						event.type === "tool_execution_end",
				)
				.map((event) => [event.toolCallId, event]),
		);

		expect(toolResultsById.get("path-2")?.result.content).toEqual([
			{ type: "text", text: "path:src/after-hook.ts" },
		]);
		expect(toolResultsById.get("path-2")?.scheduling).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "path_scope_available",
			queueDepth: 0,
			pendingMutations: 0,
			pathArgumentKeys: ["path"],
			pathScope: [resolve(process.cwd(), "src/after-hook.ts").toLowerCase()],
		});
	});

	it("drops stale path scope fields when hooks remove path arguments", async () => {
		const unscopedMutationTool: AgentTool = {
			name: "unscoped_write_before_hook",
			description: "Mutation without path-scope metadata.",
			parameters: Type.Object({ label: Type.String() }),
			annotations: {
				readOnlyHint: false,
			},
			execute: async (_toolCallId, args) => {
				await sleep(40);
				return {
					content: [{ type: "text", text: `write:${String(args.label)}` }],
				};
			},
		};
		const hookedMutationTool: AgentTool = {
			name: "path_write_hooked_to_unscoped",
			description: "Path-scoped mutation probe that hooks can retarget.",
			parameters: Type.Object({
				label: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `mutate:${String(args.label)}` }],
			}),
		};
		const hookService = {
			runPreToolUseHooks: vi.fn(async (toolCall) => ({
				blocked: false,
				askPermission: false,
				updatedInput:
					toolCall.id === "path-2" ? { label: "after-hook" } : undefined,
				hookResults: [],
			})),
			runPostToolUseHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runEvalGateHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runPostToolUseFailureHooks: vi.fn(async () => ({
				preventContinuation: false,
				hookResults: [],
			})),
			runPermissionRequestHooks: vi.fn(async () => ({
				hookResults: [],
			})),
		} satisfies ToolHookService;

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const toolCall of [
					{
						id: "unscoped-1",
						name: "unscoped_write_before_hook",
						arguments: { label: "before" },
					},
					{
						id: "path-2",
						name: "path_write_hooked_to_unscoped",
						arguments: { path: "src/before-hook.ts" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							...toolCall,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "complete" }],
				"stop",
			);
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
		const userMessage: Message = {
			role: "user",
			content:
				"Run a queued write, then let the hook remove path-scoped arguments.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			hookService,
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [unscopedMutationTool, hookedMutationTool],
				model,
			}),
		);
		const toolResultsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
						event.type === "tool_execution_end",
				)
				.map((event) => [event.toolCallId, event]),
		);
		const scheduling = toolResultsById.get("path-2")?.scheduling;

		expect(toolResultsById.get("path-2")?.result.content).toEqual([
			{ type: "text", text: "mutate:after-hook" },
		]);
		expect(scheduling).toMatchObject({
			classification: "serialized_mutation",
			reason: "mutating_tool",
			queueDepth: 0,
			pendingMutations: 0,
		});
		expect(scheduling).not.toHaveProperty("pathArgumentKeys");
		expect(scheduling).not.toHaveProperty("pathScope");
		expect(scheduling).not.toHaveProperty("pathScopeSource");
	});

	it("does not label path-scoped mutations behind read-only waves as pending mutations", async () => {
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Slow read-only probe.",
			parameters: Type.Object({ label: Type.String() }),
			annotations: {
				readOnlyHint: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(40);
				return {
					content: [{ type: "text", text: `read:${String(args.label)}` }],
				};
			},
		};
		const pathWriteTool: AgentTool = {
			name: "path_write_after_read",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `path:${String(args.path)}` }],
			}),
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const toolCall of [
					{
						id: "read-1",
						name: "read_probe",
						arguments: { label: "first" },
					},
					{
						id: "path-2",
						name: "path_write_after_read",
						arguments: { path: "src/after-read.ts" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							...toolCall,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "complete" }],
				"stop",
			);
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
		const userMessage: Message = {
			role: "user",
			content: "Run a read, then a path-scoped write.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool, pathWriteTool],
				model,
			}),
		);
		const toolStartsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
						event.type === "tool_execution_start",
				)
				.map((event) => [event.toolCallId, event]),
		);
		const toolResultsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
						event.type === "tool_execution_end",
				)
				.map((event) => [event.toolCallId, event]),
		);

		expect(toolStartsById.get("path-2")?.scheduling).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "path_scope_available",
			pendingMutations: 0,
			pathArgumentKeys: ["path"],
		});
		expect(toolResultsById.get("path-2")?.scheduling).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "path_scope_available",
			pendingMutations: 0,
			pathArgumentKeys: ["path"],
		});
	});

	it("preserves blocked scheduling when steering skips a pre-drained tool call", async () => {
		const unscopedMutationTool = {
			name: "mcp__trusted_remote__unscoped_write",
			description: "Mutation without path-scope metadata.",
			parameters: Type.Object({ label: Type.String() }),
			annotations: {
				readOnlyHint: false,
			},
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "unscoped_write",
				supportsParallelToolCalls: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(40);
				return {
					content: [{ type: "text", text: `write:${String(args.label)}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		let pathExecutionCount = 0;
		const pathWriteTool: AgentTool = {
			name: "path_write_after_steering",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async () => {
				pathExecutionCount += 1;
				throw new Error("path write should be skipped by steering");
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const toolCall of [
					{
						id: "unscoped-1",
						name: "mcp__trusted_remote__unscoped_write",
						arguments: { label: "before" },
					},
					{
						id: "path-2",
						name: "path_write_after_steering",
						arguments: { path: "src/after.ts" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							...toolCall,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "steering handled" }],
				"stop",
			);
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
		let steeringPollCount = 0;
		const getSteeringMessages = async () => {
			steeringPollCount += 1;
			if (steeringPollCount === 2) {
				const llm: Message = {
					role: "user",
					content: "Stop before the scoped write.",
					timestamp: Date.now(),
				};
				return [{ id: 1, createdAt: Date.now(), original: llm, llm }];
			}
			return [];
		};
		const userMessage: Message = {
			role: "user",
			content: "Run an unscoped write, then stop before the scoped write.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [unscopedMutationTool, pathWriteTool],
				model,
				getSteeringMessages,
			}),
		);
		const toolStartsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
						event.type === "tool_execution_start",
				)
				.map((event) => [event.toolCallId, event]),
		);
		const toolResultsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
						event.type === "tool_execution_end",
				)
				.map((event) => [event.toolCallId, event]),
		);

		expect(toolResultsById.get("unscoped-1")?.isError).toBe(false);
		expect(pathExecutionCount).toBe(0);
		expect(toolStartsById.get("path-2")?.scheduling).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "pending_mutation",
			queueDepth: 1,
			pendingMutations: 1,
			pathArgumentKeys: ["path"],
		});
		expect(toolResultsById.get("path-2")?.scheduling).toMatchObject({
			classification: "path_scoped_mutation",
			reason: "pending_mutation",
			queueDepth: 1,
			pendingMutations: 1,
			pathArgumentKeys: ["path"],
		});
		expect(toolResultsById.get("path-2")?.result.content).toEqual([
			{ type: "text", text: "Skipped due to queued user message." },
		]);
	});

	it("classifies steering-skipped tool events from tool metadata", async () => {
		const writeProbeTool: AgentTool = {
			name: "write_probe",
			description: "Serialized mutation probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `write:${String(args.slot)}` }],
			}),
		};
		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only skipped probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `read:${String(args.slot)}` }],
			}),
		};
		const parallelSafeMutationTool = {
			name: "mcp__trusted_remote__mutate",
			description: "Parallel-safe skipped mutation probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: false,
			},
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "mutate",
				supportsParallelToolCalls: true,
			},
			execute: async (_toolCallId: string, args: Record<string, unknown>) => ({
				content: [{ type: "text" as const, text: `mutate:${args.slot}` }],
			}),
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};
		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const toolCall of [
					{
						id: "write-1",
						name: "write_probe",
						arguments: { slot: 1 },
					},
					{
						id: "read-2",
						name: "read_probe",
						arguments: { slot: 2 },
					},
					{
						id: "trusted-3",
						name: "mcp__trusted_remote__mutate",
						arguments: { slot: 3 },
					},
					{
						id: "write-4",
						name: "write_probe",
						arguments: { slot: 4 },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							...toolCall,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "steering handled" }],
				"stop",
			);
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
		let steeringPollCount = 0;
		let returnedSteering = false;
		const getSteeringMessages = async () => {
			steeringPollCount += 1;
			if (steeringPollCount >= 2 && !returnedSteering) {
				returnedSteering = true;
				const llm: Message = {
					role: "user",
					content: "Stop after the first mutation.",
					timestamp: Date.now(),
				};
				return [{ id: 1, createdAt: Date.now(), original: llm, llm }];
			}
			return [];
		};
		const userMessage: Message = {
			role: "user",
			content: "Run three writes, then accept steering.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [writeProbeTool, readProbeTool, parallelSafeMutationTool],
				model,
				getSteeringMessages,
			}),
		);
		const toolStartsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
						event.type === "tool_execution_start",
				)
				.map((event) => [event.toolCallId, event]),
		);
		const toolResultsById = new Map(
			events
				.filter(
					(
						event,
					): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
						event.type === "tool_execution_end",
				)
				.map((event) => [event.toolCallId, event]),
		);

		expect(toolResultsById.get("write-1")?.isError).toBe(false);
		expect(toolStartsById.get("read-2")?.scheduling).toMatchObject({
			classification: "read_only",
			reason: "read_only_tool",
			concurrencyLimit: 2,
		});
		expect(toolResultsById.get("read-2")?.scheduling).toMatchObject({
			classification: "read_only",
			reason: "read_only_tool",
			concurrencyLimit: 2,
		});
		expect(toolStartsById.get("trusted-3")?.scheduling).toMatchObject({
			classification: "parallel_safe_mutation",
			reason: "mcp_parallel_opt_in",
			concurrencyLimit: 2,
		});
		expect(toolResultsById.get("trusted-3")?.scheduling).toMatchObject({
			classification: "parallel_safe_mutation",
			reason: "mcp_parallel_opt_in",
			concurrencyLimit: 2,
		});
		expect(toolStartsById.get("write-4")?.scheduling).toMatchObject({
			classification: "serialized_mutation",
			reason: "mutating_tool",
		});
		expect(toolResultsById.get("write-4")?.scheduling).toMatchObject({
			classification: "serialized_mutation",
			reason: "mutating_tool",
		});
	});

	it("reuses read-only results across adjacent turns and invalidates after mutation", async () => {
		let readExecutionCount = 0;
		let writeExecutionCount = 0;

		const readProbeTool: AgentTool = {
			name: "cacheable_read_probe",
			description: "Cacheable read-only probe.",
			parameters: Type.Object({ key: Type.String() }),
			annotations: {
				readOnlyHint: true,
			},
			execute: async (_toolCallId, args) => {
				readExecutionCount += 1;
				await sleep(20);
				return {
					content: [
						{
							type: "text",
							text: `read:${String(args.key)}:${readExecutionCount}`,
						},
					],
				};
			},
		};
		const writeProbeTool: AgentTool = {
			name: "cache_invalidating_write",
			description: "Mutation probe.",
			parameters: Type.Object({ label: Type.String() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
			},
			execute: async (_toolCallId, args) => {
				writeExecutionCount += 1;
				await sleep(5);
				return {
					content: [{ type: "text", text: `write:${String(args.label)}` }],
				};
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			const toolUseTurns: Record<
				number,
				Array<{
					id: string;
					name: string;
					arguments: Record<string, unknown>;
				}>
			> = {
				1: [
					{
						id: "read-1",
						name: "cacheable_read_probe",
						arguments: { key: "same" },
					},
				],
				2: [
					{
						id: "read-2",
						name: "cacheable_read_probe",
						arguments: { key: "same" },
					},
				],
				3: [
					{
						id: "write-1",
						name: "cache_invalidating_write",
						arguments: { label: "invalidate" },
					},
					{
						id: "read-3",
						name: "cacheable_read_probe",
						arguments: { key: "same" },
					},
				],
				4: [
					{
						id: "read-4",
						name: "cacheable_read_probe",
						arguments: { key: "same" },
					},
				],
			};
			const calls = toolUseTurns[streamCount];
			if (calls) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const call of calls) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: call.id,
							name: call.name,
							arguments: call.arguments,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "cache reuse complete" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content:
				"Read the same key, read it again, mutate state, then read it twice after the mutation.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 4,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool, writeProbeTool],
				model,
			}),
		);

		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		const toolResultsById = new Map(
			toolResults.map((event) => [event.toolCallId, event]),
		);

		expect(toolResults).toHaveLength(5);
		expect(readExecutionCount).toBe(2);
		expect(writeExecutionCount).toBe(1);
		expect(toolResultsById.get("read-2")?.scheduling?.cache).toBe("hit");
		expect(toolResultsById.get("read-2")?.scheduling?.reason).toBe("cache_hit");
		expect(toolResultsById.get("read-3")?.scheduling?.cache).toBe("miss");
		expect(toolResultsById.get("read-4")?.scheduling?.cache).toBe("hit");
	});

	it("preserves configured concurrency cap for parallel-safe MCP mutations", async () => {
		const records: TimedToolRecord[] = [];
		let activeMutations = 0;
		let maxActiveMutations = 0;

		const parallelSafeMutationTool = {
			name: "mcp__trusted_remote__mutate",
			description: "Parallel-safe remote mutation probe.",
			parameters: Type.Object({ slot: Type.Integer() }),
			annotations: {
				readOnlyHint: false,
			},
			source: {
				type: "mcp",
				server: "trusted-remote",
				tool: "mutate",
				supportsParallelToolCalls: true,
			},
			execute: async (toolCallId: string, args: Record<string, unknown>) => {
				activeMutations += 1;
				maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "commit",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(60);
				activeMutations -= 1;
				record.endedAt = performance.now();
				return {
					content: [{ type: "text", text: `mutate:${String(args.slot)}` }],
				};
			},
		} satisfies AgentTool & {
			source: {
				type: "mcp";
				server: string;
				tool: string;
				supportsParallelToolCalls: boolean;
			};
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const slot of [1, 2]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: `mutate-${slot}`,
							name: "mcp__trusted_remote__mutate",
							arguments: { slot },
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage(
				[{ type: "text", text: "mutations complete" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content: "Run two trusted remote mutations.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 1,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [parallelSafeMutationTool],
				model,
			}),
		);

		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);

		expect(toolResults).toHaveLength(2);
		expect(records).toHaveLength(2);
		expect(maxActiveMutations).toBe(1);
		expect(records[1]?.startedAt).toBeGreaterThanOrEqual(
			records[0]?.endedAt ?? 0,
		);
	});
});
