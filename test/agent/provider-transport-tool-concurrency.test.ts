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
		expect(inspectStartSpread).toBeLessThan(40);
		expect(commitRecord.startedAt).toBeGreaterThanOrEqual(latestInspectEnd);
		expect(mutationOverlapCount).toBe(0);
		expect(earliestVerifyStart).toBeGreaterThanOrEqual(commitRecord.endedAt);
		expect(verifyStartSpread).toBeLessThan(40);
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

		expect(toolResults).toHaveLength(9);
		expect(trustedMcpSpread).toBeLessThan(40);
		expect(untrustedMcpSpread).toBeGreaterThanOrEqual(25);
		expect(disjointMutationSpread).toBeLessThan(40);
		expect(overlappingWriteRecord.startedAt).toBeGreaterThanOrEqual(
			writeBRecord.endedAt,
		);
		expect(verifyStartGap).toBeLessThan(25);
		expect(unsafeOverlapCount).toBe(0);
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
