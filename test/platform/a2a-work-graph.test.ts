import { describe, expect, it } from "vitest";
import {
	extractA2AWorkGraphMetadata,
	formatA2AWorkGraphCodexSubagents,
	formatA2AWorkGraphSummary,
	normalizeA2AWorkGraphMetadata,
} from "../../src/platform/a2a-work-graph.js";

describe("extractA2AWorkGraphMetadata", () => {
	it("pulls workGraph off task.metadata and normalizes it", () => {
		const graph = extractA2AWorkGraphMetadata({
			metadata: { workGraph: { state: "running", itemCount: 4 } },
		});
		expect(graph).toMatchObject({ state: "running", itemCount: 4 });
	});

	it("returns undefined when there is no metadata or workGraph", () => {
		expect(extractA2AWorkGraphMetadata({ metadata: {} })).toBeUndefined();
		expect(extractA2AWorkGraphMetadata({})).toBeUndefined();
		expect(extractA2AWorkGraphMetadata(undefined)).toBeUndefined();
	});
});

describe("normalizeA2AWorkGraphMetadata", () => {
	it("returns undefined for non-record input", () => {
		expect(normalizeA2AWorkGraphMetadata("nope")).toBeUndefined();
		expect(normalizeA2AWorkGraphMetadata(null)).toBeUndefined();
		expect(normalizeA2AWorkGraphMetadata([1, 2])).toBeUndefined();
	});

	it("returns undefined when nothing carries a work-graph signal", () => {
		expect(normalizeA2AWorkGraphMetadata({})).toBeUndefined();
	});

	it("treats an explicit zero count as a signal (0 !== undefined)", () => {
		// hasWorkGraphSignal checks `!== undefined`, so a literal 0 is still signal.
		const graph = normalizeA2AWorkGraphMetadata({ itemCount: 0 });
		expect(graph).toMatchObject({ itemCount: 0 });
	});

	it("normalizes numeric strings into numbers and keeps finite numbers", () => {
		const graph = normalizeA2AWorkGraphMetadata({
			itemCount: "5",
			activeItemCount: 3,
			childRunCount: "not-a-number",
		});
		expect(graph?.itemCount).toBe(5);
		expect(graph?.activeItemCount).toBe(3);
		// non-numeric string is dropped, so no signal from childRunCount
		expect(graph?.childRunCount).toBeUndefined();
	});

	it("trims strings, rejects blanks, and dedups id lists", () => {
		const graph = normalizeA2AWorkGraphMetadata({
			state: "  running  ",
			correlationPath: "   ",
			childRunIds: ["a", "a", "b", 123, ""],
		});
		expect(graph?.state).toBe("running");
		// blank correlationPath is dropped -> not present
		expect(graph?.correlationPath).toBeUndefined();
		// dedup + non-strings filtered
		expect(graph?.childRunIds).toEqual(["a", "b"]);
	});

	it("normalizes stateCounts, dropping non-numeric entries", () => {
		const graph = normalizeA2AWorkGraphMetadata({
			stateCounts: { running: 2, done: "1", blocked: "x" },
		});
		expect(graph?.stateCounts).toEqual({ running: 2, done: 1 });
	});

	it("attaches a codexSubagents block when it has signal", () => {
		const graph = normalizeA2AWorkGraphMetadata({
			codexSubagents: {
				toolCallIds: ["call_1"],
				childRunIds: [],
				threadIds: [],
				edgeCount: 3,
			},
		});
		expect(graph?.codexSubagents).toMatchObject({
			toolCallIds: ["call_1"],
			edgeCount: 3,
		});
		// codexSubagents alone is enough signal to keep the graph
		expect(graph?.state).toBeUndefined();
	});

	it("drops a codexSubagents block that carries no signal", () => {
		const graph = normalizeA2AWorkGraphMetadata({
			state: "running",
			codexSubagents: { toolCallIds: [], childRunIds: [], threadIds: [] },
		});
		expect(graph?.state).toBe("running");
		expect(graph?.codexSubagents).toBeUndefined();
	});

	it("dedups codex subagent edges by lifecycle identity", () => {
		const graph = normalizeA2AWorkGraphMetadata({
			codexSubagents: {
				toolCallIds: ["call_1"],
				edges: [
					{ spawnToolCallId: "call_1", operation: "spawn", status: "ok" },
					{ spawnToolCallId: "call_1", operation: "spawn", status: "ok" }, // dup
					{ spawnToolCallId: "call_2", operation: "spawn", status: "ok" }, // distinct
					{ operation: "x" }, // no spawn/wait/childRun/thread id -> dropped
				],
			},
		});
		const edges = graph?.codexSubagents?.edges ?? [];
		expect(edges).toHaveLength(2);
		expect(edges.map((e) => e.spawnToolCallId).sort()).toEqual([
			"call_1",
			"call_2",
		]);
	});
});

describe("formatA2AWorkGraphSummary", () => {
	it("returns undefined for undefined / signal-less graphs", () => {
		expect(formatA2AWorkGraphSummary(undefined)).toBeUndefined();
		expect(
			formatA2AWorkGraphSummary({
				childRunIds: [],
				toolExecutionIds: [],
				waitIds: [],
			}),
		).toBeUndefined();
	});

	it("renders state and counts, joining with ' | '", () => {
		const out = formatA2AWorkGraphSummary({
			state: "running",
			itemCount: 10,
			activeItemCount: 4,
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
		});
		expect(out).toBe("Work graph: running | items 10 | active 4");
	});

	it("only surfaces blocked/waiting/pending counts when they are positive", () => {
		const zero = formatA2AWorkGraphSummary({
			itemCount: 5,
			blockedItemCount: 0,
			waitingItemCount: 0,
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
		});
		expect(zero).toBe("Work graph: items 5");

		const positive = formatA2AWorkGraphSummary({
			itemCount: 5,
			blockedItemCount: 2,
			waitingItemCount: 1,
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
		});
		expect(positive).toBe("Work graph: items 5 | blocked 2 | waiting 1");
	});
});

describe("formatA2AWorkGraphCodexSubagents", () => {
	it("returns undefined when there is no codexSubagents block", () => {
		expect(
			formatA2AWorkGraphCodexSubagents({
				childRunIds: [],
				toolExecutionIds: [],
				waitIds: [],
			}),
		).toBeUndefined();
		expect(formatA2AWorkGraphCodexSubagents(undefined)).toBeUndefined();
	});

	it("renders edge count, lifecycle, and id lists", () => {
		const out = formatA2AWorkGraphCodexSubagents({
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
			codexSubagents: {
				toolCallIds: ["t1"],
				childRunIds: ["r1"],
				threadIds: ["th1"],
				edgeCount: 2,
				edges: [
					{
						spawnToolCallId: "t1",
						operation: "spawn",
						status: "ok",
						childRunId: "r1",
					},
				],
			},
		});
		expect(out).toContain("Codex subagents:");
		expect(out).toContain("edges 2");
		expect(out).toContain("child runs r1");
		expect(out).toContain("tools t1");
		expect(out).toContain("threads th1");
		// lifecycle renders operation:status(childRunId)
		expect(out).toContain("lifecycle spawn:ok(r1)");
	});

	it("caps id lists at 3 with a '(+N more)' overflow", () => {
		const out = formatA2AWorkGraphCodexSubagents({
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
			codexSubagents: {
				toolCallIds: ["t1", "t2", "t3", "t4", "t5"],
				childRunIds: [],
				threadIds: [],
			},
		});
		expect(out).toContain("tools t1, t2, t3 (+2 more)");
	});
});
