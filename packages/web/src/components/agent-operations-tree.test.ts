import { describe, expect, it } from "vitest";
import type { TrajectoryReplayLabTimelineItem } from "../services/api-client.types.js";
import { buildAgentOperationsTree } from "./agent-operations-tree.js";

function item(
	id: string,
	runId: string,
	timestamp: string,
	status: string,
	overrides: Partial<TrajectoryReplayLabTimelineItem> = {},
): TrajectoryReplayLabTimelineItem {
	return {
		id,
		timestamp,
		type: "agent.progress",
		title: id,
		status,
		source: "local",
		visibility: "user",
		agentRunId: runId,
		...overrides,
	};
}

describe("buildAgentOperationsTree", () => {
	it("builds parent and child runs with their latest status", () => {
		const roots = buildAgentOperationsTree([
			item("parent-start", "parent", "2026-07-14T00:00:00.000Z", "running"),
			item("child-spawn", "parent", "2026-07-14T00:00:01.000Z", "running", {
				parentAgentRunId: "parent",
				childAgentRunId: "child",
			}),
			item("child-done", "child", "2026-07-14T00:00:02.000Z", "completed", {
				parentAgentRunId: "parent",
			}),
		]);

		expect(roots).toHaveLength(1);
		expect(roots[0]).toMatchObject({
			runId: "parent",
			status: "running",
			children: [
				{
					runId: "child",
					parentRunId: "parent",
					status: "completed",
					latestItem: { id: "child-done" },
				},
			],
		});
	});

	it("keeps missing ancestors as roots and sorts deterministically", () => {
		const roots = buildAgentOperationsTree([
			item("z-old", "z-run", "2026-07-14T00:00:00.000Z", "running", {
				parentAgentRunId: "missing",
			}),
			item("a-latest", "a-run", "2026-07-14T00:00:03.000Z", "failed"),
			item("z-latest", "z-run", "2026-07-14T00:00:03.000Z", "completed", {
				parentAgentRunId: "missing",
			}),
		]);

		expect(roots.map((node) => node.runId)).toEqual(["a-run", "z-run"]);
		expect(roots[1]).toMatchObject({
			parentRunId: "missing",
			status: "completed",
			latestItem: { id: "z-latest" },
		});
	});

	it("creates a child node from a spawn record before child progress arrives", () => {
		const roots = buildAgentOperationsTree([
			item("spawn", "parent", "2026-07-14T00:00:00.000Z", "running", {
				parentAgentRunId: "parent",
				childAgentRunId: "child",
			}),
		]);

		expect(roots[0]?.children[0]).toMatchObject({
			runId: "child",
			parentRunId: "parent",
			status: "running",
			latestItem: { id: "spawn" },
		});
	});
});
