import { existsSync } from "node:fs";
import type { GitView } from "./git-view.js";
import { loadTodoStore } from "./plan-view.js";
import type { ToolStatusView } from "./tool-status-view.js";
import { TOOL_FAILURE_LOG_PATH } from "./tool-status-view.js";

export interface HealthSnapshot {
	toolFailures: number;
	toolFailurePath?: string;
	gitStatus?: string;
	planGoals?: number;
	planPendingTasks?: number;
}

interface HealthSnapshotOptions {
	toolStatusView: ToolStatusView;
	gitView: GitView;
	todoStorePath: string;
}

export function collectHealthSnapshot(
	options: HealthSnapshotOptions,
): HealthSnapshot {
	const { counts } = options.toolStatusView.getToolFailureData();
	const totalFailures = Array.from(counts.values()).reduce(
		(sum: number, value: number) => sum + value,
		0,
	);
	const gitStatus = options.gitView.getStatusSummary();
	const store = loadTodoStore(options.todoStorePath);
	let pending = 0;
	for (const goal of Object.values(store)) {
		pending += goal.items.filter(
			(item) => (item.status ?? "pending") === "pending",
		).length;
	}
	return {
		toolFailures: totalFailures,
		toolFailurePath: existsSync(TOOL_FAILURE_LOG_PATH)
			? TOOL_FAILURE_LOG_PATH
			: undefined,
		gitStatus,
		planGoals: Object.keys(store).length,
		planPendingTasks: pending,
	};
}
