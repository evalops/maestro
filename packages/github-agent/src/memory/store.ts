/**
 * Memory Store - Persists learned patterns and outcomes
 *
 * The agent learns from:
 * - Merged PRs (positive signal)
 * - Rejected/closed PRs (negative signal)
 * - Review comments (specific feedback)
 * - Files that frequently cause test failures
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentStats,
	Memory,
	Outcome,
	ReviewFeedback,
	ReviewPattern,
	Task,
	TaskResult,
} from "../types.js";

const FEEDBACK_PATTERNS = [
	{
		regex: /missing test|test coverage/i,
		suggestion: "Always add tests for new functionality",
	},
	{
		regex: /type error|typescript|tsc/i,
		suggestion: "Run type checking before submitting",
	},
	{
		regex: /lint|formatting|biome|prettier/i,
		suggestion: "Run the linter and fix formatting issues before submitting",
	},
	{
		regex: /break.*backward|breaking change/i,
		suggestion: "Consider backward compatibility",
	},
	{
		regex: /security|vulnerab/i,
		suggestion: "Review for security implications",
	},
];

const MAX_SUCCESS_PATTERNS_PER_LABEL = 5;
const SUCCESS_LABELS_TO_SHOW = 3;
const SUCCESS_PATTERNS_PER_LABEL_TO_SHOW = 2;
const FILE_PATH_REGEX =
	/(?:^|\s)([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?=$|[\s),:;])/g;

export class MemoryStore {
	private memory: Memory;
	private outcomes: Map<string, Outcome> = new Map();
	private tasks: Map<string, Task> = new Map();
	private readonly memoryPath: string;
	private readonly outcomesPath: string;
	private readonly tasksPath: string;

	constructor(memoryDir: string) {
		mkdirSync(memoryDir, { recursive: true });
		this.memoryPath = join(memoryDir, "memory.json");
		this.outcomesPath = join(memoryDir, "outcomes.json");
		this.tasksPath = join(memoryDir, "tasks.json");

		this.memory = this.loadMemory();
		this.loadOutcomes();
		this.loadTasks();
	}

	private loadMemory(): Memory {
		if (existsSync(this.memoryPath)) {
			try {
				const data = JSON.parse(readFileSync(this.memoryPath, "utf-8"));
				return {
					problematicFiles: new Map(
						Object.entries(data.problematicFiles || {}),
					),
					successfulPatterns: new Map(
						Object.entries(data.successfulPatterns || {}),
					),
					reviewPatterns: data.reviewPatterns || [],
					stats: data.stats || this.defaultStats(),
				};
			} catch {
				// Corrupted, start fresh
			}
		}
		return {
			problematicFiles: new Map(),
			successfulPatterns: new Map(),
			reviewPatterns: [],
			stats: this.defaultStats(),
		};
	}

	private defaultStats(): AgentStats {
		return {
			totalTasks: 0,
			completedTasks: 0,
			mergedPRs: 0,
			rejectedPRs: 0,
			averageAttemptsToMerge: 0,
			totalTokensUsed: 0,
			totalCost: 0,
			dailyCost: 0,
			dailyCostDate: new Date().toISOString().split("T")[0],
		};
	}

	private getTodayDate(): string {
		return new Date().toISOString().split("T")[0];
	}

	/**
	 * Get today's cost, resetting if the date has changed
	 */
	getDailyCost(): number {
		const today = this.getTodayDate();
		if (this.memory.stats.dailyCostDate !== today) {
			// New day, reset daily cost
			this.memory.stats.dailyCost = 0;
			this.memory.stats.dailyCostDate = today;
			this.save();
		}
		return this.memory.stats.dailyCost;
	}

	private loadOutcomes(): void {
		if (existsSync(this.outcomesPath)) {
			try {
				const data = JSON.parse(readFileSync(this.outcomesPath, "utf-8"));
				this.outcomes = new Map(Object.entries(data));
			} catch {
				// Start fresh
			}
		}
	}

	private loadTasks(): void {
		if (existsSync(this.tasksPath)) {
			try {
				const data = JSON.parse(readFileSync(this.tasksPath, "utf-8"));
				this.tasks = new Map(Object.entries(data));
			} catch {
				// Start fresh
			}
		}
	}

	save(): void {
		// Save memory
		const memoryData = {
			problematicFiles: Object.fromEntries(this.memory.problematicFiles),
			successfulPatterns: Object.fromEntries(this.memory.successfulPatterns),
			reviewPatterns: this.memory.reviewPatterns,
			stats: this.memory.stats,
		};
		writeFileSync(this.memoryPath, JSON.stringify(memoryData, null, 2));

		// Save outcomes
		writeFileSync(
			this.outcomesPath,
			JSON.stringify(Object.fromEntries(this.outcomes), null, 2),
		);

		// Save tasks
		writeFileSync(
			this.tasksPath,
			JSON.stringify(Object.fromEntries(this.tasks), null, 2),
		);
	}

	// =========================================================================
	// Task management
	// =========================================================================

	addTask(task: Task): void {
		this.tasks.set(task.id, task);
		this.memory.stats.totalTasks++;
		this.save();
	}

	getTask(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	updateTask(id: string, update: Partial<Task>): Task | undefined {
		const task = this.tasks.get(id);
		if (!task) return undefined;
		Object.assign(task, update);
		this.save();
		return task;
	}

	getPendingTasks(): Task[] {
		return Array.from(this.tasks.values())
			.filter((t) => t.status === "pending")
			.sort((a, b) => b.priority - a.priority);
	}

	getInProgressTasks(): Task[] {
		return Array.from(this.tasks.values()).filter(
			(t) => t.status === "in_progress",
		);
	}

	updateTaskStatus(
		id: string,
		status: Task["status"],
		result?: TaskResult,
	): void {
		const task = this.tasks.get(id);
		if (!task) return;

		task.status = status;
		task.lastAttemptAt = new Date().toISOString();

		if (result) {
			task.result = result;
			if (result.tokensUsed) {
				this.memory.stats.totalTokensUsed += result.tokensUsed;
			}
			if (result.cost) {
				this.memory.stats.totalCost += result.cost;
				// Also track daily cost (reset happens in getDailyCost)
				const today = this.getTodayDate();
				if (this.memory.stats.dailyCostDate !== today) {
					this.memory.stats.dailyCost = 0;
					this.memory.stats.dailyCostDate = today;
				}
				this.memory.stats.dailyCost += result.cost;
			}
		}

		if (status === "completed") {
			this.memory.stats.completedTasks++;
		}

		this.save();
	}

	incrementAttempts(id: string): number {
		const task = this.tasks.get(id);
		if (!task) return 0;
		task.attempts++;
		task.lastAttemptAt = new Date().toISOString();
		this.save();
		return task.attempts;
	}

	// Check if we've already attempted this issue
	hasAttemptedIssue(issueNumber: number): boolean {
		return Array.from(this.tasks.values()).some(
			(t) => t.sourceIssue === issueNumber && t.attempts > 0,
		);
	}

	// =========================================================================
	// Outcome tracking
	// =========================================================================

	recordOutcome(taskId: string, prNumber: number): void {
		this.outcomes.set(taskId, {
			taskId,
			prNumber,
			status: "pending",
			reviewFeedback: [],
			updatedAt: new Date().toISOString(),
		});
		this.save();
	}

	updateOutcome(
		taskId: string,
		status: Outcome["status"],
		feedback?: ReviewFeedback,
	): void {
		const outcome = this.outcomes.get(taskId);
		if (!outcome) return;

		outcome.status = status;
		outcome.updatedAt = new Date().toISOString();

		if (status === "merged") {
			outcome.mergedAt = outcome.updatedAt;
			this.memory.stats.mergedPRs++;
			this.learnFromSuccess(taskId);
		} else if (status === "closed") {
			outcome.closedAt = outcome.updatedAt;
			this.memory.stats.rejectedPRs++;
			this.learnFromFailure(taskId);
		}

		if (feedback) {
			outcome.reviewFeedback.push(feedback);
			this.learnFromFeedback(feedback);
		}

		this.save();
	}

	getPendingOutcomes(): Outcome[] {
		return Array.from(this.outcomes.values()).filter(
			(o) => o.status === "pending" || o.status === "changes_requested",
		);
	}

	// =========================================================================
	// Learning
	// =========================================================================

	private learnFromSuccess(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;

		// Update average attempts to merge
		const { mergedPRs, averageAttemptsToMerge } = this.memory.stats;
		const totalAttempts =
			averageAttemptsToMerge * (mergedPRs - 1) + task.attempts;
		this.memory.stats.averageAttemptsToMerge = totalAttempts / mergedPRs;

		const labels = this.getTaskLabels(task);
		if (labels.length === 0) return;

		const summary = this.buildSuccessSummary(task);
		if (!summary) return;

		for (const label of labels) {
			this.addSuccessfulPattern(label, summary);
		}
	}

	private learnFromFailure(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;

		const error = task.result?.error;
		if (!error) return;

		this.applyReviewPatterns(error);

		const paths = this.extractFilePaths(error);
		for (const path of paths) {
			this.incrementProblematicFile(path);
		}
	}

	private learnFromFeedback(feedback: ReviewFeedback): void {
		// Extract patterns from review comments
		for (const comment of feedback.comments) {
			this.applyReviewPatterns(comment);
		}
	}

	private applyReviewPatterns(text: string): void {
		for (const { regex, suggestion } of FEEDBACK_PATTERNS) {
			if (regex.test(text)) {
				this.addReviewPattern(regex.source, suggestion);
			}
		}
	}

	private getTaskLabels(task: Task): string[] {
		const rawLabels =
			task.labels && task.labels.length > 0
				? task.labels
				: this.parseLabelsFromDescription(task.description);
		const normalized = rawLabels
			.map((label) => label.trim())
			.filter(Boolean)
			.map((label) => label.toLowerCase())
			.filter((label) => label !== "none");
		return Array.from(new Set(normalized));
	}

	private parseLabelsFromDescription(description: string): string[] {
		const match = description.match(/^Labels:\s*(.+)$/im);
		if (!match) return [];
		return match[1]
			.split(",")
			.map((label) => label.trim())
			.filter(Boolean);
	}

	private buildSuccessSummary(task: Task): string | null {
		const parts = [];
		if (task.sourceIssue) {
			parts.push(`#${task.sourceIssue}`);
		}
		if (task.title) {
			parts.push(task.title.trim());
		} else if (task.description) {
			const firstLine = task.description.split("\n")[0]?.trim();
			if (firstLine) {
				parts.push(firstLine);
			}
		}
		if (task.result?.prNumber) {
			parts.push(`PR #${task.result.prNumber}`);
		}
		if (parts.length === 0) return null;
		const summary = parts.join(" — ");
		return summary.length > 140 ? `${summary.slice(0, 137)}...` : summary;
	}

	private addSuccessfulPattern(label: string, summary: string): void {
		const key = label.toLowerCase();
		const existing = this.memory.successfulPatterns.get(key) || [];
		if (!existing.includes(summary)) {
			existing.unshift(summary);
			if (existing.length > MAX_SUCCESS_PATTERNS_PER_LABEL) {
				existing.pop();
			}
			this.memory.successfulPatterns.set(key, existing);
		}
	}

	private addReviewPattern(pattern: string, suggestion: string): void {
		const existing = this.memory.reviewPatterns.find(
			(p) => p.pattern === pattern,
		);
		if (existing) {
			existing.frequency++;
		} else {
			this.memory.reviewPatterns.push({ pattern, frequency: 1, suggestion });
		}
	}

	private incrementProblematicFile(path: string): void {
		const current = this.memory.problematicFiles.get(path) || 0;
		this.memory.problematicFiles.set(path, current + 1);
	}

	private extractFilePaths(text: string): string[] {
		if (!text) return [];
		const matches = text.matchAll(FILE_PATH_REGEX);
		const paths = new Set<string>();
		for (const match of matches) {
			const candidate = match[1];
			if (!candidate.includes("/") || candidate.includes("://")) continue;
			paths.add(candidate);
		}
		return Array.from(paths);
	}

	recordFileFailure(path: string): void {
		this.incrementProblematicFile(path);
		this.save();
	}

	// =========================================================================
	// Context for prompts
	// =========================================================================

	/**
	 * Generate context to inject into agent prompts based on learned patterns
	 */
	getContextForPrompt(): string {
		const lines: string[] = [];

		// Add review patterns to avoid
		if (this.memory.reviewPatterns.length > 0) {
			lines.push("## Learned from past PR reviews and failures:");
			const sorted = [...this.memory.reviewPatterns].sort(
				(a, b) => b.frequency - a.frequency,
			);
			for (const pattern of sorted.slice(0, 5)) {
				lines.push(`- ${pattern.suggestion} (seen ${pattern.frequency}x)`);
			}
			lines.push("");
		}

		// Add successful patterns by label
		if (this.memory.successfulPatterns.size > 0) {
			lines.push("## Successful patterns by label:");
			const sorted = Array.from(this.memory.successfulPatterns.entries())
				.map(([label, patterns]) => ({ label, patterns }))
				.sort((a, b) => b.patterns.length - a.patterns.length);
			for (const entry of sorted.slice(0, SUCCESS_LABELS_TO_SHOW)) {
				const examples = entry.patterns
					.slice(0, SUCCESS_PATTERNS_PER_LABEL_TO_SHOW)
					.join("; ");
				lines.push(`- ${entry.label}: ${examples}`);
			}
			lines.push("");
		}

		// Add problematic files warning
		const problematic = Array.from(this.memory.problematicFiles.entries())
			.filter(([_, count]) => count >= 2)
			.sort((a, b) => b[1] - a[1]);

		if (problematic.length > 0) {
			lines.push("## Files that often cause issues:");
			for (const [path, count] of problematic.slice(0, 5)) {
				lines.push(`- ${path} (${count} failures)`);
			}
			lines.push("");
		}

		// Add success stats for confidence
		const { mergedPRs, rejectedPRs } = this.memory.stats;
		if (mergedPRs + rejectedPRs > 0) {
			const successRate = Math.round(
				(mergedPRs / (mergedPRs + rejectedPRs)) * 100,
			);
			lines.push(
				`## Track record: ${successRate}% merge rate (${mergedPRs}/${mergedPRs + rejectedPRs} PRs)`,
			);
			lines.push("");
		}

		return lines.join("\n");
	}

	getStats(): AgentStats {
		return { ...this.memory.stats };
	}
}
