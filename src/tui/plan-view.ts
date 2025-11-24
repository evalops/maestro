import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";

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

const STATUS_ACCENTS = {
	pending: (value: string) => chalk.dim(value),
	in_progress: (value: string) => chalk.yellow(value),
	completed: (value: string) => chalk.green(value),
} as const;

const formatInfoLabel = (label: string): string =>
	chalk.dim(label.toUpperCase());

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
	onStoreChanged?: (store: TodoStore) => void;
}

export class PlanView {
	constructor(private readonly options: PlanViewOptions) {}

	syncHintWithStore(): void {
		const store = loadTodoStore(this.options.filePath);
		const hint = calculatePlanHint(store);
		this.options.setPlanHint(hint);
	}

	handlePlanCommand(text: string): void {
		const store = loadTodoStore(this.options.filePath);
		const argsPortion = this.extractArgs(text);
		if (this.tryHandlePlanAction(store, argsPortion)) {
			return;
		}
		const goals = Object.keys(store);
		if (goals.length === 0) {
			this.options.showInfoMessage(
				"No plans found. Use /plan new <goal> to start a checklist.",
			);
			this.options.setPlanHint(null);
			return;
		}
		if (!argsPortion) {
			this.showPlanSummary(store);
			return;
		}
		const goalKey = findGoalKey(store, argsPortion);
		if (!goalKey) {
			this.options.showInfoMessage(`No plan found matching "${argsPortion}".`);
			return;
		}
		this.showGoalDetail(store, goalKey);
	}

