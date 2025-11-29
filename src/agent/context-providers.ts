import { formatTaskFailures } from "../tools/background-tasks.js";
import {
	formatGoalSection,
	formatSummarySection,
	formatTodosSection,
	loadStore,
} from "../tools/todo.js";
import type { AgentContextSource } from "./context-manager.js";

export class TodoContextSource implements AgentContextSource {
	name = "todo";

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			const store = await loadStore();
			// Find the most recently updated goal
			const goals = Object.values(store).sort((a, b) => {
				return (
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
				);
			});
			const activeGoal = goals[0];

			if (!activeGoal) {
				return null;
			}

			const counts = activeGoal.items.reduce(
				(acc, item) => {
					acc[item.status] += 1;
					acc.total += 1;
					return acc;
				},
				{ pending: 0, in_progress: 0, completed: 0, total: 0 } as Record<
					"pending" | "in_progress" | "completed" | "total",
					number
				>,
			);

			// Only show if there are incomplete tasks or it was recently updated
			if (counts.total > 0 && counts.completed < counts.total) {
				const summary = formatSummarySection(counts);
				const todos = formatTodosSection(activeGoal.items);
				return `# Current Task Context\n${formatGoalSection(activeGoal.goal)}\n\n${summary}\n\n${todos}`;
			}

			return null;
		} catch (error) {
			console.warn("Failed to load todo context:", error);
			return null;
		}
	}
}

export class BackgroundTaskContextSource implements AgentContextSource {
	name = "background-tasks";

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			return formatTaskFailures();
		} catch (error) {
			console.warn("Failed to load background task context:", error);
			return null;
		}
	}
}
