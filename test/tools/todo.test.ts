import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import {
	formatGoalSection,
	formatSummarySection,
	formatTodosSection,
	todoTool,
} from "../../src/tools/todo.js";

// Mock safe-mode to avoid plan mode checks
vi.mock("../../src/safety/safe-mode.js", () => ({
	setPlanSatisfied: vi.fn(),
}));

// Helper to extract text from content blocks
function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => {
				return (
					c != null && typeof c === "object" && "type" in c && c.type === "text"
				);
			})
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("todo tool", () => {
	let testDir: string;
	let originalStorePath: string | undefined;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "todo-tool-test-"));
		originalStorePath = process.env.COMPOSER_TODO_FILE;
		process.env.COMPOSER_TODO_FILE = join(testDir, "todos.json");
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (originalStorePath !== undefined) {
			process.env.COMPOSER_TODO_FILE = originalStorePath;
		} else {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_TODO_FILE;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("creating todos", () => {
		it("creates a new todo list", async () => {
			const result = await todoTool.execute("todo-1", {
				goal: "Test goal",
				items: [
					{ content: "Task 1", status: "pending" },
					{ content: "Task 2", status: "pending" },
				],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Test goal");
			expect(output).toContain("Task 1");
			expect(output).toContain("Task 2");
		});

		it("assigns default status of pending", async () => {
			const result = await todoTool.execute("todo-2", {
				goal: "Default status test",
				items: [{ content: "Task without status" }],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Pending");
		});

		it("generates unique IDs for tasks", async () => {
			const result = await todoTool.execute("todo-3", {
				goal: "ID generation test",
				items: [{ content: "Task 1" }, { content: "Task 2" }],
			});

			expect(result.isError).toBeFalsy();
			const details = result.details as { items: Array<{ id: string }> };
			expect(details.items[0].id).toBeDefined();
			expect(details.items[1].id).toBeDefined();
			expect(details.items[0].id).not.toBe(details.items[1].id);
		});

		it("uses provided IDs when specified", async () => {
			const result = await todoTool.execute("todo-4", {
				goal: "Custom ID test",
				items: [{ id: "custom-id-1", content: "Task with custom ID" }],
			});

			const details = result.details as { items: Array<{ id: string }> };
			expect(details.items[0].id).toBe("custom-id-1");
		});

		it("accepts JSON string for items", async () => {
			const itemsJson = JSON.stringify([
				{ content: "JSON Task 1" },
				{ content: "JSON Task 2" },
			]);

			const result = await todoTool.execute("todo-5", {
				goal: "JSON items test",
				items: itemsJson,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("JSON Task 1");
			expect(output).toContain("JSON Task 2");
		});
	});

	describe("updating todos", () => {
		it("updates task status", async () => {
			// Create initial todo
			await todoTool.execute("todo-6", {
				goal: "Update status test",
				items: [{ id: "task-1", content: "Task 1", status: "pending" }],
			});

			// Update status
			const result = await todoTool.execute("todo-7", {
				goal: "Update status test",
				updates: [{ id: "task-1", status: "completed" }],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Completed");
		});

		it("updates task content", async () => {
			await todoTool.execute("todo-8", {
				goal: "Update content test",
				items: [{ id: "task-1", content: "Original content" }],
			});

			const result = await todoTool.execute("todo-9", {
				goal: "Update content test",
				updates: [{ id: "task-1", content: "Updated content" }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Updated content");
			expect(output).not.toContain("Original content");
		});

		it("removes tasks with remove flag", async () => {
			await todoTool.execute("todo-10", {
				goal: "Remove task test",
				items: [
					{ id: "task-1", content: "Task to keep" },
					{ id: "task-2", content: "Task to remove" },
				],
			});

			const result = await todoTool.execute("todo-11", {
				goal: "Remove task test",
				updates: [{ id: "task-2", remove: true }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Task to keep");
			expect(output).not.toContain("Task to remove");
		});

		it("throws error for non-existent task ID", async () => {
			await todoTool.execute("todo-12", {
				goal: "Missing ID test",
				items: [{ id: "task-1", content: "Existing task" }],
			});

			await expect(
				todoTool.execute("todo-13", {
					goal: "Missing ID test",
					updates: [{ id: "nonexistent", status: "completed" }],
				}),
			).rejects.toThrow("No task found with id");
		});
	});

	describe("priority support", () => {
		it("sets task priority", async () => {
			const result = await todoTool.execute("todo-14", {
				goal: "Priority test",
				items: [
					{ content: "High priority task", priority: "high" },
					{ content: "Low priority task", priority: "low" },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("High");
			expect(output).toContain("Low");
		});

		it("defaults to medium priority", async () => {
			const result = await todoTool.execute("todo-15", {
				goal: "Default priority test",
				items: [{ content: "Task without priority" }],
			});

			const details = result.details as {
				items: Array<{ priority: string }>;
			};
			expect(details.items[0].priority).toBe("medium");
		});
	});

	describe("due dates and blockers", () => {
		it("includes due date in output", async () => {
			const result = await todoTool.execute("todo-16", {
				goal: "Due date test",
				items: [{ content: "Task with due date", due: "2024-12-31" }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("2024-12-31");
		});

		it("includes blockedBy in output", async () => {
			const result = await todoTool.execute("todo-17", {
				goal: "Blockers test",
				items: [
					{
						content: "Blocked task",
						blockedBy: ["dependency-1", "dependency-2"],
					},
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("dependency-1");
			expect(output).toContain("dependency-2");
		});
	});

	describe("progress tracking", () => {
		it("calculates progress counts", async () => {
			const result = await todoTool.execute("todo-18", {
				goal: "Progress test",
				items: [
					{ content: "Pending 1", status: "pending" },
					{ content: "Pending 2", status: "pending" },
					{ content: "In progress", status: "in_progress" },
					{ content: "Completed", status: "completed" },
				],
			});

			const details = result.details as {
				pending: number;
				in_progress: number;
				completed: number;
				total: number;
			};
			expect(details.pending).toBe(2);
			expect(details.in_progress).toBe(1);
			expect(details.completed).toBe(1);
			expect(details.total).toBe(4);
		});

		it("shows progress summary by default", async () => {
			const result = await todoTool.execute("todo-19", {
				goal: "Summary test",
				items: [{ content: "Task 1" }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Progress");
		});

		it("hides summary when includeSummary is false", async () => {
			const result = await todoTool.execute("todo-20", {
				goal: "No summary test",
				items: [{ content: "Task 1" }],
				includeSummary: false,
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("Progress");
		});
	});

	describe("persistence", () => {
		// Note: Persistence is tested implicitly through the update tests above
		// The todos.json file gets written but the path is module-level so
		// direct file reads don't work reliably in tests

		it("loads existing todos on update", async () => {
			// Create initial todo
			await todoTool.execute("todo-22", {
				goal: "Load existing test",
				items: [{ id: "existing-task", content: "Existing task" }],
			});

			// Update without providing items
			const result = await todoTool.execute("todo-23", {
				goal: "Load existing test",
				updates: [{ id: "existing-task", status: "completed" }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Existing task");
			expect(output).toContain("Completed");
		});
	});

	describe("validation", () => {
		it("throws on invalid JSON items", async () => {
			await expect(
				todoTool.execute("todo-24", {
					goal: "Invalid JSON test",
					items: "not valid json",
				}),
			).rejects.toThrow("Invalid");
		});

		it("throws on empty items array in JSON", async () => {
			await expect(
				todoTool.execute("todo-25", {
					goal: "Empty JSON test",
					items: "[]",
				}),
			).rejects.toThrow("at least one task");
		});

		it("throws when updating non-existent goal without items", async () => {
			await expect(
				todoTool.execute("todo-26", {
					goal: "Non-existent goal",
					updates: [{ id: "task-1", status: "completed" }],
				}),
			).rejects.toThrow("No existing checklist found");
		});
	});
});

describe("formatting functions", () => {
	describe("formatGoalSection", () => {
		it("formats goal with divider", () => {
			const result = formatGoalSection("My goal");
			expect(result).toContain("Goal");
			expect(result).toContain("─");
			expect(result).toContain("My goal");
		});
	});

	describe("formatSummarySection", () => {
		it("formats progress with bars", () => {
			const result = formatSummarySection({
				pending: 2,
				in_progress: 1,
				completed: 1,
				total: 4,
			});

			expect(result).toContain("Progress");
			expect(result).toContain("Pending");
			expect(result).toContain("In Progress");
			expect(result).toContain("Completed");
			expect(result).toContain("%");
		});

		it("handles empty checklist", () => {
			const result = formatSummarySection({
				pending: 0,
				in_progress: 0,
				completed: 0,
				total: 0,
			});

			expect(result).toContain("No tasks yet");
		});
	});

	describe("formatTodosSection", () => {
		it("formats task list", () => {
			const result = formatTodosSection([
				{
					id: "1",
					content: "Task 1",
					status: "pending",
					priority: "high",
				},
			]);

			expect(result).toContain("Checklist");
			expect(result).toContain("Task 1");
			expect(result).toContain("[ ]");
		});

		it("handles empty list", () => {
			const result = formatTodosSection([]);
			expect(result).toContain("No tasks tracked");
		});
	});
});

// Note: The store functions use module-level defaultStorePath which is evaluated
// at import time, so we can't easily test them in isolation without reimporting
// the module. The persistence is tested through the todoTool tests above.
