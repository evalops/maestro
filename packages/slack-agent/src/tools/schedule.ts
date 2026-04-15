/**
 * Schedule Tool - Schedule tasks for future execution
 *
 * Allows the agent to schedule one-time or recurring tasks.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./index.js";

const scheduleSchema = Type.Object({
	label: Type.String({
		description:
			"Brief description shown to user (e.g., 'scheduling reminder')",
	}),
	action: Type.Union(
		[Type.Literal("schedule"), Type.Literal("list"), Type.Literal("cancel")],
		{
			description:
				"Action to perform: 'schedule' to create a task, 'list' to show tasks, 'cancel' to remove a task",
		},
	),
	description: Type.Optional(
		Type.String({
			description:
				"Human-readable description of the task (required for schedule action)",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description:
				"The prompt/instruction to execute when the task runs (required for schedule action)",
		}),
	),
	when: Type.Optional(
		Type.String({
			description:
				'When to run the task. Examples: "in 2 hours", "tomorrow at 9am", "every day at 9am", "every monday at 10am" (required for schedule action)',
		}),
	),
	taskId: Type.Optional(
		Type.String({
			description: "Task ID to cancel (required for cancel action)",
		}),
	),
});

/**
 * Callback to schedule a task
 */
export type ScheduleCallback = (
	description: string,
	prompt: string,
	when: string,
) => Promise<{
	success: boolean;
	taskId?: string;
	nextRun?: string;
	/** Optional warning to surface to the user (e.g., timezone fallback). */
	warning?: string;
	error?: string;
}>;

/**
 * Callback to list tasks
 */
export type ListTasksCallback = () => Promise<
	Array<{
		id: string;
		description: string;
		nextRun: string;
		recurring: boolean;
	}>
>;

/**
 * Callback to cancel a task
 */
export type CancelTaskCallback = (
	taskId: string,
) => Promise<{ success: boolean; error?: string }>;

export interface ScheduleToolOptions {
	onSchedule: ScheduleCallback;
	onListTasks: ListTasksCallback;
	onCancelTask: CancelTaskCallback;
}

export function createScheduleTool(
	options: ScheduleToolOptions,
): AgentTool<typeof scheduleSchema> {
	return {
		name: "schedule",
		label: "schedule",
		description:
			"Schedule tasks for future execution. Can schedule one-time tasks (e.g., 'in 2 hours', 'tomorrow at 9am') or recurring tasks (e.g., 'every day at 9am', 'every monday at 10am'). Use 'list' to see scheduled tasks, 'cancel' to remove a task.",
		parameters: scheduleSchema,
		execute: async (_toolCallId, args) => {
			const { action, description, prompt, when, taskId } = args as {
				label: string;
				action: "schedule" | "list" | "cancel";
				description?: string;
				prompt?: string;
				when?: string;
				taskId?: string;
			};

			switch (action) {
				case "schedule": {
					if (!description || !prompt || !when) {
						return {
							content: [
								{
									type: "text",
									text: "Error: 'schedule' action requires description, prompt, and when parameters",
								},
							],
						};
					}

					const result = await options.onSchedule(description, prompt, when);
					if (result.success) {
						const warningLine = result.warning
							? `\n_Warning: ${result.warning}_`
							: "";
						return {
							content: [
								{
									type: "text",
									text: `Task scheduled successfully!\nID: ${result.taskId}\nNext run: ${result.nextRun}${warningLine}`,
								},
							],
							details: result,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Failed to schedule task: ${result.error || "Unknown error"}`,
							},
						],
					};
				}

				case "list": {
					const tasks = await options.onListTasks();
					if (tasks.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: "No scheduled tasks for this channel.",
								},
							],
						};
					}

					const lines = tasks.map((t) => {
						const recurring = t.recurring ? " (recurring)" : "";
						return `• ${t.description}${recurring}\n  ID: ${t.id}\n  Next: ${t.nextRun}`;
					});

					return {
						content: [
							{
								type: "text",
								text: `Scheduled Tasks:\n\n${lines.join("\n\n")}`,
							},
						],
						details: tasks,
					};
				}

				case "cancel": {
					if (!taskId) {
						return {
							content: [
								{
									type: "text",
									text: "Error: 'cancel' action requires taskId parameter",
								},
							],
						};
					}

					const result = await options.onCancelTask(taskId);
					if (result.success) {
						return {
							content: [
								{
									type: "text",
									text: `Task ${taskId} cancelled successfully.`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Failed to cancel task: ${result.error || "Task not found"}`,
							},
						],
					};
				}

				default:
					return {
						content: [
							{
								type: "text",
								text: `Unknown action: ${action}. Use 'schedule', 'list', or 'cancel'.`,
							},
						],
					};
			}
		},
	};
}
