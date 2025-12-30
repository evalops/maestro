/**
 * Orchestrator - The brain of the GitHub Agent
 *
 * Coordinates:
 * - Watching for new issues/PR updates
 * - Triaging and prioritizing work
 * - Executing tasks
 * - Learning from outcomes
 */

import { GitHubAuth } from "./github/auth.js";
import { GitHubApiClient } from "./github/client.js";
import { GitHubReporter, type TaskProgress } from "./github/reporter.js";
import { MemoryStore } from "./memory/store.js";
import { IssuePrioritizer } from "./triage/prioritizer.js";
import type {
	AgentConfig,
	CheckRunEvent,
	CheckRunSummary,
	GitHubIssue,
	GitHubPR,
	IssueComment,
	PRComment,
	PRReview,
	ReviewFeedback,
	Task,
} from "./types.js";
import { GitHubWatcher } from "./watcher/github.js";
import { GitHubWebhookServer } from "./webhooks/server.js";
import { TaskExecutor } from "./worker/executor.js";

export interface OrchestratorConfig extends AgentConfig {
	githubToken?: string;
}

const COMMENT_TRIGGER_PATTERN = /(^|\s)(@composer|\/composer)\b/i;
const MAX_PROCESSED_COMMENTS = 5000;
const PROCESSED_COMMENT_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export class Orchestrator {
	private config: OrchestratorConfig;
	private memory: MemoryStore;
	private githubClient: GitHubApiClient;
	private watcher: GitHubWatcher;
	private prioritizer: IssuePrioritizer;
	private executor: TaskExecutor;
	private webhookServer?: GitHubWebhookServer;
	private reporter: GitHubReporter;
	private isRunning = false;
	private processingLock = false;
	private processedIssueComments = new Map<number, number>();

	constructor(config: OrchestratorConfig) {
		this.config = config;

		// Initialize components
		this.memory = new MemoryStore(config.memoryDir);

		const auth = new GitHubAuth({
			token: config.githubToken,
			appId: config.githubAppId,
			appPrivateKey: config.githubAppPrivateKey,
			appPrivateKeyPath: config.githubAppPrivateKeyPath,
			appInstallationId: config.githubAppInstallationId,
			apiUrl: config.githubApiUrl,
			owner: config.owner,
			repo: config.repo,
			userAgent: "evalops-github-agent",
		});
		const client = new GitHubApiClient({
			owner: config.owner,
			repo: config.repo,
			auth,
			apiUrl: config.githubApiUrl,
			userAgent: "evalops-github-agent",
		});
		this.githubClient = client;
		this.reporter = new GitHubReporter(client, config);

		const watcherConfig =
			config.webhookMode === "hybrid"
				? {
						...config,
						pollIntervalMs:
							config.webhookBackfillIntervalMs ?? config.pollIntervalMs,
					}
				: config;

		this.watcher = new GitHubWatcher(client, watcherConfig, {
			onNewIssue: (issue) => this.handleNewIssue(issue),
			onIssueComment: (issue, comment) =>
				this.handleIssueComment(issue, comment),
			onPRMerged: (pr) => this.handlePRMerged(pr),
			onPRClosed: (pr) => this.handlePRClosed(pr),
			onPRReview: (pr, review) => this.handlePRReview(pr, review),
			onPRComment: (pr, comment) => this.handlePRComment(pr, comment),
			onPRCheckRuns: (pr, runs) => this.handlePRCheckRuns(pr, runs),
		});

		this.prioritizer = new IssuePrioritizer(this.memory);

		this.executor = new TaskExecutor({
			config,
			memory: this.memory,
			onLog: (msg) => console.log(msg),
			githubClient: client,
			reporter: this.reporter,
		});

		const shouldUseWebhooks =
			config.webhookMode && config.webhookMode !== "poll";
		if (shouldUseWebhooks && !config.webhookSecret) {
			const modeLabel =
				config.webhookMode === "webhook" ? "webhook-only" : "hybrid";
			console.warn(
				`[orchestrator] Webhook ${modeLabel} mode requires a secret; falling back to polling.`,
			);
		}
		if (shouldUseWebhooks && config.webhookSecret) {
			const port = config.webhookPort ?? 8787;
			const path = config.webhookPath ?? "/github/webhooks";
			this.webhookServer = new GitHubWebhookServer({
				config,
				handlers: {
					onNewIssue: (issue) => this.handleNewIssue(issue),
					onIssueComment: (issue, comment) =>
						this.handleIssueComment(issue, comment),
					onPRMerged: (pr) => this.handlePRMerged(pr),
					onPRClosed: (pr) => this.handlePRClosed(pr),
					onPRReview: (pr, review) => this.handlePRReview(pr, review),
					onPRComment: (pr, comment) => this.handlePRComment(pr, comment),
					onCheckRunRerequested: (checkRun) =>
						this.handleCheckRunRerequested(checkRun),
				},
				secret: config.webhookSecret,
				port,
				path,
			});
		}
	}

	async start(): Promise<void> {
		console.log("[orchestrator] Starting GitHub Agent");
		console.log(
			`[orchestrator] Repository: ${this.config.owner}/${this.config.repo}`,
		);
		console.log(`[orchestrator] Working directory: ${this.config.workingDir}`);
		console.log(`[orchestrator] Memory directory: ${this.config.memoryDir}`);

		this.isRunning = true;

		// Start webhook server if configured
		if (this.webhookServer) {
			await this.webhookServer.start();
		}

		// Start watching GitHub unless webhook-only mode with an active server
		const webhookOnly =
			this.config.webhookMode === "webhook" && Boolean(this.webhookServer);
		if (!webhookOnly) {
			await this.watcher.start();
		}

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
		if (this.webhookServer) {
			await this.webhookServer.stop();
		}
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
		await this.updateTaskReport(task, {
			status: "queued",
			steps: { queued: "done" },
			updatedAt: new Date().toISOString(),
			attempt: task.attempts,
			maxAttempts: this.config.maxAttemptsPerTask,
		});
	}

	private async handleIssueComment(
		issue: GitHubIssue,
		comment: IssueComment,
	): Promise<void> {
		if (!COMMENT_TRIGGER_PATTERN.test(comment.body)) {
			return;
		}
		if (this.processedIssueComments.has(comment.id)) {
			return;
		}
		this.processedIssueComments.set(comment.id, Date.now());
		this.pruneProcessedIssueComments();
		console.log(
			`[orchestrator] Issue comment trigger on #${issue.number} by ${comment.author}`,
		);

		const triage = this.prioritizer.triage(issue);
		if (!triage.shouldProcess) {
			console.log(
				`[orchestrator] Skipping comment-triggered task: ${triage.reason}`,
			);
			return;
		}

		const task = this.prioritizer.createTask(issue, triage);
		task.description = `${task.description}\n\nTrigger comment by ${comment.author}:\n${comment.body}`;
		this.memory.addTask(task);

		console.log(
			`[orchestrator] Task created from comment: ${task.id} (priority: ${task.priority})`,
		);
		await this.updateTaskReport(task, {
			status: "queued",
			steps: { queued: "done" },
			updatedAt: new Date().toISOString(),
			attempt: task.attempts,
			maxAttempts: this.config.maxAttemptsPerTask,
		});
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

			const existingStatus = this.memory.getOutcome(task.id)?.status;
			const nextStatus =
				review.state === "CHANGES_REQUESTED"
					? "changes_requested"
					: existingStatus === "changes_requested"
						? "changes_requested"
						: "pending";
			await this.captureReviewFeedback(
				task,
				pr.number,
				nextStatus,
				{
					reviewer: review.author,
					decision,
					comments: review.body ? [review.body] : [],
					timestamp: review.submittedAt,
				},
				[],
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
			const existingStatus = this.memory.getOutcome(task.id)?.status;
			const nextStatus =
				existingStatus === "changes_requested"
					? "changes_requested"
					: "pending";
			await this.captureReviewFeedback(
				task,
				pr.number,
				nextStatus,
				{
					reviewer: comment.author,
					decision: "commented",
					comments: [comment.body],
					timestamp: comment.createdAt,
				},
				comment.path ? [comment.path] : [],
			);
		}
	}

	private async handlePRCheckRuns(
		pr: GitHubPR,
		checkRuns: CheckRunSummary[],
	): Promise<void> {
		if (checkRuns.length === 0) return;
		console.log(`[orchestrator] PR #${pr.number} check run failures detected`);

		const task = this.findTaskByPR(pr.number);
		if (!task) return;

		const formatted = checkRuns.map((run) => {
			const conclusion = run.conclusion ?? "unknown";
			const details = run.detailsUrl ? ` Details: ${run.detailsUrl}` : "";
			return `Check run "${run.name}" concluded ${conclusion}.${details}`;
		});

		const outcome = this.memory.getOutcome(task.id);
		const existingComments = new Set(
			outcome?.reviewFeedback.flatMap((feedback) => feedback.comments) ?? [],
		);
		const newComments = formatted.filter(
			(comment) => !existingComments.has(comment),
		);
		if (newComments.length === 0) {
			return;
		}

		await this.captureReviewFeedback(
			task,
			pr.number,
			"changes_requested",
			{
				reviewer: "github-checks",
				decision: "changes_requested",
				comments: newComments,
				timestamp: new Date().toISOString(),
			},
			[],
		);

		if (
			task.attempts < this.config.maxAttemptsPerTask &&
			task.status !== "in_progress"
		) {
			console.log(
				`[orchestrator] Check runs failed - retrying task ${task.id}`,
			);
			this.memory.updateTaskStatus(task.id, "pending");
		}
	}

	private async handleCheckRunRerequested(
		checkRun: CheckRunEvent,
	): Promise<void> {
		if (checkRun.name !== "Composer Agent") {
			return;
		}
		console.log(
			`[orchestrator] Check run re-requested: ${checkRun.id} (${checkRun.headSha})`,
		);

		const taskByCheckRun = this.memory.findTaskByCheckRunId(checkRun.id);
		if (!taskByCheckRun && checkRun.pullRequests.length > 1) {
			console.warn(
				`[orchestrator] Multiple PRs associated with check run ${checkRun.id}; skipping ambiguous rerun`,
			);
			return;
		}
		const task = taskByCheckRun ?? this.findTaskByPRs(checkRun.pullRequests);
		if (!task) {
			console.warn(`[orchestrator] No task found for check run ${checkRun.id}`);
			return;
		}
		if (task.checkRunId && task.checkRunId !== checkRun.id) {
			console.warn(
				`[orchestrator] Check run ${checkRun.id} does not match task ${task.id} check run ${task.checkRunId}`,
			);
			return;
		}
		if (!task.checkRunId) {
			this.memory.updateTask(task.id, { checkRunId: checkRun.id });
			task.checkRunId = checkRun.id;
		}
		if (task.status === "in_progress") {
			console.log(
				`[orchestrator] Task already in progress for check run ${checkRun.id}`,
			);
			await this.publishCheckRunStatus(checkRun, task, "in_progress").catch(
				(err) => {
					console.warn(
						`[orchestrator] Failed to update check run ${checkRun.id} to in_progress: ${err instanceof Error ? err.message : err}`,
					);
				},
			);
			return;
		}
		const baseAttempt = Math.max(task.attempts, task.queuedAttempt ?? 0);
		const nextAttempt = baseAttempt + 1;
		if (nextAttempt > this.config.maxAttemptsPerTask) {
			console.warn(
				`[orchestrator] Max attempts reached for task ${task.id}; cannot rerun`,
			);
			return;
		}

		this.memory.updateTaskStatus(task.id, "pending");
		this.memory.updateTask(task.id, { queuedAttempt: nextAttempt });
		task.queuedAttempt = nextAttempt;
		await this.publishCheckRunStatus(checkRun, task, "queued").catch((err) => {
			console.warn(
				`[orchestrator] Failed to update check run ${checkRun.id} to queued: ${err instanceof Error ? err.message : err}`,
			);
		});
		await this.updateTaskReport(task, {
			status: "queued",
			steps: { queued: "done" },
			updatedAt: new Date().toISOString(),
			attempt: nextAttempt,
			maxAttempts: this.config.maxAttemptsPerTask,
		});
		console.log(`[orchestrator] Re-queued task ${task.id}`);
	}

	private async publishCheckRunStatus(
		checkRun: CheckRunEvent,
		task: Task,
		status: "queued" | "in_progress",
	): Promise<void> {
		const supportsCheckRuns = await this.githubClient.supportsCheckRuns();
		if (supportsCheckRuns) {
			await this.githubClient.updateCheckRun({
				id: checkRun.id,
				status,
				conclusion: null,
			});
			return;
		}

		await this.githubClient.createCommitStatus({
			sha: checkRun.headSha,
			state: "pending",
			description:
				status === "in_progress"
					? "Composer Agent rerun in progress"
					: "Composer Agent queued for rerun",
			context: "Composer Agent",
			targetUrl: task.result?.prUrl,
		});
	}

	private async captureReviewFeedback(
		task: Task,
		prNumber: number,
		status: "pending" | "changes_requested" | "merged" | "closed",
		feedback: ReviewFeedback,
		seedPaths: string[],
	): Promise<void> {
		const comments = new Set(feedback.comments);
		const filePaths = new Set<string>(seedPaths);

		const shouldFetchThreads =
			status === "changes_requested" || seedPaths.length === 0;
		if (this.githubClient && shouldFetchThreads) {
			try {
				const threads =
					await this.githubClient.listPullRequestReviewThreads(prNumber);
				for (const thread of threads) {
					if (!thread.path) continue;
					filePaths.add(thread.path);
					for (const comment of thread.comments) {
						if (comment.body) {
							comments.add(comment.body);
						}
					}
				}
			} catch (err) {
				console.warn(
					`[orchestrator] Failed to fetch review threads for PR #${prNumber}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		this.memory.updateOutcome(task.id, status, {
			...feedback,
			comments: Array.from(comments),
		});

		if (status === "changes_requested") {
			for (const path of filePaths) {
				this.memory.recordFileFailure(path);
			}
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
		let failureRecorded = false;
		try {
			console.log(`[orchestrator] Processing task: ${task.id}`);
			this.memory.updateTaskStatus(task.id, "in_progress");
			if (task.queuedAttempt && task.queuedAttempt > task.attempts) {
				this.memory.updateTask(task.id, {
					attempts: task.queuedAttempt,
					queuedAttempt: undefined,
				});
				task.attempts = task.queuedAttempt;
				task.queuedAttempt = undefined;
			} else {
				this.memory.incrementAttempts(task.id);
			}
			await this.updateTaskReport(task, {
				status: "in_progress",
				steps: { queued: "done" },
				updatedAt: new Date().toISOString(),
				attempt: task.attempts,
				maxAttempts: this.config.maxAttemptsPerTask,
			});

			const result = await this.executor.execute(task);

			if (result.success && result.prNumber) {
				this.memory.updateTaskStatus(task.id, "completed", result);
				this.memory.recordOutcome(task.id, result.prNumber);
				this.watcher.trackPR(result.prNumber);
				await this.updateTaskReport(task, {
					status: "completed",
					steps: this.buildCompletionSteps(),
					prUrl: result.prUrl,
					updatedAt: new Date().toISOString(),
					attempt: task.attempts,
					maxAttempts: this.config.maxAttemptsPerTask,
					cost: result.cost,
					tokensUsed: result.tokensUsed,
					durationMs: result.duration,
				});
				console.log(
					`[orchestrator] Task completed: ${task.id} -> PR #${result.prNumber}`,
				);
			} else {
				if (result.error) {
					this.memory.recordTaskFailure(result.error);
					failureRecorded = true;
				}
				// Don't mark as failed yet if we have retries left
				if (task.attempts < this.config.maxAttemptsPerTask) {
					this.memory.updateTaskStatus(task.id, "pending", result);
					await this.updateTaskReport(task, {
						status: "queued",
						steps: { queued: "done" },
						error: result.error,
						updatedAt: new Date().toISOString(),
						attempt: task.attempts,
						maxAttempts: this.config.maxAttemptsPerTask,
					});
					console.log(
						`[orchestrator] Task failed, will retry: ${task.id} (attempt ${task.attempts}/${this.config.maxAttemptsPerTask})`,
					);
				} else {
					this.memory.updateTaskStatus(task.id, "failed", result);
					await this.updateTaskReport(task, {
						status: "failed",
						steps: { queued: "done" },
						error: result.error,
						updatedAt: new Date().toISOString(),
						attempt: task.attempts,
						maxAttempts: this.config.maxAttemptsPerTask,
					});
					console.log(`[orchestrator] Task failed permanently: ${task.id}`);
				}
			}
		} catch (err) {
			// Handle unexpected exceptions - don't leave task stuck in_progress
			const error = err instanceof Error ? err.message : String(err);
			console.error(`[orchestrator] Task threw exception: ${task.id}`, error);
			if (!failureRecorded) {
				this.memory.recordTaskFailure(error);
			}

			if (task.attempts < this.config.maxAttemptsPerTask) {
				this.memory.updateTaskStatus(task.id, "pending", {
					success: false,
					error,
					duration: 0,
				});
				await this.updateTaskReport(task, {
					status: "queued",
					steps: { queued: "done" },
					error,
					updatedAt: new Date().toISOString(),
					attempt: task.attempts,
					maxAttempts: this.config.maxAttemptsPerTask,
				});
			} else {
				this.memory.updateTaskStatus(task.id, "failed", {
					success: false,
					error,
					duration: 0,
				});
				await this.updateTaskReport(task, {
					status: "failed",
					steps: { queued: "done" },
					error,
					updatedAt: new Date().toISOString(),
					attempt: task.attempts,
					maxAttempts: this.config.maxAttemptsPerTask,
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

	private findTaskByPRs(prNumbers: number[]): Task | undefined {
		for (const prNumber of prNumbers) {
			const task = this.findTaskByPR(prNumber);
			if (task) return task;
		}
		return undefined;
	}

	private async updateTaskReport(
		task: Task,
		progress: TaskProgress,
	): Promise<void> {
		if (!task.sourceIssue) return;
		try {
			const commentId = await this.reporter.upsertIssueComment(task, progress);
			if (commentId && commentId !== task.reportCommentId) {
				this.memory.updateTask(task.id, { reportCommentId: commentId });
				task.reportCommentId = commentId;
			}
		} catch (err) {
			console.warn(
				`[orchestrator] Failed to update issue comment for task ${task.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	private buildCompletionSteps(): TaskProgress["steps"] {
		const steps: TaskProgress["steps"] = {
			queued: "done",
			branch: "done",
			composer: "done",
			pr: "done",
		};
		steps.typecheck = this.config.requireTypeCheck ? "done" : "skipped";
		steps.lint = this.config.requireLint ? "done" : "skipped";
		steps.tests = this.config.requireTests ? "done" : "skipped";
		steps.selfReview = this.config.selfReview ? "done" : "skipped";
		return steps;
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
		await this.updateTaskReport(task, {
			status: "queued",
			steps: { queued: "done" },
			updatedAt: new Date().toISOString(),
			attempt: task.attempts,
			maxAttempts: this.config.maxAttemptsPerTask,
		});

		console.log(`[orchestrator] Executing task: ${task.id}`);
		this.memory.updateTaskStatus(task.id, "in_progress");
		this.memory.incrementAttempts(task.id);
		await this.updateTaskReport(task, {
			status: "in_progress",
			steps: { queued: "done" },
			updatedAt: new Date().toISOString(),
			attempt: task.attempts,
			maxAttempts: this.config.maxAttemptsPerTask,
		});

		try {
			const result = await this.executor.execute(task);

			if (result.success && result.prNumber) {
				this.memory.updateTaskStatus(task.id, "completed", result);
				this.memory.recordOutcome(task.id, result.prNumber);
				await this.updateTaskReport(task, {
					status: "completed",
					steps: this.buildCompletionSteps(),
					prUrl: result.prUrl,
					updatedAt: new Date().toISOString(),
					attempt: task.attempts,
					maxAttempts: this.config.maxAttemptsPerTask,
					cost: result.cost,
					tokensUsed: result.tokensUsed,
					durationMs: result.duration,
				});
				console.log(
					`[orchestrator] Task completed: ${task.id} -> PR #${result.prNumber}`,
				);
				console.log(`[orchestrator] PR URL: ${result.prUrl}`);
			} else {
				// Match processNextTask behavior: allow retries if attempts remain
				if (task.attempts < this.config.maxAttemptsPerTask) {
					this.memory.updateTaskStatus(task.id, "pending", result);
					await this.updateTaskReport(task, {
						status: "queued",
						steps: { queued: "done" },
						error: result.error,
						updatedAt: new Date().toISOString(),
						attempt: task.attempts,
						maxAttempts: this.config.maxAttemptsPerTask,
					});
					console.log(
						`[orchestrator] Task failed, will retry on next run (attempt ${task.attempts}/${this.config.maxAttemptsPerTask}): ${result.error}`,
					);
				} else {
					this.memory.updateTaskStatus(task.id, "failed", result);
					await this.updateTaskReport(task, {
						status: "failed",
						steps: { queued: "done" },
						error: result.error,
						updatedAt: new Date().toISOString(),
						attempt: task.attempts,
						maxAttempts: this.config.maxAttemptsPerTask,
					});
					console.log(
						`[orchestrator] Task failed permanently: ${result.error}`,
					);
				}
			}
		} catch (err) {
			// Handle unexpected exceptions - don't leave task stuck in_progress
			const error = err instanceof Error ? err.message : String(err);
			console.error(`[orchestrator] Task threw exception: ${task.id}`, error);

			// Match processNextTask behavior: allow retries if attempts remain
			if (task.attempts < this.config.maxAttemptsPerTask) {
				this.memory.updateTaskStatus(task.id, "pending", {
					success: false,
					error,
					duration: 0,
				});
				await this.updateTaskReport(task, {
					status: "queued",
					steps: { queued: "done" },
					error,
					updatedAt: new Date().toISOString(),
					attempt: task.attempts,
					maxAttempts: this.config.maxAttemptsPerTask,
				});
				console.log(
					`[orchestrator] Task will retry on next run (attempt ${task.attempts}/${this.config.maxAttemptsPerTask})`,
				);
			} else {
				this.memory.updateTaskStatus(task.id, "failed", {
					success: false,
					error,
					duration: 0,
				});
				await this.updateTaskReport(task, {
					status: "failed",
					steps: { queued: "done" },
					error,
					updatedAt: new Date().toISOString(),
					attempt: task.attempts,
					maxAttempts: this.config.maxAttemptsPerTask,
				});
			}
		}
	}

	private pruneProcessedIssueComments(): void {
		const now = Date.now();

		for (const [id, timestamp] of this.processedIssueComments) {
			if (now - timestamp <= PROCESSED_COMMENT_TTL_MS) {
				break;
			}
			this.processedIssueComments.delete(id);
		}

		while (this.processedIssueComments.size > MAX_PROCESSED_COMMENTS) {
			const oldest = this.processedIssueComments.keys().next().value as
				| number
				| undefined;
			if (oldest === undefined) {
				break;
			}
			this.processedIssueComments.delete(oldest);
		}
	}

	/**
	 * Get current stats
	 */
	getStats() {
		return this.memory.getStats();
	}
}
