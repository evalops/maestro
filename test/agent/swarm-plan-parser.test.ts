import { describe, expect, it } from "vitest";
import { parsePlanContent } from "../../src/agent/swarm/plan-parser.js";

describe("Swarm plan parser", () => {
	it("resolves dependencies to full task IDs", () => {
		const content = `
# Plan: Demo

1. Implement A
2. Implement B after task 1
3. Implement C depends on task 2
`;

		const plan = parsePlanContent(content);
		expect(plan.tasks).toHaveLength(3);

		const [task1, task2, task3] = plan.tasks;
		expect(task2.dependsOn).toEqual([task1.id]);
		expect(task3.dependsOn).toEqual([task2.id]);
	});
});