	private showTextBlock(content: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(content, 1, 0));
		this.options.ui.requestRender();
	}

	private notifyStoreChanged(store: TodoStore): void {
		if (!this.options.onStoreChanged) {
			return;
		}
		const snapshot: TodoStore = JSON.parse(JSON.stringify(store));
		this.options.onStoreChanged(snapshot);
	}

	private extractArgs(text: string): string {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/plan")) {
			return trimmed;
		}
		return trimmed.slice("/plan".length).trim();
	}

	private tryHandlePlanAction(store: TodoStore, argsPortion: string): boolean {
		if (!argsPortion) {
			return false;
		}
		const [firstWord, ...restWords] = argsPortion.split(/\s+/);
		const action = firstWord.toLowerCase();
		const remainder = argsPortion.slice(firstWord.length).trim();
		switch (action) {
			case "help":
				this.showTextBlock(
					`${chalk.bold("Plan command help")}
/plan — list all plans
/plan <goal> — show plan details
/plan new <goal> — create a plan
/plan add <goal> :: <task> [:: priority] — add a task
/plan complete <goal> :: <task number|id> — mark done
/plan clear <goal> — delete a plan
/plan clear all — delete all plans`,
				);
				return true;
			case "new":
				this.handlePlanCreate(store, remainder);
				return true;
			case "add":
				this.handlePlanAdd(store, remainder);
				return true;
			case "complete":
				this.handlePlanComplete(store, remainder);
				return true;
			case "clear":
				this.handlePlanClear(store, remainder);
				return true;
			default:
				return false;
		}
	}

	private handlePlanCreate(store: TodoStore, goalName: string): void {
		const name = goalName.trim();
		if (!name) {
			this.options.showInfoMessage(
				"Provide a goal name, e.g. /plan new Release Checklist",
			);
			return;
		}
		if (store[name]) {
			this.options.showInfoMessage(`A plan named "${name}" already exists.`);
			return;
		}
		store[name] = {
			goal: name,
			items: [],
			updatedAt: new Date().toISOString(),
		};
		saveTodoStore(this.options.filePath, store);
		this.notifyStoreChanged(store);
		this.options.showInfoMessage(`Created plan "${name}".`);
		this.options.setPlanHint(`${name}: no tasks yet`);
		this.showGoalDetail(store, name);
	}

	private handlePlanAdd(store: TodoStore, remainder: string): void {
		const segments = remainder
			.split("::")
			.map((segment) => segment.trim())
			.filter(Boolean);
		if (segments.length < 2) {
			this.options.showInfoMessage(
				"Use /plan add <goal> :: <task> [:: priority]",
			);
			return;
		}
		const goalKey = findGoalKey(store, segments[0]);
		if (!goalKey) {
			this.options.showInfoMessage(`No plan found matching "${segments[0]}".`);
			return;
		}
		const priority = (segments[2]?.toLowerCase() || "medium").trim();
		const entry = store[goalKey];
		entry.items.push({
			id: randomUUID(),
			content: segments[1],
			status: "pending",
			priority,
		});
		entry.updatedAt = new Date().toISOString();
		saveTodoStore(this.options.filePath, store);
		this.notifyStoreChanged(store);
		this.options.showInfoMessage(`Added task to "${goalKey}".`);
		this.showGoalDetail(store, goalKey);
	}

	private handlePlanComplete(store: TodoStore, remainder: string): void {
		const segments = remainder
			.split("::")
			.map((segment) => segment.trim())
			.filter(Boolean);
		if (segments.length < 2) {
			this.options.showInfoMessage(
				"Use /plan complete <goal> :: <task number|id>",
			);
			return;
		}
		const goalKey = findGoalKey(store, segments[0]);
		if (!goalKey) {
			this.options.showInfoMessage(`No plan found matching "${segments[0]}".`);
			return;
		}
		const entry = store[goalKey];
		const taskRef = segments[1];
		const task = this.resolveTask(entry, taskRef);
		if (!task) {
			this.options.showInfoMessage(`Task "${taskRef}" was not found.`);
			return;
		}
		task.status = "completed";
		entry.updatedAt = new Date().toISOString();
		saveTodoStore(this.options.filePath, store);
		this.notifyStoreChanged(store);
		this.options.showInfoMessage(`Marked task as completed in "${goalKey}".`);
		this.showGoalDetail(store, goalKey);
	}

	private handlePlanClear(store: TodoStore, remainder: string): void {
		const targetName = remainder.trim();
		if (!targetName) {
			this.options.showInfoMessage(
				"Provide a goal name or 'all', e.g. /plan clear Release Checklist",
			);
			return;
		}

		// Handle clearing all plans
		if (targetName.toLowerCase() === "all") {
			const count = Object.keys(store).length;
			if (count === 0) {
				this.options.showInfoMessage("No plans to clear.");
				return;
			}
			// Clear all plans
			for (const key of Object.keys(store)) {
				delete store[key];
			}
			saveTodoStore(this.options.filePath, store);
			this.notifyStoreChanged(store);
			this.options.showInfoMessage(`Cleared all ${count} plan(s).`);
			this.options.setPlanHint(null);
			this.showTextBlock(
				"All plans have been deleted. Use /plan new <goal> to start fresh.",
			);
			return;
		}

		// Handle clearing a specific plan
		const goalKey = findGoalKey(store, targetName);
		if (!goalKey) {
			this.options.showInfoMessage(`No plan found matching "${targetName}".`);
			return;
		}

		delete store[goalKey];
		saveTodoStore(this.options.filePath, store);
		this.notifyStoreChanged(store);
		this.options.showInfoMessage(`Deleted plan "${goalKey}".`);
		this.options.setPlanHint(calculatePlanHint(store));

		// Show remaining plans or empty state
		const remaining = Object.keys(store);
		if (remaining.length > 0) {
			this.showPlanSummary(store);
		} else {
			this.showTextBlock(
				"No plans found. Use /plan new <goal> to start a checklist.",
			);
		}
	}

	public toggleTaskCompletion(goalKey: string, taskId: string): void {
		const store = loadTodoStore(this.options.filePath);
		const entry = store[goalKey];
		if (!entry) {
			this.options.showInfoMessage(`Plan "${goalKey}" no longer exists.`);
			return;
		}
		const task = entry.items.find((item) => item.id === taskId);
		if (!task) {
			this.options.showInfoMessage("Selected task was not found.");
			return;
		}
		const statusCycle: PlanStatusKey[] = [
			"pending",
			"in_progress",
			"completed",
		];
		const currentStatus = (task.status ?? "pending") as PlanStatusKey;
		const currentIndex = statusCycle.indexOf(currentStatus);
		const nextStatus =
			statusCycle[(currentIndex + 1) % statusCycle.length] ?? "pending";
		task.status = nextStatus;
		entry.updatedAt = new Date().toISOString();
		saveTodoStore(this.options.filePath, store);
		this.notifyStoreChanged(store);
		this.options.setPlanHint(calculatePlanHint(store));
		const message = (() => {
			switch (nextStatus) {
				case "in_progress":
					return `Marked task as in progress in "${goalKey}".`;
				case "completed":
					return `Marked task as complete in "${goalKey}".`;
				default:
					return `Reopened task in "${goalKey}".`;
			}
		})();
		this.options.showInfoMessage(message);
	}

	public moveTask(
		goalKey: string,
		taskId: string,
		direction: "up" | "down",
	): void {
		const store = loadTodoStore(this.options.filePath);
		const entry = store[goalKey];
		if (!entry) return;

		const index = entry.items.findIndex((item) => item.id === taskId);
		if (index === -1) return;

		const newIndex = direction === "up" ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= entry.items.length) return;

		const [item] = entry.items.splice(index, 1);
		entry.items.splice(newIndex, 0, item);
		entry.updatedAt = new Date().toISOString();

		saveTodoStore(this.options.filePath, store);
		this.notifyStoreChanged(store);
	}

	private resolveTask(entry: TodoGoalEntry, ref: string): TodoItem | undefined {
		const numeric = Number.parseInt(ref, 10);
		if (
			!Number.isNaN(numeric) &&
			numeric > 0 &&
			numeric <= entry.items.length
		) {
			return entry.items[numeric - 1];
		}
		return entry.items.find((item) => item.id === ref.trim());
	}

	private showPlanSummary(store: TodoStore): void {
		const goals = Object.keys(store);
		const summaries = goals.map((goal) => {
			const entry = store[goal];
			const counts = countTodoStatuses(entry.items);
			return `${chalk.bold(goal)}\n  ${formatInfoLabel("Pending")} ${counts.pending
				.toString()
				.padStart(
					2,
					" ",
				)}\n  ${formatInfoLabel("In Progress")} ${counts.in_progress
				.toString()
				.padStart(2, " ")}\n  ${formatInfoLabel("Completed")} ${counts.completed
				.toString()
				.padStart(2, " ")}`;
		});
		this.showTextBlock(
			`${chalk.bold("PLAN OVERVIEW")}\n${summaries.join("\n\n")}\n\n${chalk.dim(
				"Use /plan <goal> to see details.",
			)}`,
		);
		this.options.setPlanHint(null);
	}

	private showGoalDetail(store: TodoStore, goalKey: string): void {
		const entry = store[goalKey];
		const counts = countTodoStatuses(entry.items);
		const tasks = entry.items.length
			? entry.items
					.map((item, index) => formatTask(item, index + 1))
					.join("\n\n")
			: chalk.dim("No tasks yet — add some with /plan add <goal> :: <task>.");
		const totalTasks =
			counts.pending + counts.in_progress + counts.completed ||
			entry.items.length ||
			0;
		const progressLine = `${formatInfoLabel("Progress")}  ${counts.completed}/${totalTasks}`;
		const totalsLine = `${formatInfoLabel("Totals")}   ${counts.pending}/${counts.in_progress}/${counts.completed}`;
		const detail = `${chalk.bold(goalKey.toUpperCase())}\n${formatInfoLabel("Updated")}  ${new Date(entry.updatedAt).toLocaleString()}\n${progressLine}\n${totalsLine}\n\n${tasks}`;
		this.showTextBlock(detail);
		const total =
			counts.pending + counts.in_progress + counts.completed ||
			entry.items.length;
		const summary =
			total > 0 ? `${counts.completed}/${total} done` : "no tasks yet";
		this.options.setPlanHint(`${goalKey}: ${summary}`);
	}
}

