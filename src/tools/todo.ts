import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { setPlanSatisfied } from "../safety/safe-mode.js";
import { createZodTool } from "./zod-tool.js";

const sectionDivider = "─".repeat(40);

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
			.optional(),
	})
	.strict();

const itemsInputSchema = z
	.union([
		z.array(todoItemSchema).nonempty("Provide at least one task"),
		z
			.string({
				description: "JSON stringified array of TodoWrite-style task objects",
			})
			.min(2, "Items string must not be empty"),
	])
	.transform((value, ctx) => {
		if (typeof value === "string") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch (_error) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "items string must be valid JSON",
				});
				return z.NEVER;
			}
			if (!Array.isArray(parsed)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "items JSON must be an array",
				});
				return z.NEVER;
			}
			if (parsed.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Provide at least one task",
				});
				return z.NEVER;
			}
			const validated: Array<z.infer<typeof todoItemSchema>> = [];
			for (const [index, item] of parsed.entries()) {
				const result = todoItemSchema.safeParse(item);
				if (!result.success) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: [index],
						message: result.error.issues
							.map((issue) => issue.message)
							.join(", "),
					});
					return z.NEVER;
				}
				validated.push(result.data);
			}
			return validated;
		}

		return value;
	});

const updateSchema = z
	.object({
		id: z
			.string({ description: "Identifier of the task to update" })
			.min(1, "Update must reference a task id"),
		status: z
			.enum(["pending", "in_progress", "completed"], {
				description: "New status for the task",
			})
			.optional(),
		priority: z
			.enum(["high", "medium", "low"], {
				description: "New priority for the task",
			})
			.optional(),
		notes: z
			.string({ description: "Replace notes associated with the task" })
			.optional(),
		due: z.string({ description: "Replace due date or milestone" }).optional(),
		blockedBy: z
			.array(
				z
					.string({ description: "Replace blockers list" })
					.min(1, "Blocker description must not be empty"),
			)
			.optional(),
		content: z
			.string({ description: "Replace the task description" })
			.optional(),
		remove: z.boolean({ description: "Remove the task entirely" }).optional(),
	})
	.strict();

const todoSchemaBase = z
	.object({
		goal: z
			.string({ description: "Overall objective for this checklist" })
			.min(1, "Goal must not be empty"),
		items: itemsInputSchema.optional(),
		updates: z
			.array(updateSchema, {
				description:
					"Updates to apply to existing tasks (identified by their id)",
			})
			.nonempty()
			.optional(),
		includeSummary: z
			.boolean({ description: "Include status summary section" })
			.optional()
			.default(true),
	})
	.strict();

const todoSchema = todoSchemaBase.refine(
	(data) => data.items !== undefined || data.updates !== undefined,
	"Provide items to create a checklist or updates to modify an existing one",
);

const formatPriority = (priority: string | undefined) => {
	if (!priority) {
		return undefined;
	}
	return priorityLabels[priority as keyof typeof priorityLabels];
};

type NormalizedTodo = {
	id: string;
	content: z.infer<typeof todoItemSchema>["content"];
	status: z.infer<typeof todoItemSchema>["status"];
	priority: z.infer<typeof todoItemSchema>["priority"];
	notes?: z.infer<typeof todoItemSchema>["notes"];
	due?: z.infer<typeof todoItemSchema>["due"];
	blockedBy?: z.infer<typeof todoItemSchema>["blockedBy"];
};

type TodoStore = Record<
	string,
	{ goal: string; items: NormalizedTodo[]; updatedAt: string }
>;

const defaultStorePath =
	process.env.COMPOSER_TODO_FILE ?? join(homedir(), ".composer", "todos.json");

async function ensureParentDirectory(filePath: string) {
	await mkdir(dirname(filePath), { recursive: true });
}

