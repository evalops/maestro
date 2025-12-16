/**
 * Orchestrator - The brain of the GitHub Agent
 *
 * Coordinates:
 * - Watching for new issues/PR updates
 * - Triaging and prioritizing work
 * - Executing tasks
 * - Learning from outcomes
 */

import { MemoryStore } from "./memory/store.js";
import { IssuePrioritizer } from "./triage/prioritizer.js";
import type {
	AgentConfig,
	DEFAULT_CONFIG,
	GitHubIssue,
	GitHubPR,
	PRComment,
	PRReview,
	Task,
} from "./types.js";
import { GitHubWatcher } from "./watcher/github.js";
import { TaskExecutor } from "./worker/executor.js";

export interface OrchestratorConfig extends AgentConfig {
	githubToken: string;
}

export class Orchestrator {
	private config: OrchestratorConfig;
	private memory: MemoryStore;
	private watcher: GitHubWatcher;
	private prioritizer: IssuePrioritizer;
	private executor: TaskExecutor;
	private isRunning = false;
	private processingLock = false;

	constructor(config: OrchestratorConfig) {
		this.config = config;

		// Initialize components
		this.memory = new MemoryStore(config.memoryDir);

		this.watcher = new GitHubWatcher(config.githubToken, config, {
			onNewIssue: (issue) => this.handleNewIssue(issue),
			onPRMerged: (pr) => this.handlePRMerged(pr),
			onPRClosed: (pr) => this.handlePRClosed(pr),
			onPRReview: (pr, review) => this.handlePRReview(pr, review),
			onPRComment: (pr, comment) => this.handlePRComment(pr, comment),
		});

		this.prioritizer = new IssuePrioritizer(this.memory);

		this.executor = new TaskExecutor({
			config,
			memory: this.memory,
			onLog: (msg) => console.log(msg),
		});
	}

	async start(): Promise<void> {
		console.log("[orchestrator] Starting GitHub Agent");
		console.log(
			`[orchestrator] Repository: ${this.config.owner}/${this.config.repo}`,
		);
		console.log(`[orchestrator] Working directory: ${this.config.workingDir}`);
		console.log(`[orchestrator] Memory directory: ${this.config.memoryDir}`);

		this.isRunning = true;

		// Start watching GitHub
		await this.watcher.start();

		// Resume any pending work
		await this.resumePendingWork();

		// Start the processing loop
		this.processLoop();

		console.log("[orchestrator] Agent is running");
	}

	async stop(): Promise<void> {
		console.log("[orchestrator] Stopping...");
		this.isRunning = false;
		this.watcher.stop();
		this.memory.save();
		console.log("[orchestrator] Stopped");
	}

	// =========================================================================
	// Event handlers
	// =========================================================================

	private async handleNewIssue(issue: GitHubIssue): Promise<void> {
		console.log(`[orchestrator] New issue: #${issue.number} - ${issue.title}`);

		// Triage the issue
		const triage = this.prioritizer.triage(issue);
		console.log(
			`[orchestrator] Triage result: ${triage.shouldProcess ? "ACCEPT" : "SKIP"} - ${triage.reason}`,
		);

		if (!triage.shouldProcess) {
			return;
		}

		// Create a task
		const task = this.prioritizer.createTask(issue, triage);
		this.memory.addTask(task);

		console.log(
			`[orchestrator] Task created: ${task.id} (priority: ${task.priority})`,
		);
	}

	private async handlePRMerged(pr: GitHubPR): Promise<void> {
		console.log(`[orchestrator] PR merged: #${pr.number}`);

		// Find the task that created this PR
		const task = this.findTaskByPR(pr.number);
		if (task) {
			this.memory.updateOutcome(task.id, "merged");
			console.log(`[orchestrator] Recorded merge for task ${task.id}`);
		}
	}

	private async handlePRClosed(pr: GitHubPR): Promise<void> {
		console.log(`[orchestrator] PR closed: #${pr.number}`);

		const task = this.findTaskByPR(pr.number);
		if (task) {
			this.memory.updateOutcome(task.id, "closed");
			console.log(`[orchestrator] Recorded close for task ${task.id}`);
		}
	}

