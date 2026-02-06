/**
 * Background Task Tool Handler
 * TypeBox schema definition and tool handler for the background_tasks tool.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "../../agent/providers/typebox-helpers.js";
import { backgroundTaskManager } from "../background-tasks.js";
import { createTool } from "../tool-dsl.js";
import type { ToolResponseBuilder } from "../tool-dsl.js";
import {
	type BackgroundTask,
	type TaskStartOptions,
	buildTaskDetail,
	formatTaskSummary,
} from "./task-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const backgroundTaskSchema = Type.Union([
	Type.Object({
		action: Type.Literal("start"),
		command: Type.String({
			description: "Command to run in the background",
			minLength: 1,
		}),
		shell: Type.Optional(
			Type.Boolean({
				description:
					"Run the command through the system shell (allows pipes/redirection). Defaults to false for direct execution.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for the command",
				minLength: 1,
			}),
		),
		env: Type.Optional(
			Type.Record(Type.String({ minLength: 1 }), Type.String(), {
				description: "Additional environment variables for the command",
			}),
		),
		restart: Type.Optional(
			Type.Object({
				maxAttempts: Type.Integer({
					description:
						"Maximum number of restart attempts when the task exits with a non-zero status",
					minimum: 1,
					maximum: 5,
				}),
				delayMs: Type.Integer({
					description: "Delay in milliseconds between restart attempts",
					minimum: 50,
					maximum: 60_000,
				}),
				strategy: Type.Optional(StringEnum(["fixed", "exponential"])),
				maxDelayMs: Type.Optional(
					Type.Integer({
						description: "Upper bound for exponential backoff delays",
						minimum: 50,
						maximum: 600_000,
					}),
				),
				jitterRatio: Type.Optional(
					Type.Number({
						description: "Random jitter ratio applied to restart delays (0-1)",
						minimum: 0,
						maximum: 1,
					}),
				),
			}),
		),
		limits: Type.Optional(
			Type.Object({
				logSizeLimit: Type.Optional(
					Type.Integer({
						description:
							"Per-task log size limit in bytes (overrides default). Minimum 0, maximum 50MB.",
						minimum: 0,
						maximum: 50 * 1024 * 1024,
					}),
				),
				logSegments: Type.Optional(
					Type.Integer({
						description:
							"Number of gzip-compressed log segments to retain when rotating.",
						minimum: 0,
						maximum: 10,
					}),
				),
				retentionMs: Type.Optional(
					Type.Integer({
						description:
							"Milliseconds to retain finished task metadata and logs before cleanup.",
						minimum: 1_000,
						maximum: 24 * 60 * 60 * 1000,
					}),
				),
				maxRssKb: Type.Optional(
					Type.Integer({
						description:
							"Maximum resident set size in kilobytes before the task is terminated (0 disables).",
						minimum: 0,
						maximum: 4 * 1024 * 1024,
					}),
				),
				maxCpuMs: Type.Optional(
					Type.Integer({
						description:
							"Maximum combined user+system CPU time in milliseconds before termination (0 disables).",
						minimum: 0,
						maximum: 24 * 60 * 60 * 1000,
					}),
				),
			}),
		),
	}),
	Type.Object({
		action: Type.Literal("stop"),
		taskId: Type.String({
			description: "Identifier of the background task to stop",
			minLength: 1,
		}),
	}),
	Type.Object({
		action: Type.Literal("list"),
	}),
	Type.Object({
		action: Type.Literal("logs"),
		taskId: Type.String({
			description: "Identifier of the background task",
			minLength: 1,
		}),
		lines: Type.Optional(
			Type.Number({
				description: "Number of log lines to show",
				minimum: 1,
				maximum: 200,
			}),
		),
	}),
]);

type BackgroundTaskSchema = typeof backgroundTaskSchema;

type BackgroundTaskToolDetails = unknown;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderTaskList(
	tasks: BackgroundTask[],
	respond: ToolResponseBuilder<unknown>,
): void {
	if (tasks.length === 0) {
		respond.text("No background tasks are running.");
		return;
	}

	const lines = tasks.map(
		(task) => `${formatTaskSummary(task)}\n  ${task.command}`,
	);
	respond.text(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

export const backgroundTasksTool = createTool<
	BackgroundTaskSchema,
	BackgroundTaskToolDetails
>({
	name: "background_tasks",
	label: "background tasks",
	description: "Run commands in the background and manage their lifecycle.",
	schema: backgroundTaskSchema,
	async run(params, { respond }) {
		if (params.action === "start") {
			const restart =
				params.restart &&
				({
					...params.restart,
					strategy:
						params.restart.strategy === "exponential" ? "exponential" : "fixed",
				} satisfies TaskStartOptions["restart"]);
			const task = backgroundTaskManager.start(params.command, {
				cwd: params.cwd,
				env: params.env,
				useShell: params.shell ?? false,
				restart,
				limits: params.limits,
			});
			respond
				.text(
					[
						`Started ${formatTaskSummary(task)}`,
						`Logs: ${task.logPath}`,
						`Execution mode: ${task.shellMode === "shell" ? "shell" : "direct"}`,
						"Use action=list to view tasks or action=stop to terminate.",
					].join("\n"),
				)
				.detail(buildTaskDetail(task));
			return respond;
		}

		if (params.action === "list") {
			const tasks = backgroundTaskManager.getTasks();
			renderTaskList(tasks, respond);
			respond.detail(tasks.map((task) => buildTaskDetail(task)));
			return respond;
		}

		if (params.action === "stop") {
			const result = await backgroundTaskManager.stopTask(params.taskId);
			if (!result) {
				respond.error(`Task not found: ${params.taskId}`);
			} else {
				const statusLabel = result.stopped ? "Stopped" : "Stop signal sent";
				const summary = formatTaskSummary(result.task);
				respond
					.text(`${statusLabel} ${summary}`)
					.detail(buildTaskDetail(result.task));
			}
			return respond;
		}

		if (params.action === "logs") {
			const lines = params.lines ?? 40;
			try {
				const logText = backgroundTaskManager.getLogs(params.taskId, lines);
				const task = backgroundTaskManager.getTask(params.taskId);
				respond
					.text(`Last ${lines} lines for ${params.taskId}:\n\n${logText}`)
					.detail({
						taskId: params.taskId,
						lines,
						logTruncated: Boolean(task?.logTruncated),
					});
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: `Unable to read logs for ${params.taskId}`;
				respond.error(message);
			}
			return respond;
		}

		respond.error("Unsupported action");
		return respond;
	},
});
