import type { Component } from "@evalops/tui";
import chalk from "chalk";
import { theme } from "../theme/theme.js";
import type { TodoGoalEntry, TodoItem } from "./plan-view.js";
import { centerText, padLine, truncateText } from "./utils/text-formatting.js";

const PLAN_STATUS_SYMBOLS = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
} as const;

interface PlanPanelModalOptions {
	onClose: () => void;
	onNavigate: (delta: number) => void;
	onToggleComplete: () => void;
	onMoveTask: (direction: "up" | "down") => void;
}

export class PlanPanelModal implements Component {
	private goals: { key: string; entry: TodoGoalEntry }[] = [];
	private selectedGoalIndex = 0;
	private selectedTaskIndex = 0;

	constructor(private readonly options: PlanPanelModalOptions) {}

	setData(store: Record<string, TodoGoalEntry>): void {
		this.goals = Object.entries(store).map(([key, entry]) => ({
			key,
			entry,
		}));
		// Clamp indices
		if (this.selectedGoalIndex >= this.goals.length) {
			this.selectedGoalIndex = Math.max(0, this.goals.length - 1);
		}
		const selectedGoal = this.goals[this.selectedGoalIndex];
		if (
			selectedGoal &&
			this.selectedTaskIndex >= selectedGoal.entry.items.length
		) {
			this.selectedTaskIndex = Math.max(0, selectedGoal.entry.items.length - 1);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const borderColor = "#8b5cf6";

		// Top border
		lines.push(theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`));

		// Title
		const title = centerText("PLANS", width - 4);
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${theme.bold(theme.fg("text", title))}${theme.fg("borderAccent", " │")}`,
		);

		// Separator
		lines.push(theme.fg("borderAccent", `├${"─".repeat(width - 2)}┤`));

		if (this.goals.length === 0) {
			const emptyLine = padLine(
				theme.fg("dim", "No plans found. Use /plan new <goal> to create one."),
				width - 4,
			);
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${emptyLine}${theme.fg("borderAccent", " │")}`,
			);
		} else {
			const selectedGoal = this.goals[this.selectedGoalIndex];

			// Show all goals as tabs
			const goalTabs = this.goals.map((g, idx) => {
				const counts = this.countTodoStatuses(g.entry.items);
				const progress = `${counts.completed}/${g.entry.items.length}`;
				if (idx === this.selectedGoalIndex) {
					return theme.bold(theme.fg("accent", `[${g.key} ${progress}]`));
				}
				return theme.fg("dim", `${g.key} ${progress}`);
			});
			const tabsLine = padLine(goalTabs.join(" · "), width - 4);
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${tabsLine}${theme.fg("borderAccent", " │")}`,
			);

			lines.push(
				`${theme.fg("borderAccent", "│ ")}${" ".repeat(width - 4)}${theme.fg("borderAccent", " │")}`,
			);

			// Show tasks for selected goal
			if (selectedGoal.entry.items.length === 0) {
				const emptyLine = padLine(theme.fg("dim", "No tasks yet."), width - 4);
				lines.push(
					`${theme.fg("borderAccent", "│ ")}${emptyLine}${theme.fg("borderAccent", " │")}`,
				);
			} else {
				const maxDisplay = 10;
				const start = Math.max(
					0,
					Math.min(
						this.selectedTaskIndex - Math.floor(maxDisplay / 2),
						selectedGoal.entry.items.length - maxDisplay,
					),
				);
				const visible = selectedGoal.entry.items.slice(
					start,
					start + maxDisplay,
				);

				for (let i = 0; i < visible.length; i++) {
					const task = visible[i];
					const actualIndex = start + i;
					const isSelected = actualIndex === this.selectedTaskIndex;
					const prefix = isSelected ? theme.fg("accent", "► ") : "  ";
					const status = this.getStatusSymbol(task);
					const content = truncateText(task.content, width - 12);
					const taskLine = padLine(
						`${prefix}${status} ${theme.fg("text", content)}`,
						width - 4,
					);
					lines.push(
						`${theme.fg("borderAccent", "│ ")}${taskLine}${theme.fg("borderAccent", " │")}`,
					);
				}

				if (selectedGoal.entry.items.length > maxDisplay) {
					const remainingCount = selectedGoal.entry.items.length - maxDisplay;
					const moreLabel = padLine(
						theme.fg("dim", `... and ${remainingCount} more`),
						width - 4,
					);
					lines.push(
						`${theme.fg("borderAccent", "│ ")}${moreLabel}${theme.fg("borderAccent", " │")}`,
					);
				}
			}

			// Summary stats
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${" ".repeat(width - 4)}${theme.fg("borderAccent", " │")}`,
			);
			const counts = this.countTodoStatuses(selectedGoal.entry.items);
			const statsLine = padLine(
				theme.fg(
					"dim",
					`Stats: ${counts.completed} completed · ${counts.in_progress} in progress · ${counts.pending} pending`,
				),
				width - 4,
			);
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${statsLine}${theme.fg("borderAccent", " │")}`,
			);
		}