	private async handlePRReview(pr: GitHubPR, review: PRReview): Promise<void> {
		console.log(
			`[orchestrator] PR review: #${pr.number} - ${review.state} by ${review.author}`,
		);

		const task = this.findTaskByPR(pr.number);
		if (task) {
			const decision =
				review.state === "APPROVED"
					? "approved"
					: review.state === "CHANGES_REQUESTED"
						? "changes_requested"
						: "commented";

			this.memory.updateOutcome(
				task.id,
				review.state === "CHANGES_REQUESTED" ? "changes_requested" : "pending",
				{
					reviewer: review.author,
					decision,
					comments: review.body ? [review.body] : [],
					timestamp: review.submittedAt,
				},
			);

			// If changes requested, we might want to retry the task
			if (
				review.state === "CHANGES_REQUESTED" &&
				task.attempts < this.config.maxAttemptsPerTask
			) {
				console.log(
					`[orchestrator] Changes requested - will retry task ${task.id}`,
				);
				this.memory.updateTaskStatus(task.id, "pending");
			}
		}
	}

	private async handlePRComment(
		pr: GitHubPR,
		comment: PRComment,
	): Promise<void> {
		console.log(
			`[orchestrator] PR comment: #${pr.number} by ${comment.author}`,
		);

		const task = this.findTaskByPR(pr.number);
		if (task) {
			// Store the comment as feedback
			this.memory.updateOutcome(task.id, "pending", {
				reviewer: comment.author,
				decision: "commented",
				comments: [comment.body],
				timestamp: comment.createdAt,
			});
		}
	}

	// =========================================================================
	// Processing loop
	// =========================================================================

	private async processLoop(): Promise<void> {
		while (this.isRunning) {
			try {
				await this.processNextTask();
			} catch (err) {
				console.error("[orchestrator] Process loop error:", err);
			}

			// Wait before checking for more work
			await this.sleep(5000);
		}
	}

	private async processNextTask(): Promise<void> {
		// Only one task at a time for now
		if (this.processingLock) {
			return;
		}

		// Check if we're under daily budget (resets each day)
		const dailyCost = this.memory.getDailyCost();
		if (dailyCost >= this.config.dailyBudget) {
			console.log(
				`[orchestrator] Daily budget reached ($${dailyCost.toFixed(2)}/$${this.config.dailyBudget}), pausing`,
			);
			return;
		}

		// Check for in-progress tasks (shouldn't happen, but recover)
		const inProgress = this.memory.getInProgressTasks();
		if (inProgress.length > 0) {
			console.log(
				`[orchestrator] Found ${inProgress.length} stuck in-progress tasks`,
			);
			for (const task of inProgress) {
				if (task.attempts >= this.config.maxAttemptsPerTask) {
					this.memory.updateTaskStatus(task.id, "failed");
				} else {
					this.memory.updateTaskStatus(task.id, "pending");
				}
			}
			return;
		}

		// Get next pending task
		const pending = this.memory.getPendingTasks();
		if (pending.length === 0) {
			return; // Nothing to do
		}

		const task = pending[0];

		// Check if task is still eligible
		if (task.attempts >= this.config.maxAttemptsPerTask) {
			this.memory.updateTaskStatus(task.id, "failed", {
				success: false,
				error: "Max attempts exceeded",
				duration: 0,
			});
			return;
		}

		// Execute the task
		this.processingLock = true;
		try {
			console.log(`[orchestrator] Processing task: ${task.id}`);
			this.memory.updateTaskStatus(task.id, "in_progress");
			this.memory.incrementAttempts(task.id);

			const result = await this.executor.execute(task);

			if (result.success && result.prNumber) {
				this.memory.updateTaskStatus(task.id, "completed", result);
				this.memory.recordOutcome(task.id, result.prNumber);
				this.watcher.trackPR(result.prNumber);
				console.log(
					`[orchestrator] Task completed: ${task.id} -> PR #${result.prNumber}`,
				);
			} else {
				// Don't mark as failed yet if we have retries left
				if (task.attempts < this.config.maxAttemptsPerTask) {
					this.memory.updateTaskStatus(task.id, "pending", result);
					console.log(
						`[orchestrator] Task failed, will retry: ${task.id} (attempt ${task.attempts}/${this.config.maxAttemptsPerTask})`,
					);
				} else {
					this.memory.updateTaskStatus(task.id, "failed", result);
					console.log(`[orchestrator] Task failed permanently: ${task.id}`);
				}
			}
		} catch (err) {
			// Handle unexpected exceptions - don't leave task stuck in_progress
			const error = err instanceof Error ? err.message : String(err);
			console.error(`[orchestrator] Task threw exception: ${task.id}`, error);

			if (task.attempts < this.config.maxAttemptsPerTask) {
				this.memory.updateTaskStatus(task.id, "pending", {
					success: false,
					error,
					duration: 0,
				});
			} else {
				this.memory.updateTaskStatus(task.id, "failed", {
					success: false,
					error,
					duration: 0,
				});
			}
		} finally {
			this.processingLock = false;
		}
	}