async function loadStore(): Promise<TodoStore> {
	try {
		const raw = await readFile(defaultStorePath, "utf-8");
		const parsed = JSON.parse(raw) as TodoStore;
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

async function saveStore(store: TodoStore): Promise<void> {
	await ensureParentDirectory(defaultStorePath);
	await writeFile(
		defaultStorePath,
		`${JSON.stringify(store, null, 2)}\n`,
		"utf-8",
	);
}

function normalizeItems(
	items: Array<z.infer<typeof todoItemSchema>>,
): NormalizedTodo[] {
	return items.map((item) => ({
		id: item.id ?? randomUUID(),
		content: item.content,
		status: item.status ?? "pending",
		priority: item.priority ?? "medium",
		notes: item.notes,
		due: item.due,
		blockedBy: item.blockedBy,
	}));
}

function applyUpdates(
	items: NormalizedTodo[],
	updates: Array<z.infer<typeof updateSchema>>,
): NormalizedTodo[] {
	const indexById = new Map(
		items.map((item, index) => [item.id, index] as const),
	);
	let result = [...items];

	for (const update of updates) {
		const targetIndex = indexById.get(update.id);
		if (targetIndex === undefined) {
			throw new Error(`No task found with id "${update.id}" for this goal`);
		}
		if (update.remove) {
			result = result.filter((item) => item.id !== update.id);
			indexById.delete(update.id);
			continue;
		}
		const existing = result[targetIndex];
		result[targetIndex] = {
			...existing,
			status: update.status ?? existing.status,
			priority: update.priority ?? existing.priority,
			notes: update.notes ?? existing.notes,
			due: update.due ?? existing.due,
			blockedBy: update.blockedBy ?? existing.blockedBy,
			content: update.content ?? existing.content,
		};
	}

	return result;
}

function formatGoalSection(goal: string): string {
	return `Goal\n${sectionDivider}\n${goal}`;
}

function formatSummarySection(
	counts: Record<StatusKey | "total", number>,
): string {
	if (counts.total === 0) {
		return `Progress\n${sectionDivider}\nNo tasks yet — start by adding one above.`;
	}
	const order: StatusKey[] = ["pending", "in_progress", "completed"];
	const lines = order.map((status) => {
		const count = counts[status];
		const percent = counts.total ? Math.round((count / counts.total) * 100) : 0;
		const bar = buildStatusBar(count, counts.total);
		return `${statusSymbols[status]} ${statusLabels[status]} ${bar} ${count}/${counts.total} (${percent}%)`;
	});
	return `Progress\n${sectionDivider}\n${lines.join("\n")}`;
}

function buildStatusBar(count: number, total: number): string {
	const segments = 12;
	if (total === 0) {
		return `[${"░".repeat(segments)}]`;
	}
	const filled = Math.round((count / total) * segments);
	const clampedFilled = Math.min(segments, Math.max(0, filled));
	const bar = `${"█".repeat(clampedFilled)}${"░".repeat(
		segments - clampedFilled,
	)}`;
	return `[${bar}]`;
}

function formatTodosSection(items: NormalizedTodo[]): string {
	if (items.length === 0) {
		return `Checklist\n${sectionDivider}\nNo tasks tracked for this goal yet.`;
	}
	const entries = items.map((item, index) => formatTodoEntry(item, index));
	return `Checklist\n${sectionDivider}\n${entries.join("\n\n")}`;
}

function formatTodoEntry(item: NormalizedTodo, index: number): string {
	const statusKey = item.status as StatusKey;
	const symbol = statusSymbols[statusKey];
	const friendlyPriority = formatPriority(item.priority) ?? "Medium";
	const header = `${index + 1}. ${symbol} ${item.content}`;
	const metaLines = [
		`   • Status: ${statusLabels[statusKey]}`,
		`   • Priority: ${friendlyPriority}`,
		`   • ID: ${item.id}`,
	];
	if (item.due) {
		metaLines.splice(2, 0, `   • Due: ${item.due}`);
	}
	if (item.blockedBy && item.blockedBy.length > 0) {
		metaLines.push(
			`   • Blocked by: ${item.blockedBy
				.map((entry) => `"${entry}"`)
				.join(", ")}`,
		);
	}
	if (item.notes) {
		metaLines.push(`   • Notes: ${item.notes}`);
	}
	return `${header}\n${metaLines.join("\n")}`;
}

export const todoTool = createZodTool({
	name: "todo",
	label: "todo",
	description:
		"Create or update a status-rich checklist for a coding objective, mirroring TodoWrite semantics (id, content, status, priority).",
	schema: todoSchema,
	async execute(_toolCallId, params) {
		const { goal, items, updates, includeSummary } = params;

		const store = await loadStore();
		const existing = store[goal] ?? {
			goal,
			items: [] as NormalizedTodo[],
			updatedAt: new Date(0).toISOString(),
		};

		let workingItems = items ? normalizeItems(items) : [...existing.items];

		if (!items && workingItems.length === 0) {
			throw new Error(
				"No existing checklist found for this goal. Provide items to create one before sending updates.",
			);
		}

		if (updates) {
			workingItems = applyUpdates(workingItems, updates);
		}

		const counts = workingItems.reduce(
			(acc, item) => {
				acc[item.status] += 1;
				acc.total += 1;
				return acc;
			},
			{ pending: 0, in_progress: 0, completed: 0, total: 0 },
		);

		const summarySection = includeSummary ? formatSummarySection(counts) : null;

		const sections = [
			formatGoalSection(goal),
			...(summarySection ? [summarySection] : []),
			formatTodosSection(workingItems),
		];

		store[goal] = {
			goal,
			items: workingItems,
			updatedAt: new Date().toISOString(),
		};
		await saveStore(store);
		setPlanSatisfied(true);

		return {
			content: [{ type: "text", text: sections.join("\n\n") }],
			details: { ...counts, items: workingItems },
		};
	},
});
