import { describe, expect, it } from "vitest";
import { buildAgentLineageProjection } from "../../src/session/agent-lineage-projection.js";
import type { SessionTreeEntry } from "../../src/session/types.js";

function graph(toolCallId: string, tool: string, status: string) {
	return {
		schemaVersion: "evalops.maestro.codex.subagent-workgraph.v1",
		toolCallId,
		tool,
		status,
		parent: {
			threadId: "parent-thread",
			turnId: "parent-turn",
			senderThreadId: "parent-thread",
		},
		childRuns: [
			{
				edgeId: `${toolCallId}:0:${tool}:child-run-1`,
				threadId: "child-thread-1",
				childRunId: "child-run-1",
				operation: tool,
				status,
			},
		],
	};
}

describe("agent lineage projection", () => {
	it("aggregates child lifecycle operations into one durable edge", () => {
		const entries = [
			{
				type: "message",
				id: "assistant-spawn",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "spawn-call",
							name: "codex.subagent.spawnAgent",
							arguments: {
								codexWorkGraph: graph("spawn-call", "spawnAgent", "inProgress"),
							},
						},
					],
				},
			},
			{
				type: "message",
				id: "spawn-result",
				parentId: "assistant-spawn",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "spawn-call",
					toolName: "codex.subagent.spawnAgent",
					content: [],
					details: {
						codexWorkGraph: graph("spawn-call", "spawnAgent", "spawned"),
					},
					isError: false,
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "assistant-wait",
				parentId: "spawn-result",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "wait-call",
							name: "codex.subagent.wait",
							arguments: {
								codex_work_graph: graph("wait-call", "wait", "waitPending"),
							},
						},
					],
				},
			},
			{
				type: "message",
				id: "wait-result",
				parentId: "assistant-wait",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: {
					role: "toolResult",
					toolCallId: "wait-call",
					toolName: "codex.subagent.wait",
					content: [],
					details: { codexWorkGraph: graph("wait-call", "wait", "completed") },
					isError: false,
					timestamp: 4,
				},
			},
		] as SessionTreeEntry[];

		const projection = buildAgentLineageProjection(entries);

		expect(projection.edges).toEqual([
			expect.objectContaining({
				childRunId: "child-run-1",
				childThreadId: "child-thread-1",
				parentThreadId: "parent-thread",
				parentTurnId: "parent-turn",
				spawnToolCallId: "spawn-call",
				lastToolCallId: "wait-call",
				lastOperation: "wait",
				status: "completed",
			}),
		]);
		expect(
			projection.operations.map(({ toolCallId, operation, status }) => ({
				toolCallId,
				operation,
				status,
			})),
		).toEqual([
			{ toolCallId: "spawn-call", operation: "spawnAgent", status: "spawned" },
			{ toolCallId: "wait-call", operation: "wait", status: "completed" },
		]);
	});
});
