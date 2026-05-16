import { describe, expect, it } from "vitest";
import {
	assertBoundedDynamicToolUse,
	assertSubagentWorkGraphUse,
	getFinalAssistantText,
	parseJsonlEvents,
	summarizeDynamicToolCalls,
} from "../../scripts/smoke-codex-app-server-live.mjs";

function jsonl(events: unknown[]): string {
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const token = "visible non secret smoke token";

function successfulEvents() {
	return [
		{
			type: "item",
			subtype: "tool_call",
			data: {
				toolCallId: "call-read-1",
				toolName: "read",
				args: { path: "/tmp/token.txt" },
			},
		},
		{
			type: "item",
			subtype: "tool_result",
			data: {
				toolCallId: "call-read-1",
				toolName: "read",
				isError: false,
			},
		},
		{
			type: "item",
			subtype: "message_complete",
			data: { text: token },
		},
	];
}

function codexWorkGraph(
	tool: "spawnAgent" | "wait",
	toolCallId: string,
	options: {
		emptyChildRuns?: boolean;
		threadId?: string;
		childRunId?: string;
	} = {},
) {
	const threadId = options.threadId ?? "child-thread-1";
	const childRunId = options.childRunId ?? "codex-thread:child-thread-1";
	return {
		schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
		toolCallId,
		tool,
		status: "completed",
		parent: {
			threadId: "parent-thread",
			turnId: "turn-1",
			senderThreadId: "parent-thread",
		},
		childRuns: options.emptyChildRuns
			? []
			: [
					{
						threadId,
						childRunId,
						operation: tool,
					},
				],
	};
}

function subagentEvents(
	options: {
		includeSpawnGraph?: boolean;
		includeWaitGraph?: boolean;
		includeWait?: boolean;
		emptySpawnCallChildRuns?: boolean;
		waitThreadId?: string;
		waitChildRunId?: string;
		waitStatus?: string;
		extraSpawn?: boolean;
		extraWait?: boolean;
		finalText?: string;
	} = {},
) {
	const {
		includeSpawnGraph = true,
		includeWaitGraph = true,
		includeWait = true,
		emptySpawnCallChildRuns = false,
		waitThreadId = "child-thread-1",
		waitChildRunId = "codex-thread:child-thread-1",
		waitStatus = "completed",
		extraSpawn = false,
		extraWait = false,
		finalText = token,
	} = options;
	const spawnToolCallId = "collab-spawn-1";
	const waitToolCallId = "collab-wait-1";
	const spawnEvents = [
		{
			type: "item",
			subtype: "tool_call",
			data: {
				toolCallId: spawnToolCallId,
				toolName: "codex.subagent.spawnAgent",
				args: {
					codexTool: "spawnAgent",
					receiverThreadIds: ["child-thread-1"],
					childRunIds: ["codex-thread:child-thread-1"],
					...(includeSpawnGraph
						? {
								codexWorkGraph: codexWorkGraph("spawnAgent", spawnToolCallId, {
									emptyChildRuns: emptySpawnCallChildRuns,
								}),
							}
						: {}),
				},
			},
		},
		{
			type: "item",
			subtype: "tool_result",
			data: {
				toolCallId: spawnToolCallId,
				toolName: "codex.subagent.spawnAgent",
				result: {
					role: "toolResult",
					toolCallId: spawnToolCallId,
					toolName: "codex.subagent.spawnAgent",
					details: {
						codexTool: "spawnAgent",
						receiverThreadIds: ["child-thread-1"],
						childRunIds: ["codex-thread:child-thread-1"],
						...(includeSpawnGraph
							? {
									codexWorkGraph: codexWorkGraph("spawnAgent", spawnToolCallId),
								}
							: {}),
					},
					isError: false,
				},
				isError: false,
			},
		},
	];
	const events: unknown[] = extraSpawn
		? [
				...spawnEvents,
				...spawnEvents.map((event) => ({
					...event,
					data: {
						...event.data,
						toolCallId: "collab-spawn-2",
					},
				})),
			]
		: [...spawnEvents];

	if (includeWait) {
		const waitEvents = [
			{
				type: "item",
				subtype: "tool_call",
				data: {
					toolCallId: waitToolCallId,
					toolName: "codex.subagent.wait",
					args: {
						codexTool: "wait",
						receiverThreadIds: [waitThreadId],
						childRunIds: [waitChildRunId],
						...(includeWaitGraph
							? {
									codexWorkGraph: codexWorkGraph("wait", waitToolCallId, {
										threadId: waitThreadId,
										childRunId: waitChildRunId,
									}),
								}
							: {}),
					},
				},
			},
			{
				type: "item",
				subtype: "tool_result",
				data: {
					toolCallId: waitToolCallId,
					toolName: "codex.subagent.wait",
					result: {
						role: "toolResult",
						toolCallId: waitToolCallId,
						toolName: "codex.subagent.wait",
						details: {
							codexTool: "wait",
							receiverThreadIds: [waitThreadId],
							childRunIds: [waitChildRunId],
							agentsStates: {
								[waitThreadId]: {
									status: waitStatus,
									lastMessage: token,
								},
							},
							...(includeWaitGraph
								? {
										codexWorkGraph: codexWorkGraph("wait", waitToolCallId, {
											threadId: waitThreadId,
											childRunId: waitChildRunId,
										}),
									}
								: {}),
						},
						isError: false,
					},
					isError: false,
				},
			},
		];
		events.push(
			...(extraWait
				? [
						...waitEvents,
						...waitEvents.map((event) => ({
							...event,
							data: {
								...event.data,
								toolCallId: "collab-wait-2",
							},
						})),
					]
				: waitEvents),
		);
	}

	events.push({
		type: "item",
		subtype: "message_complete",
		data: { text: finalText },
	});
	return events;
}

describe("Codex live smoke evidence helpers", () => {
	it("parses JSONL events and extracts the final assistant text", () => {
		const events = parseJsonlEvents(jsonl(successfulEvents()));

		expect(events).toHaveLength(3);
		expect(getFinalAssistantText(events)).toBe(token);
	});

	it("fails fast on malformed JSONL smoke output", () => {
		expect(() =>
			parseJsonlEvents(`${JSON.stringify(successfulEvents()[0])}\nnot-json\n`),
		).toThrow("non-JSON output");
	});

	it("summarizes dynamic tool call cardinality by stable arguments", () => {
		const events = parseJsonlEvents(
			jsonl([
				...successfulEvents(),
				{
					type: "item",
					subtype: "tool_call",
					data: {
						toolCallId: "call-read-2",
						toolName: "read",
						args: { path: "/tmp/token.txt" },
					},
				},
			]),
		);

		expect(summarizeDynamicToolCalls(events)).toMatchObject({
			totalCalls: 2,
			uniqueCalls: 1,
			maxIdenticalCalls: 2,
		});
	});

	it("summarizes Codex dynamic callbacks by operation args, not volatile IDs", () => {
		const events = parseJsonlEvents(
			jsonl([
				{
					type: "item",
					subtype: "tool_call",
					data: {
						toolCallId: "call-read-1",
						toolName: "read",
						args: {
							codexTool: "read",
							threadId: "thread-1",
							turnId: "turn-1",
							callId: "call-read-1",
							arguments: { path: "/tmp/token.txt" },
						},
					},
				},
				{
					type: "item",
					subtype: "tool_call",
					data: {
						toolCallId: "call-read-2",
						toolName: "read",
						args: {
							codexTool: "read",
							threadId: "thread-1",
							turnId: "turn-1",
							callId: "call-read-2",
							arguments: { path: "/tmp/token.txt" },
						},
					},
				},
			]),
		);

		expect(summarizeDynamicToolCalls(events)).toMatchObject({
			totalCalls: 2,
			uniqueCalls: 1,
			maxIdenticalCalls: 2,
		});
	});

	it("accepts a bounded dynamic read-tool smoke transcript", () => {
		expect(
			assertBoundedDynamicToolUse({
				stdout: jsonl(successfulEvents()),
				expectedToken: token,
				maxTotalToolCalls: 2,
				maxIdenticalToolCalls: 1,
			}),
		).toMatchObject({
			totalCalls: 1,
			uniqueCalls: 1,
			maxIdenticalCalls: 1,
		});
	});

	it("rejects live transcripts with loop-detector warnings", () => {
		expect(() =>
			assertBoundedDynamicToolUse({
				stdout: jsonl(successfulEvents()),
				stderr: "Exact repetition loop detected",
				expectedToken: token,
			}),
		).toThrow("loop warning");
	});

	it("rejects repeated identical dynamic tool calls", () => {
		expect(() =>
			assertBoundedDynamicToolUse({
				stdout: jsonl([
					...successfulEvents(),
					{
						type: "item",
						subtype: "tool_call",
						data: {
							toolCallId: "call-read-2",
							toolName: "read",
							args: { path: "/tmp/token.txt" },
						},
					},
				]),
				expectedToken: token,
				maxIdenticalToolCalls: 1,
			}),
		).toThrow("repeated an identical dynamic tool call 2 times");
	});

	it("requires the final assistant message to exactly match the token", () => {
		expect(() =>
			assertBoundedDynamicToolUse({
				stdout: jsonl([
					...successfulEvents().slice(0, 2),
					{
						type: "item",
						subtype: "message_complete",
						data: { text: `${token}\nextra` },
					},
				]),
				expectedToken: token,
			}),
		).toThrow("did not exactly match expected token");
	});

	it("accepts a subagent spawn/wait transcript with work-graph evidence", () => {
		expect(
			assertSubagentWorkGraphUse({
				stdout: jsonl(subagentEvents()),
				expectedToken: token,
			}),
		).toMatchObject({
			spawnCalls: 1,
			spawnResults: 1,
			waitCalls: 1,
			waitResults: 1,
			childRunCount: 4,
		});
	});

	it("accepts an in-progress spawn call before Codex assigns the child thread", () => {
		expect(
			assertSubagentWorkGraphUse({
				stdout: jsonl(
					subagentEvents({
						emptySpawnCallChildRuns: true,
					}),
				),
				expectedToken: token,
			}),
		).toMatchObject({
			spawnCalls: 1,
			waitCalls: 1,
			childRunCount: 3,
		});
	});

	it("rejects subagent transcripts missing work-graph evidence", () => {
		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(subagentEvents({ includeSpawnGraph: false })),
				expectedToken: token,
			}),
		).toThrow("codexWorkGraph");
	});

	it("requires wait evidence to target the spawned child run", () => {
		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(
					subagentEvents({
						waitThreadId: "other-child-thread",
						waitChildRunId: "codex-thread:other-child-thread",
					}),
				),
				expectedToken: token,
			}),
		).toThrow("do not match spawned childRunIds");
	});

	it("requires structured completed status for the waited child", () => {
		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(
					subagentEvents({
						waitStatus: "not completed",
					}),
				),
				expectedToken: token,
			}),
		).toThrow("is not completed");
	});

	it("requires exactly one spawn and one wait operation", () => {
		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(subagentEvents({ extraSpawn: true })),
				expectedToken: token,
			}),
		).toThrow("exactly one codex.subagent.spawnAgent tool_call");

		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(subagentEvents({ extraWait: true })),
				expectedToken: token,
			}),
		).toThrow("exactly one codex.subagent.wait tool_call");
	});

	it("requires the live subagent proof to wait for the child agent", () => {
		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(subagentEvents({ includeWait: false })),
				expectedToken: token,
			}),
		).toThrow("codex.subagent.wait");
	});

	it("requires the subagent final answer to exactly match the live token", () => {
		expect(() =>
			assertSubagentWorkGraphUse({
				stdout: jsonl(subagentEvents({ finalText: `${token}\nextra` })),
				expectedToken: token,
			}),
		).toThrow("did not exactly match expected token");
	});
});
