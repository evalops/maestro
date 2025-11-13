import { z } from "zod";
import { createZodTool } from "./zod-tool.js";

const statusSymbols = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
} as const;

type StatusKey = keyof typeof statusSymbols;

const statusLabels: Record<StatusKey, string> = {
	pending: "Pending",
	in_progress: "In Progress",
	completed: "Completed",
};

const priorityLabels = {
	high: "High",
	medium: "Medium",
	low: "Low",
} as const;

const todoItemSchema = z
	.object({
		id: z
			.string({ description: "Stable identifier for the task" })
			.min(1, "ID must not be empty")
			.optional(),
		content: z
			.string({ description: "Human readable description of the task" })
			.min(1, "Task description must not be empty"),
		status: z
			.enum(["pending", "in_progress", "completed"], {
				description: "Current progress state of the task",
			})
			.optional()
			.default("pending"),
		priority: z
			.enum(["high", "medium", "low"], {
				description: "Relative urgency of the task",
			})
			.optional()
			.default("medium"),
		notes: z
			.string({ description: "Additional context or reminders" })
			.min(1, "Notes must not be empty")
			.optional(),
		due: z
			.string({ description: "Due date or target milestone" })
			.min(1, "Due date must not be empty")
			.optional(),
		blockedBy: z
			.array(
				z
					.string({ description: "Task or dependency blocking progress" })
					.min(1, "Blocker description must not be empty"),
			)
			.nonempty()
			.optional(),
	})
	.strict();

const todoSchema = z
	.object({
		goal: z
			.string({ description: "Overall objective for this checklist" })
			.min(1, "Goal must not be empty"),
		items: z
			.array(todoItemSchema, {
				description: "Collection of tasks that make up the plan",
			})
			.nonempty("Provide at least one task"),
		includeSummary: z
			.boolean({ description: "Include status summary section" })
			.optional()
			.default(true),
	})
	.strict();

const formatPriority = (priority: string | undefined) => {
	if (!priority) {
		return undefined;
	}
	return priorityLabels[priority as keyof typeof priorityLabels];
};

export const todoTool = createZodTool({
	name: "todo",
	label: "todo",
	description:
		"Create a status-rich checklist for a coding objective, mirroring TodoWrite semantics (id, content, status, priority).",
	schema: todoSchema,
	async execute(_toolCallId, params) {
		const { goal, items, includeSummary } = params;

		const normalized = items.map((item, index) => {
			const status = item.status ?? "pending";
			const priority = item.priority ?? "medium";
			return {
				id: item.id ?? String(index + 1),
				content: item.content,
				status,
				priority,
				notes: item.notes,
				due: item.due,
				blockedBy: item.blockedBy,
			};
		});

		const counts = normalized.reduce(
			(acc, item) => {
				acc[item.status] += 1;
				acc.total += 1;
				return acc;
			},
			{ pending: 0, in_progress: 0, completed: 0, total: 0 },
		);

		const summaryLines = includeSummary
			? [
					`Summary:
Pending: ${counts.pending}
In Progress: ${counts.in_progress}
Completed: ${counts.completed}`,
				]
			: [];

		const todosSection = normalized
			.map((item, index) => {
				const symbol = statusSymbols[item.status as StatusKey];
				const friendlyPriority = formatPriority(item.priority);

				const lineParts = [
					`${index + 1}. ${symbol} ${item.content}`,
					item.id ? `(ID: ${item.id})` : undefined,
					friendlyPriority ? `(Priority: ${friendlyPriority})` : undefined,
				];

				const header = lineParts.filter(Boolean).join(" ");

				const metadata: string[] = [];
				metadata.push(`Status: ${statusLabels[item.status as StatusKey]}`);

				if (item.due) {
					metadata.push(`Due: ${item.due}`);
				}
				if (item.blockedBy) {
					metadata.push(
						`Blocked by: ${item.blockedBy.map((entry) => `"${entry}"`).join(", ")}`,
					);
				}
				if (item.notes) {
					metadata.push(`Notes: ${item.notes}`);
				}

				if (metadata.length === 0) {
					return header;
				}

				const detailLines = metadata.map((entry) => `  - ${entry}`);
				return `${header}
${detailLines.join("\n")}`;
			})
			.join("\n\n");

		const sections = [
			`Goal: ${goal}`,
			...summaryLines,
			`Todos:
${todosSection}`,
		];

		return {
			content: [{ type: "text", text: sections.join("\n\n") }],
			details: counts,
		};
	},
});
