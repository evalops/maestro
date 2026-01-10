import { describe, expect, it, vi } from "vitest";
import { TodoContextSource } from "../../src/agent/context-providers.js";
import type { TodoStore } from "../../src/tools/todo.js";
import * as todoTool from "../../src/tools/todo.js";

// Mock the todo tool
vi.mock("../../src/tools/todo.js", async () => {
	const actual = await vi.importActual("../../src/tools/todo.js");
	return {
		...actual,
		loadStore: vi.fn(),
	};
});

describe("TodoContextSource", () => {
	it("formats context with correct double-newline spacing between sections", async () => {
		const mockStore: TodoStore = {
			"goal-1": {
				goal: "Build a rocket",
				updatedAt: new Date().toISOString(),
				items: [
					{
						id: "1",
						content: "Buy fuel",
						status: "pending",
						priority: "medium",
					},
					{ id: "2", content: "Launch", status: "pending", priority: "medium" },
				],
			},
		};

		vi.mocked(todoTool.loadStore).mockResolvedValue(mockStore);

		const source = new TodoContextSource();
		const result = await source.getSystemPromptAdditions();

		expect(result).toBeTruthy();

		// Verify general structure
		expect(result).toContain("# Current Task Context");
		expect(result).toContain("Goal");
		expect(result).toContain("Build a rocket");
		expect(result).toContain("Checklist"); // formatTodosSection produces "Checklist" header? or just items?
		// Actually formatTodosSection produces "Checklist" header in todo.ts:
		// export function formatTodosSection(items: NormalizedTodo[]): string {
		//    return `Checklist\n${sectionDivider}\n...`;
		// }

		// Verify spacing by splitting
		// We expect \n\n between major sections we joined.
		// result is `# Current Task Context\n${goal}\n\n${summary}\n\n${todos}`

		// goal section ends with content
		// summary section starts with "Progress" (from formatSummarySection)
		// todos section starts with "Checklist"

		expect(result).toContain("\n\nProgress");
		expect(result).toContain("\n\nChecklist");
	});

	it("returns null when no active goal", async () => {
		vi.mocked(todoTool.loadStore).mockResolvedValue({});

		const source = new TodoContextSource();
		const result = await source.getSystemPromptAdditions();
		expect(result).toBeNull();
	});
});
