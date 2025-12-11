/**
 * Tests for the schedule tool
 */

import { describe, expect, it, vi } from "vitest";
import { createScheduleTool } from "../../packages/slack-agent/src/tools/schedule.js";

describe("schedule tool", () => {
	describe("metadata", () => {
		it("has correct name and description", () => {
			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks: vi.fn(),
				onCancelTask: vi.fn(),
			});

			expect(tool.name).toBe("schedule");
			expect(tool.description).toContain("Schedule tasks");
			expect(tool.description).toContain("recurring");
		});
	});

	describe("schedule action", () => {
		it("schedules a task successfully", async () => {
			const onSchedule = vi.fn().mockResolvedValue({
				success: true,
				taskId: "task_123",
				nextRun: "2024-01-15 09:00",
			});

			const tool = createScheduleTool({
				onSchedule,
				onListTasks: vi.fn(),
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "Schedule reminder",
				action: "schedule",
				description: "Morning standup",
				prompt: "Remind team about standup",
				when: "every day at 9am",
			});

			expect(onSchedule).toHaveBeenCalledWith(
				"Morning standup",
				"Remind team about standup",
				"every day at 9am",
			);
			expect((result.content[0] as { text: string }).text).toContain(
				"scheduled successfully",
			);
			expect((result.content[0] as { text: string }).text).toContain(
				"task_123",
			);
		});

		it("returns error when scheduling fails", async () => {
			const onSchedule = vi.fn().mockResolvedValue({
				success: false,
				error: "Invalid time format",
			});

			const tool = createScheduleTool({
				onSchedule,
				onListTasks: vi.fn(),
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "Schedule task",
				action: "schedule",
				description: "Test task",
				prompt: "Do something",
				when: "invalid time",
			});

			expect((result.content[0] as { text: string }).text).toContain("Failed");
			expect((result.content[0] as { text: string }).text).toContain(
				"Invalid time format",
			);
		});

		it("requires description, prompt, and when for schedule action", async () => {
			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks: vi.fn(),
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "Missing params",
				action: "schedule",
				description: "Test",
				// Missing prompt and when
			});

			expect((result.content[0] as { text: string }).text).toContain("Error");
			expect((result.content[0] as { text: string }).text).toContain(
				"requires",
			);
		});
	});

	describe("list action", () => {
		it("lists scheduled tasks", async () => {
			const onListTasks = vi.fn().mockResolvedValue([
				{
					id: "task_1",
					description: "Daily standup",
					nextRun: "2024-01-15 09:00",
					recurring: true,
				},
				{
					id: "task_2",
					description: "Deploy reminder",
					nextRun: "2024-01-15 14:00",
					recurring: false,
				},
			]);

			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks,
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "List tasks",
				action: "list",
			});

			expect(onListTasks).toHaveBeenCalled();
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Daily standup");
			expect(text).toContain("(recurring)");
			expect(text).toContain("Deploy reminder");
			expect(text).toContain("task_1");
			expect(text).toContain("task_2");
		});

		it("shows message when no tasks scheduled", async () => {
			const onListTasks = vi.fn().mockResolvedValue([]);

			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks,
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "List tasks",
				action: "list",
			});

			expect((result.content[0] as { text: string }).text).toContain(
				"No scheduled tasks",
			);
		});

		it("includes details with task array", async () => {
			const tasks = [
				{
					id: "task_1",
					description: "Test",
					nextRun: "2024-01-15 09:00",
					recurring: false,
				},
			];
			const onListTasks = vi.fn().mockResolvedValue(tasks);

			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks,
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "List tasks",
				action: "list",
			});

			expect(result.details).toEqual(tasks);
		});
	});

	describe("cancel action", () => {
		it("cancels a task successfully", async () => {
			const onCancelTask = vi.fn().mockResolvedValue({ success: true });

			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks: vi.fn(),
				onCancelTask,
			});

			const result = await tool.execute("test-id", {
				label: "Cancel task",
				action: "cancel",
				taskId: "task_123",
			});

			expect(onCancelTask).toHaveBeenCalledWith("task_123");
			expect((result.content[0] as { text: string }).text).toContain(
				"cancelled successfully",
			);
		});

		it("returns error when task not found", async () => {
			const onCancelTask = vi.fn().mockResolvedValue({
				success: false,
				error: "Task not found",
			});

			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks: vi.fn(),
				onCancelTask,
			});

			const result = await tool.execute("test-id", {
				label: "Cancel task",
				action: "cancel",
				taskId: "nonexistent",
			});

			expect((result.content[0] as { text: string }).text).toContain("Failed");
			expect((result.content[0] as { text: string }).text).toContain(
				"Task not found",
			);
		});

		it("requires taskId for cancel action", async () => {
			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks: vi.fn(),
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "Cancel task",
				action: "cancel",
				// Missing taskId
			});

			expect((result.content[0] as { text: string }).text).toContain("Error");
			expect((result.content[0] as { text: string }).text).toContain("taskId");
		});
	});

	describe("unknown action", () => {
		it("returns error for unknown action", async () => {
			const tool = createScheduleTool({
				onSchedule: vi.fn(),
				onListTasks: vi.fn(),
				onCancelTask: vi.fn(),
			});

			const result = await tool.execute("test-id", {
				label: "Unknown action",
				action: "unknown" as "schedule",
			});

			expect((result.content[0] as { text: string }).text).toContain(
				"Unknown action",
			);
		});
	});
});
