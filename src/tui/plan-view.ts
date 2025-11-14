import { readFileSync } from "node:fs";
import chalk from "chalk";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

const PLAN_STATUS_SYMBOLS = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
} as const;

const PLAN_STATUS_LABELS = {
	pending: "Pending",
	in_progress: "In Progress",
	completed: "Completed",
} as const;

export type PlanStatusKey = keyof typeof PLAN_STATUS_SYMBOLS;

export interface TodoItem {
	id: string;
	content: string;
	status: string;
	priority: string;
	notes?: string;
	due?: string;
	blockedBy?: string[];
}

export interface TodoGoalEntry {
	goal: string;
	items: TodoItem[];
	updatedAt: string;
}

export type TodoStore = Record<string, TodoGoalEntry>;

export interface PlanViewOptions {
	filePath: string;
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	setPlanHint: (hint: string | null) => void;
}

export class PlanView {
	constructor(private readonly options: PlanViewOptions) {}

	handlePlanCommand(text: string): void {
		const store = loadTodoStore(this.options.filePath);
		const goals = Object.keys(store);
		if (goals.length === 0) {
			this.options.showInfoMessage(
				"No plans found. Use the todo tool in a message to create one.",
			);
			this.options.setPlanHint(null);
			return;
		}

		const parts = text.trim().split(/\s+/);
		if (parts.length === 1) {
			const summaries = goals.map((goal) => {
				const entry = store[goal];
				const counts = countTodoStatuses(entry.items);
				return `${chalk.bold(goal)}\n  Pending: ${counts.pending} · In Progress: ${counts.in_progress} · Completed: ${counts.completed}`;
			});
			this.showTextBlock(
				`${chalk.bold("Plans")}\n${summaries.join("\n\n")}\n\nUse /plan <goal> to see details.`,
			);
			this.options.setPlanHint(null);
			return;
		}

		const goalQuery = text.slice(text.indexOf(" ") + 1).trim();
		const goalKey =
			goals.find((goal) => goal.toLowerCase() === goalQuery.toLowerCase()) ??
			goals.find((goal) =>
				goal.toLowerCase().includes(goalQuery.toLowerCase()),
			);
		if (!goalKey) {
			this.options.showInfoMessage(`No plan found matching "${goalQuery}".`);
			return;
		}

		const entry = store[goalKey];
		const counts = countTodoStatuses(entry.items);
		const tasks = entry.items.length
			? entry.items
					.map((item, index) => formatTask(item, index + 1))
					.join("\n\n")
			: chalk.dim("No tasks yet — add some with the todo tool.");
		const detail = `${chalk.bold(goalKey)}\nUpdated: ${new Date(entry.updatedAt).toLocaleString()}\nPending: ${counts.pending} · In Progress: ${counts.in_progress} · Completed: ${counts.completed}\n\n${tasks}`;
		this.showTextBlock(detail);
		const total =
			counts.pending + counts.in_progress + counts.completed ||
			entry.items.length;
		const summary =
			total > 0 ? `${counts.completed}/${total} done` : "no tasks yet";
		this.options.setPlanHint(`${goalKey}: ${summary}`);
	}

	private showTextBlock(content: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(content, 1, 0));
		this.options.ui.requestRender();
	}
}

function formatTask(item: TodoItem, index: number): string {
	const status = (item.status ?? "pending") as PlanStatusKey;
	const symbol = PLAN_STATUS_SYMBOLS[status] ?? "[ ]";
	const lines = [`${index}. ${symbol} ${item.content}`];
	lines.push(`   • Status: ${PLAN_STATUS_LABELS[status] ?? status}`);
	lines.push(`   • Priority: ${item.priority ?? "medium"}`);
	if (item.due) lines.push(`   • Due: ${item.due}`);
	if (item.blockedBy?.length)
		lines.push(`   • Blocked by: ${item.blockedBy.join(", ")}`);
	if (item.notes) lines.push(`   • Notes: ${item.notes}`);
	return lines.join("\n");
}

export function loadTodoStore(filePath: string): TodoStore {
	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as TodoStore;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		return {};
	}
}

export function countTodoStatuses(
	items: Array<{ status: string }>,
): Record<PlanStatusKey, number> {
	return items.reduce(
		(acc, item) => {
			const key = (item.status ?? "pending") as PlanStatusKey;
			if (acc[key] !== undefined) {
				acc[key] += 1;
			}
			return acc;
		},
		{ pending: 0, in_progress: 0, completed: 0 } as Record<
			PlanStatusKey,
			number
		>,
	);
}
