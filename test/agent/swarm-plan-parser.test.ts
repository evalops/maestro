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
		expect(task2!.dependsOn).toEqual([task1!.id]);
		expect(task3!.dependsOn).toEqual([task2!.id]);
	});

	it("ignores dependencies on completed tasks but keeps ordering for incomplete ones", () => {
		const content = `
# Plan: Demo

- [x] Completed first
- [ ] Second after task 1
- [ ] Third depends on task 2
`;

		const plan = parsePlanContent(content);
		expect(plan.tasks).toHaveLength(2);

		const [second, third] = plan.tasks;
		// Dependency on completed task 1 is already satisfied.
		expect(second!.dependsOn).toBeUndefined();
		// Third should depend on second.
		expect(third!.dependsOn).toEqual([second!.id]);
	});

	it("parses per-task mocksAllowed markers without leaking them into prompts", () => {
		const content = `
# Plan: Demo

- [ ] Implement the OAuth smoke [mocks allowed] in \`src/oauth.ts\`
- [ ] Validate billing against real data [mocksAllowed=false]
`;

		const plan = parsePlanContent(content);
		expect(plan.tasks).toHaveLength(2);

		expect(plan.tasks[0]).toEqual(
			expect.objectContaining({
				mocksAllowed: true,
				prompt: "Implement the OAuth smoke in `src/oauth.ts`",
				files: ["src/oauth.ts"],
			}),
		);
		expect(plan.tasks[1]).toEqual(
			expect.objectContaining({
				mocksAllowed: false,
				prompt: "Validate billing against real data",
			}),
		);
	});

	it("gives strict mock markers precedence over allow markers", () => {
		const content = `
# Plan: Demo

- [ ] Validate OAuth against real data [mocks allowed] [mocksAllowed=false]
`;

		const plan = parsePlanContent(content);
		expect(plan.tasks).toHaveLength(1);
		expect(plan.tasks[0]).toEqual(
			expect.objectContaining({
				mocksAllowed: false,
				prompt: "Validate OAuth against real data",
			}),
		);
	});

	it("preserves descriptive bracketed real-integration text", () => {
		const content = `
# Plan: Demo

- [ ] Validate OAuth [real integration] against staging
`;

		const plan = parsePlanContent(content);
		expect(plan.tasks).toHaveLength(1);
		expect(plan.tasks[0]).toEqual(
			expect.objectContaining({
				prompt: "Validate OAuth [real integration] against staging",
			}),
		);
		expect(plan.tasks[0]?.mocksAllowed).toBeUndefined();
	});
});
