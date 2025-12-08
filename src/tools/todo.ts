/**
 * Todo Tool - Task Tracking for Coding Sessions
 *
 * This module provides a todo/checklist tool for tracking multi-step tasks
 * during agent coding sessions. It persists tasks to disk and provides
 * formatted progress reports.
 *
 * ## Task States
 *
 * | State       | Symbol | Description                    |
 * |-------------|--------|--------------------------------|
 * | pending     | [ ]    | Not yet started                |
 * | in_progress | [~]    | Currently being worked on      |
 * | completed   | [x]    | Finished successfully          |
 *
 * ## Task Properties
 *
 * - **id**: Unique identifier (auto-generated UUID if not provided)
 * - **content**: Human-readable task description
 * - **status**: Current progress state
 * - **priority**: high, medium, or low
 * - **notes**: Additional context or reminders
 * - **due**: Due date or target milestone
 * - **blockedBy**: List of blocking dependencies
 *
 * ## Storage
 *
 * Tasks are persisted to `~/.composer/todos.json` (configurable via
 * COMPOSER_TODO_FILE environment variable). Each goal has its own
 * checklist that can be updated incrementally.
 *
 * ## Usage Guidelines
 *
 * - Use for complex, multi-step work (3+ steps)
 * - Mark tasks in_progress BEFORE starting work
 * - Mark completed IMMEDIATELY when done
 * - Only ONE in_progress task at a time
 *
 * ## Example
 *
 * ```typescript
 * // Create a new checklist
 * todoTool.execute('call-id', {
 *   goal: 'Implement user authentication',
 *   items: [
 *     { content: 'Create login form', priority: 'high' },
 *     { content: 'Add JWT validation', priority: 'high' },
 *     { content: 'Write tests', priority: 'medium' },
 *   ],
 * });
 *
 * // Update task status
 * todoTool.execute('call-id', {
 *   goal: 'Implement user authentication',
 *   updates: [
 *     { id: 'task-uuid', status: 'completed' },
 *   ],
 * });
 * ```
 *
 * @module tools/todo
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { setPlanSatisfied } from "../safety/safe-mode.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { createTool } from "./tool-dsl.js";

const logger = createLogger("tools:todo");

export type { NormalizedTodo, TodoStore, StatusKey };

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

const todoItemSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description: "Stable identifier for the task",
			minLength: 1,
		}),
	),
	content: Type.String({
		description: "Human readable description of the task",
		minLength: 1,
	}),
	status: Type.Optional(
		Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
			],
			{ description: "Current progress state of the task", default: "pending" },
		),
	),
	priority: Type.Optional(
		Type.Union(
			[Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
			{
				description: "Relative urgency of the task",
				default: "medium",
			},
		),
	),
	notes: Type.Optional(
		Type.String({
			description: "Additional context or reminders",
			minLength: 1,
		}),
	),
	due: Type.Optional(
		Type.String({ description: "Due date or target milestone", minLength: 1 }),
	),
	blockedBy: Type.Optional(
		Type.Array(
			Type.String({
				description: "Task or dependency blocking progress",
				minLength: 1,
			}),
		),
	),
});

const itemsInputSchema = Type.Union([
	Type.Array(todoItemSchema, { minItems: 1 }),
	Type.String({
		description: "JSON stringified array of TodoWrite-style task objects",
		minLength: 2,
	}),
]);

const updateSchema = Type.Object({
	id: Type.String({
		description: "Identifier of the task to update",
		minLength: 1,
	}),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("completed"),
		]),
	),
	priority: Type.Optional(
		Type.Union([
			Type.Literal("high"),
			Type.Literal("medium"),
			Type.Literal("low"),
		]),
	),
	notes: Type.Optional(
		Type.String({ description: "Replace notes associated with the task" }),
	),
	due: Type.Optional(
		Type.String({ description: "Replace due date or milestone" }),
	),
	blockedBy: Type.Optional(
		Type.Array(
			Type.String({ description: "Replace blockers list", minLength: 1 }),
		),
	),
	content: Type.Optional(
		Type.String({ description: "Replace the task description" }),
	),
	remove: Type.Optional(
		Type.Boolean({ description: "Remove the task entirely" }),
	),
});

const todoSchema = Type.Object({
	goal: Type.String({
		description: "Overall objective for this checklist",
		minLength: 1,
	}),
	items: Type.Optional(itemsInputSchema),
	updates: Type.Optional(
		Type.Array(updateSchema, {
			description:
				"Updates to apply to existing tasks (identified by their id)",
			minItems: 1,
		}),
	),
	includeSummary: Type.Optional(
		Type.Boolean({
			description: "Include status summary section",
			default: true,
		}),
	),
});

const parseItemsInput = (
	input: Static<typeof itemsInputSchema>,
): Array<Static<typeof todoItemSchema>> => {
	if (typeof input === "string") {
		const result = safeJsonParse<unknown>(input, "TODO items");
		if (!result.success) {
			throw new Error(
				`Invalid JSON: ${"error" in result ? result.error.message : "Unknown error"}`,
			);
		}
		const parsed = result.data;
		if (!Array.isArray(parsed)) {
			throw new Error("items JSON must be an array");
		}
		if (parsed.length === 0) {
			throw new Error("Provide at least one task");
		}
		return parsed.map((item, index) => {
			// Basic validation: ensure required fields exist before trusting Value.Cast
			if (!item || typeof item !== "object") {
				throw new Error(`Invalid task at index ${index}`);
			}
			return Value.Cast(todoItemSchema, item);
		});
	}
	return input;
};

const formatPriority = (priority: string | undefined) => {
	if (!priority) {
		return undefined;
	}
	return priorityLabels[priority as keyof typeof priorityLabels];
};

type NormalizedTodo = {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority: "high" | "medium" | "low";
	notes?: string;
	due?: string;
	blockedBy?: string[];
};

type TodoStore = Record<
	string,
	{ goal: string; items: NormalizedTodo[]; updatedAt: string }
>;

export const defaultStorePath =
	process.env.COMPOSER_TODO_FILE ?? join(homedir(), ".composer", "todos.json");

async function ensureParentDirectory(filePath: string) {
	await mkdir(dirname(filePath), { recursive: true });
}

export async function loadStore(): Promise<TodoStore> {
	try {
		const raw = await readFile(defaultStorePath, "utf-8");
		const result = safeJsonParse<TodoStore>(raw, "TODO store");
		if (!result.success) {
			logger.warn("Corrupted store file", {
				error: "error" in result ? result.error.message : "Unknown error",
			});
			return {};
		}
		return result.data;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

export async function saveStore(store: TodoStore): Promise<void> {
	await ensureParentDirectory(defaultStorePath);
	await writeFile(
		defaultStorePath,
		`${JSON.stringify(store, null, 2)}\n`,
		"utf-8",
	);
}

function normalizeItems(
	items: Array<Static<typeof todoItemSchema>>,
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
	updates: Array<Static<typeof updateSchema>>,
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

export function formatGoalSection(goal: string): string {
	return `Goal\n${sectionDivider}\n${goal}`;
}

export function formatSummarySection(
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

export function formatTodosSection(items: NormalizedTodo[]): string {
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

type TodoToolDetails = {
	items: NormalizedTodo[];
	pending: number;
	in_progress: number;
	completed: number;
	total: number;
};

export const todoTool = createTool<typeof todoSchema, TodoToolDetails>({
	name: "todo",
	label: "todo",
	description: `Track tasks for coding sessions. Use for complex, multi-step work to demonstrate progress.

When to use:
- 3+ steps or non-trivial work
- User requests multiple tasks
- After receiving new instructions

When NOT to use:
- Single, straightforward tasks
- Trivial work (<3 steps)
- Conversational requests

Task states:
- pending: Not started
- in_progress: Currently working (ONE AT A TIME)
- completed: Finished

Management:
- Mark in_progress BEFORE starting work
- Mark completed IMMEDIATELY when done
- Only ONE in_progress task at a time
- Use 'updates' to modify existing tasks by id

Call this tool IN PARALLEL with other tools to save time.`,
	schema: todoSchema,
	async run(params, { respond }) {
		const { goal, items, updates, includeSummary } = params;

		const store = await loadStore();
		const existing = store[goal] ?? {
			goal,
			items: [] as NormalizedTodo[],
			updatedAt: new Date(0).toISOString(),
		};

		let workingItems: NormalizedTodo[];
		if (items) {
			try {
				const parsedItems = parseItemsInput(items);
				workingItems = normalizeItems(parsedItems);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: String(error ?? "invalid items");
				throw new Error(`Invalid todo items: ${message}`);
			}
		} else {
			workingItems = [...existing.items];
		}

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

		return respond
			.text(sections.join("\n\n"))
			.detail({ ...counts, items: workingItems });
	},
});