function formatTask(item: TodoItem, index: number): string {
	const status = (item.status ?? "pending") as PlanStatusKey;
	const accent = STATUS_ACCENTS[status] ?? ((value: string) => value);
	const symbol = accent(PLAN_STATUS_SYMBOLS[status] ?? "[ ]");
	const statusLabel = accent(PLAN_STATUS_LABELS[status] ?? status);
	const indexLabel = chalk.dim(`#${String(index).padStart(2, "0")}`);
	const priorityValue = capitalizeWords(item.priority ?? "medium");
	const lines = [`${indexLabel}  ${symbol} ${chalk.bold(item.content)}`];
	lines.push(`   ${formatInfoLabel("Status")}   ${statusLabel}`);
	lines.push(`   ${formatInfoLabel("Priority")} ${priorityValue}`);
	if (item.due) lines.push(`   ${formatInfoLabel("Due")}      ${item.due}`);
	if (item.blockedBy?.length)
		lines.push(
			`   ${formatInfoLabel("Blocked By")} ${item.blockedBy.join(", ")}`,
		);
	if (item.notes) lines.push(`   ${formatInfoLabel("Notes")}    ${item.notes}`);
	return lines.join("\n");
}

function capitalizeWords(value: string): string {
	return value
		.split(/\s+/)
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(" ");
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

export function saveTodoStore(filePath: string, store: TodoStore): void {
	writeFileSync(filePath, JSON.stringify(store, null, 2));
}

export function calculatePlanHint(store: TodoStore): string | null {
	const goals = Object.values(store);
	if (goals.length === 0) return null;
	goals.sort((a, b) => {
		const aTime = Number(new Date(a.updatedAt ?? 0));
		const bTime = Number(new Date(b.updatedAt ?? 0));
		return bTime - aTime;
	});
	const entry = goals[0];
	const counts = countTodoStatuses(entry.items ?? []);
	const total = counts.pending + counts.in_progress + counts.completed;
	const summary = total > 0 ? `${counts.completed}/${total} done` : "no tasks";
	return `${entry.goal}: ${summary}`;
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

function findGoalKey(store: TodoStore, query: string): string | undefined {
	const goals = Object.keys(store);
	return (
		goals.find((goal) => goal.toLowerCase() === query.toLowerCase()) ??
		goals.find((goal) => goal.toLowerCase().includes(query.toLowerCase()))
	);
}