	private async resumePendingWork(): Promise<void> {
		// Check for PRs we created that are still open
		const pendingOutcomes = this.memory.getPendingOutcomes();
		for (const outcome of pendingOutcomes) {
			console.log(
				`[orchestrator] Resuming tracking of PR #${outcome.prNumber}`,
			);
			this.watcher.trackPR(outcome.prNumber);
		}

		// Check for pending tasks
		const pending = this.memory.getPendingTasks();
		if (pending.length > 0) {
			console.log(`[orchestrator] Found ${pending.length} pending tasks`);
		}
	}

	private findTaskByPR(prNumber: number): Task | undefined {
		// Look through outcomes to find the task
		for (const outcome of this.memory.getPendingOutcomes()) {
			if (outcome.prNumber === prNumber) {
				return this.memory.getTask(outcome.taskId);
			}
		}
		return undefined;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// =========================================================================
	// Public API for manual triggering
	// =========================================================================

	/**
	 * Manually trigger processing of a specific issue (single-issue mode)
	 * Unlike daemon mode, this directly executes the task instead of queueing it.
	 */
	async processIssue(issueNumber: number): Promise<void> {
		console.log(`[orchestrator] Manually processing issue #${issueNumber}`);

		// Check budget even in single-issue mode
		const dailyCost = this.memory.getDailyCost();
		if (dailyCost >= this.config.dailyBudget) {
			console.log(
				`[orchestrator] Daily budget exceeded ($${dailyCost.toFixed(2)}/$${this.config.dailyBudget}), skipping`,
			);
			return;
		}

		const issue = await this.watcher.getIssue(issueNumber);

		// Triage the issue
		const triage = this.prioritizer.triage(issue);
		console.log(
			`[orchestrator] Triage result: ${triage.shouldProcess ? "ACCEPT" : "SKIP"} - ${triage.reason}`,
		);

		if (!triage.shouldProcess) {
			console.log("[orchestrator] Issue skipped by triage");
			return;
		}

		// Create and immediately execute the task (don't just queue it)
		const task = this.prioritizer.createTask(issue, triage);
		this.memory.addTask(task);

		console.log(`[orchestrator] Executing task: ${task.id}`);
		this.memory.updateTaskStatus(task.id, "in_progress");
		this.memory.incrementAttempts(task.id);

		const result = await this.executor.execute(task);

		if (result.success && result.prNumber) {
			this.memory.updateTaskStatus(task.id, "completed", result);
			this.memory.recordOutcome(task.id, result.prNumber);
			console.log(
				`[orchestrator] Task completed: ${task.id} -> PR #${result.prNumber}`,
			);
			console.log(`[orchestrator] PR URL: ${result.prUrl}`);
		} else {
			this.memory.updateTaskStatus(task.id, "failed", result);
			console.log(`[orchestrator] Task failed: ${result.error}`);
		}
	}

	/**
	 * Get current stats
	 */
	getStats() {
		return this.memory.getStats();
	}
}