		// Bottom separator
		lines.push(theme.fg("borderAccent", `├${"─".repeat(width - 2)}┤`));

		// Help text
		const helpText =
			this.goals.length > 0
				? "[↑/↓] navigate  [shift+↑/↓] move  [←/→] switch goals  [space] toggle  [esc] close"
				: "[esc] close";
		const helpLine = centerText(helpText, width - 4);
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${theme.fg("dim", helpLine)}${theme.fg("borderAccent", " │")}`,
		);

		// Bottom border
		lines.push(theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`));

		return lines;
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			// Escape
			this.options.onClose();
			return;
		}
		if (data === "\x1b[A") {
			// Up arrow
			this.options.onNavigate(-1);
			return;
		}
		if (data === "\x1b[B") {
			// Down arrow
			this.options.onNavigate(1);
			return;
		}
		if (data === "\x1b[1;2A" || data === "K") {
			// Shift+Up or K
			this.options.onMoveTask("up");
			return;
		}
		if (data === "\x1b[1;2B" || data === "J") {
			// Shift+Down or J
			this.options.onMoveTask("down");
			return;
		}
		if (data === "\x1b[C") {
			// Right arrow - next goal
			if (this.goals.length > 0) {
				this.selectedGoalIndex =
					(this.selectedGoalIndex + 1) % this.goals.length;
				this.selectedTaskIndex = 0;
			}
			return;
		}
		if (data === "\x1b[D") {
			// Left arrow - previous goal
			if (this.goals.length > 0) {
				this.selectedGoalIndex =
					(this.selectedGoalIndex - 1 + this.goals.length) % this.goals.length;
				this.selectedTaskIndex = 0;
			}
			return;
		}
		if (data === " ") {
			// Space - toggle completion
			this.options.onToggleComplete();
			return;
		}
	}

	getSelectedGoal(): { key: string; entry: TodoGoalEntry } | null {
		return this.goals[this.selectedGoalIndex] || null;
	}

	getSelectedTask(): TodoItem | null {
		const goal = this.goals[this.selectedGoalIndex];
		if (!goal) return null;
		return goal.entry.items[this.selectedTaskIndex] || null;
	}

	navigateTasks(delta: number): void {
		const goal = this.goals[this.selectedGoalIndex];
		if (!goal) return;
		this.selectedTaskIndex = Math.max(
			0,
			Math.min(goal.entry.items.length - 1, this.selectedTaskIndex + delta),
		);
	}

	private getStatusSymbol(task: TodoItem): string {
		const status = (task.status ??
			"pending") as keyof typeof PLAN_STATUS_SYMBOLS;
		const symbol = PLAN_STATUS_SYMBOLS[status] || PLAN_STATUS_SYMBOLS.pending;

		switch (status) {
			case "completed":
				return theme.fg("success", symbol);
			case "in_progress":
				return theme.fg("warning", symbol);
			default:
				return theme.fg("dim", symbol);
		}
	}

	private countTodoStatuses(items: TodoItem[]): {
		pending: number;
		in_progress: number;
		completed: number;
	} {
		return items.reduce(
			(acc, item) => {
				const status = item.status ?? "pending";
				if (status in acc) {
					acc[status as keyof typeof acc]++;
				}
				return acc;
			},
			{ pending: 0, in_progress: 0, completed: 0 },
		);
	}
}
