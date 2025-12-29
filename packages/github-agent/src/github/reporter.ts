import type { AgentConfig, Task } from "../types.js";
import type { GitHubApiClient } from "./client.js";

export type ProgressStepId =
	| "queued"
	| "branch"
	| "composer"
	| "typecheck"
	| "lint"
	| "tests"
	| "selfReview"
	| "pr";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TaskProgress {
	status: "queued" | "in_progress" | "completed" | "failed";
	steps: Partial<Record<ProgressStepId, StepStatus>>;
	branch?: string;
	prUrl?: string;
	error?: string;
	startedAt?: string;
	updatedAt?: string;
	durationMs?: number;
	attempt?: number;
	maxAttempts?: number;
	tokensUsed?: number;
	cost?: number;
}

const STATUS_ICON: Record<StepStatus, string> = {
	pending: "⬜",
	running: "⏳",
	done: "✅",
	failed: "❌",
	skipped: "⏭️",
};

const STEP_LABELS: Record<ProgressStepId, string> = {
	queued: "Queued",
	branch: "Branch created",
	composer: "Composer run",
	typecheck: "Type check",
	lint: "Lint",
	tests: "Tests",
	selfReview: "Self-review",
	pr: "PR opened",
};

export class GitHubReporter {
	constructor(
		private readonly client: GitHubApiClient,
		private readonly config: AgentConfig,
	) {}

	async upsertIssueComment(
		task: Task,
		progress: TaskProgress,
	): Promise<number | undefined> {
		if (!task.sourceIssue) return undefined;
		const body = renderTaskStatus(task, progress, this.config);
		if (task.reportCommentId) {
			await this.client.updateIssueComment(task.reportCommentId, body);
			return task.reportCommentId;
		}
		const created = await this.client.createIssueComment(
			task.sourceIssue,
			body,
		);
		return created.id;
	}
}

function renderTaskStatus(
	task: Task,
	progress: TaskProgress,
	config: AgentConfig,
): string {
	const lines: string[] = [];
	lines.push("## Composer Agent Status");
	lines.push("");
	lines.push(`**Status:** ${formatStatus(progress.status)}`);
	lines.push("");
	lines.push("### Progress");
	for (const step of orderedSteps(config)) {
		const status = progress.steps[step] ?? "pending";
		lines.push(`- ${STATUS_ICON[status]} ${STEP_LABELS[step]}`);
	}

	const detailLines: string[] = [];
	if (progress.branch) {
		detailLines.push(`- Branch: \`${progress.branch}\``);
	}
	if (progress.prUrl) {
		detailLines.push(`- PR: ${progress.prUrl}`);
	}
	if (typeof progress.attempt === "number" && progress.maxAttempts) {
		detailLines.push(`- Attempt: ${progress.attempt}/${progress.maxAttempts}`);
	}
	if (typeof progress.tokensUsed === "number") {
		detailLines.push(`- Tokens: ${progress.tokensUsed.toLocaleString()}`);
	}
	if (typeof progress.cost === "number") {
		detailLines.push(`- Cost: $${progress.cost.toFixed(2)}`);
	}
	if (progress.durationMs) {
		detailLines.push(`- Duration: ${formatDuration(progress.durationMs)}`);
	}
	if (progress.updatedAt) {
		detailLines.push(`- Updated: ${progress.updatedAt}`);
	}
	if (progress.error) {
		lines.push("");
		lines.push("### Error");
		lines.push("```");
		lines.push(progress.error.slice(0, 1500));
		lines.push("```");
	}

	if (detailLines.length > 0) {
		lines.push("");
		lines.push("### Details");
		lines.push(...detailLines);
	}

	lines.push("");
	lines.push(
		"_Automated by Composer GitHub Agent. Reply with @composer to retrigger._",
	);

	return lines.join("\n");
}

function orderedSteps(config: AgentConfig): ProgressStepId[] {
	const steps: ProgressStepId[] = ["queued", "branch", "composer"];
	if (config.requireTypeCheck) steps.push("typecheck");
	if (config.requireLint) steps.push("lint");
	if (config.requireTests) steps.push("tests");
	if (config.selfReview) steps.push("selfReview");
	steps.push("pr");
	return steps;
}

function formatStatus(status: TaskProgress["status"]): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "in_progress":
			return "In progress";
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		default:
			return status;
	}
}

function formatDuration(durationMs: number): string {
	const seconds = Math.round(durationMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `${minutes}m ${remainder}s`;
}
