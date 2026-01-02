/**
 * Task Executor - Runs Composer to implement tasks
 *
 * Flow:
 * 1. Create feature branch
 * 2. Run composer exec with the task
 * 3. Run quality gates (tests, lint, typecheck)
 * 4. Optional: Self-review pass
 * 5. Create PR if everything passes
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GitHubApiClient } from "../github/client.js";
import type { GitHubReporter, TaskProgress } from "../github/reporter.js";
import type { MemoryStore } from "../memory/store.js";
import type { AgentConfig, Task, TaskResult } from "../types.js";

export interface ExecutorOptions {
	config: AgentConfig;
	memory: MemoryStore;
	onLog?: (message: string) => void;
	githubClient?: GitHubApiClient;
	reporter?: GitHubReporter;
}

export class TaskExecutor {
	private config: AgentConfig;
	private memory: MemoryStore;
	private log: (message: string) => void;
	private githubClient?: GitHubApiClient;
	private reporter?: GitHubReporter;

	constructor(options: ExecutorOptions) {
		this.config = options.config;
		this.memory = options.memory;
		this.log = options.onLog || console.log;
		this.githubClient = options.githubClient;
		this.reporter = options.reporter;
	}

	/**
	 * Execute a task and return the result
	 */
	async execute(task: Task): Promise<TaskResult> {
		const startTime = Date.now();
		const progress = this.buildInitialProgress(task, startTime);
		await this.reportProgress(task, progress);
		const branchName = this.generateBranchName(task);

		try {
			// Ensure working directory exists
			mkdirSync(this.config.workingDir, { recursive: true });

			// Generate branch name
			progress.branch = branchName;
			this.log(`[executor] Starting task ${task.id}`);
			this.log(`[executor] Branch: ${branchName}`);

			// Step 1: Create feature branch
			await this.runStep(task, progress, "branch", async () => {
				await this.createBranch(branchName);
			});

			// Step 2: Build the prompt
			const prompt = this.buildPrompt(task);

			// Step 3: Run composer exec
			let composerResult: Awaited<ReturnType<typeof this.runComposer>> | null =
				null;
			await this.runStep(task, progress, "composer", async () => {
				this.log("[executor] Running composer...");
				composerResult = await this.runComposer(prompt);

				if (!composerResult.success) {
					throw new Error(`Composer failed: ${composerResult.error}`);
				}
			});
			if (!composerResult) {
				throw new Error("Composer did not return a result");
			}
			progress.tokensUsed = composerResult.tokensUsed;
			progress.cost = composerResult.cost;

			// Step 4: Run quality gates
			this.log("[executor] Running quality gates...");
			await this.runQualityGates(task, progress);

			// Step 5: Optional self-review
			if (this.config.selfReview) {
				await this.runStep(task, progress, "selfReview", async () => {
					this.log("[executor] Running self-review...");
					await this.runSelfReview();
				});
			}

			// Step 6: Create PR
			let pr: { number: number; url: string } | null = null;
			await this.runStep(task, progress, "pr", async () => {
				this.log("[executor] Creating PR...");
				pr = await this.createPR(task, progress, branchName);
			});
			if (!pr) {
				throw new Error("PR creation did not return a result");
			}
			progress.prUrl = pr.url;

			await this.applyPrMetadata(pr.number);
			await this.applyMergePolicy(pr.number, branchName);
			await this.publishCheckRun(task, progress, branchName, pr);

			progress.status = "completed";
			progress.durationMs = Date.now() - startTime;
			await this.reportProgress(task, progress);

			return {
				success: true,
				prNumber: pr.number,
				prUrl: pr.url,
				duration: Date.now() - startTime,
				tokensUsed: composerResult.tokensUsed,
				cost: composerResult.cost,
			};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.log(`[executor] Task failed: ${error}`);
			progress.status = "failed";
			progress.error = error;
			progress.durationMs = Date.now() - startTime;
			await this.reportProgress(task, progress);
			await this.publishFailureCheckRun(task, progress, branchName);

			// Clean up: switch back to base branch
			await this.runCommand("git", ["checkout", this.config.baseBranch]).catch(
				() => {},
			);

			return {
				success: false,
				error,
				duration: Date.now() - startTime,
			};
		}
	}

	private generateBranchName(task: Task): string {
		const prefix = task.type === "issue" ? "fix" : "feature";
		const slug = task.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, 30)
			.replace(/-+$/, "");
		const id = task.sourceIssue || Date.now().toString(36);
		return `${prefix}/${slug}-${id}`;
	}

	private async createBranch(branchName: string): Promise<void> {
		// Ensure we're on the base branch and up to date
		await this.runCommand("git", ["checkout", this.config.baseBranch]);
		await this.runCommand("git", ["pull", "origin", this.config.baseBranch]);

		// Create and checkout new branch (-B forces creation even if exists, for retries)
		await this.runCommand("git", ["checkout", "-B", branchName]);
	}

	private buildPrompt(task: Task): string {
		const memoryContext = this.memory.getContextForPrompt();

		const lines: string[] = [
			"You are working on the Composer codebase (a coding agent that helps developers).",
			"",
			task.description,
			"",
			"## Requirements:",
			"1. Implement the requested changes",
			"2. Follow the existing code style and patterns",
			"3. Add tests for any new functionality",
			"4. Run tests and fix any failures before completing",
			"5. Run the linter and fix any issues",
			"",
		];

		if (memoryContext) {
			lines.push("## Context from previous work:");
			lines.push(memoryContext);
			lines.push("");
		}

		lines.push(
			"## When you're done:",
			"Commit your changes with a clear commit message that references the issue.",
			`Use the format: [composer] <description> (fixes #${task.sourceIssue || "N/A"})`,
			"",
			"Do NOT create the PR - just commit to the current branch.",
		);

		return lines.join("\n");
	}

	private async runComposer(prompt: string): Promise<{
		success: boolean;
		error?: string;
		tokensUsed?: number;
		cost?: number;
	}> {
		return new Promise((resolve) => {
			const args = ["exec", "--full-auto", "--json", prompt];
			const composerBin = process.env.COMPOSER_BIN || "composer";

			const env = { ...process.env };
			if (this.config.maxTokensPerTask && !env.COMPOSER_MAX_OUTPUT_TOKENS) {
				env.COMPOSER_MAX_OUTPUT_TOKENS = String(this.config.maxTokensPerTask);
			}

			const proc = spawn(composerBin, args, {
				cwd: this.config.workingDir,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let tokensUsed = 0;
			let cost = 0;
			const maxStdoutSize = 2 * 1024 * 1024;
			let stdoutTruncated = false;
			let jsonBuffer = "";
			let jsonError: string | null = null;

			const handleJsonLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as {
						type?: string;
						subtype?: string;
						data?: {
							usage?: {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								cost?: { total?: number };
							};
						};
						message?: string;
					};
					if (event.type === "item" && event.subtype === "message_complete") {
						const usage = event.data?.usage;
						if (usage) {
							tokensUsed +=
								(usage.input ?? 0) +
								(usage.output ?? 0) +
								(usage.cacheRead ?? 0) +
								(usage.cacheWrite ?? 0);
							if (typeof usage.cost?.total === "number") {
								cost += usage.cost.total;
							}
						}
					}
					if (event.type === "error" && event.message) {
						jsonError = event.message;
					}
				} catch {
					// Not JSONL we understand - ignore
				}
			};

			const handleJsonChunk = (chunk: string) => {
				jsonBuffer += chunk;
				let newlineIndex = jsonBuffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = jsonBuffer.slice(0, newlineIndex);
					jsonBuffer = jsonBuffer.slice(newlineIndex + 1);
					handleJsonLine(line);
					newlineIndex = jsonBuffer.indexOf("\n");
				}
			};

			proc.stdout.on("data", (data) => {
				const chunk = data.toString();
				if (stdout.length < maxStdoutSize) {
					stdout += chunk;
					if (stdout.length > maxStdoutSize) {
						stdoutTruncated = true;
						stdout = stdout.slice(0, maxStdoutSize);
					}
				} else {
					stdoutTruncated = true;
				}
				handleJsonChunk(chunk);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (jsonBuffer.trim()) {
					handleJsonLine(jsonBuffer);
				}
				if (stdoutTruncated) {
					stdout = `${stdout}\n... (output truncated at 2MB)`;
				}
				if (code === 0) {
					resolve({ success: true, tokensUsed, cost });
				} else {
					resolve({
						success: false,
						error: stderr || jsonError || stdout || `Exit code ${code}`,
						tokensUsed,
						cost,
					});
				}
			});

			proc.on("error", (err) => {
				resolve({ success: false, error: err.message });
			});
		});
	}

	private async runQualityGates(
		task: Task,
		progress: TaskProgress,
	): Promise<void> {
		if (this.config.requireTypeCheck) {
			await this.runStep(task, progress, "typecheck", async () => {
				this.log("[executor] Type checking...");
				await this.runCommand("npx", [
					"nx",
					"run",
					"composer:build:all",
					"--skip-nx-cache",
				]);
			});
		} else {
			progress.steps.typecheck = "skipped";
			await this.reportProgress(task, progress);
		}

		if (this.config.requireLint) {
			await this.runStep(task, progress, "lint", async () => {
				this.log("[executor] Linting...");
				await this.runCommand("bun", ["run", "bun:lint"]);
			});
		} else {
			progress.steps.lint = "skipped";
			await this.reportProgress(task, progress);
		}

		if (this.config.requireTests) {
			await this.runStep(task, progress, "tests", async () => {
				this.log("[executor] Running tests...");
				await this.runCommand("npx", [
					"nx",
					"run",
					"composer:test",
					"--skip-nx-cache",
				]);
			});
		} else {
			progress.steps.tests = "skipped";
			await this.reportProgress(task, progress);
		}
	}

	private async runSelfReview(): Promise<void> {
		// Get the diff
		const diff = await this.runCommand("git", ["diff", this.config.baseBranch]);

		if (!diff.trim()) {
			throw new Error("No changes to review");
		}

		// Run composer to review the diff
		const reviewPrompt = `
You are reviewing a diff for a PR. Check for:
1. Bugs or logic errors
2. Missing test coverage
3. Code style issues
4. Security concerns
5. Performance issues

If you find issues, fix them and commit the fixes with a message like:
"chore: address self-review feedback"

If everything looks good, just say "LGTM" (no commit needed).

Here's the diff:

${diff}
`;

		const result = await this.runComposer(reviewPrompt);
		if (!result.success) {
			throw new Error(`Self-review failed: ${result.error}`);
		}
	}

	private async createPR(
		task: Task,
		progress: TaskProgress,
		branchName: string,
	): Promise<{ number: number; url: string }> {
		// Push the branch
		await this.runCommand("git", ["push", "-u", "origin", branchName]);
		await this.ensureCheckRun(task, progress, branchName);

		// Sanitize title: remove special chars, limit length (GitHub max is 256)
		const sanitizedTaskTitle = task.title
			.replace(/[^\w\s\-.,!?()]/g, "") // Remove special chars except common punctuation
			.slice(0, 200) // Leave room for prefix and suffix
			.trim();

		const title = task.sourceIssue
			? `[composer] ${sanitizedTaskTitle} (fixes #${task.sourceIssue})`
			: `[composer] ${sanitizedTaskTitle}`;

		const body = this.buildPRBody(task);

		if (this.githubClient) {
			const existing = await this.findExistingPr(branchName);
			if (existing) {
				this.log(
					`[executor] Reusing existing PR #${existing.number} for ${branchName}`,
				);
				return existing;
			}
			try {
				return await this.githubClient.createPullRequest({
					title,
					head: branchName,
					base: this.config.baseBranch,
					body,
					draft: this.config.draftPullRequests,
				});
			} catch (err) {
				const existingAfterError = await this.findExistingPr(branchName);
				if (existingAfterError) {
					this.log(
						`[executor] Found existing PR #${existingAfterError.number} after create failure`,
					);
					return existingAfterError;
				}
				this.log(
					`[executor] GitHub API PR creation failed, falling back to gh: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		return this.createPrViaGh(title, body, branchName);
	}

	private async createPrViaGh(
		title: string,
		body: string,
		branchName: string,
	): Promise<{ number: number; url: string }> {
		const existing = await this.findExistingPrViaGh(branchName);
		if (existing) {
			this.log(
				`[executor] Reusing existing PR #${existing.number} for ${branchName}`,
			);
			return existing;
		}
		const draftFlag = this.config.draftPullRequests ? ["--draft"] : [];
		const output = await this.runCommand("gh", [
			"pr",
			"create",
			"--title",
			title,
			"--body",
			body,
			"--base",
			this.config.baseBranch,
			...draftFlag,
		]);

		// Parse PR URL from output
		const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
		if (!urlMatch) {
			throw new Error("Could not parse PR URL from gh output");
		}

		const prUrl = urlMatch[0];
		const prNumber = Number.parseInt(urlMatch[1], 10);

		if (Number.isNaN(prNumber) || prNumber <= 0) {
			throw new Error(`Invalid PR number parsed from URL: ${prUrl}`);
		}

		return { number: prNumber, url: prUrl };
	}

	private async findExistingPr(
		branchName: string,
	): Promise<{ number: number; url: string } | null> {
		if (!this.githubClient) return null;
		try {
			return await this.githubClient.findOpenPullRequestByBranch(branchName);
		} catch (err) {
			this.log(
				`[executor] Failed to lookup existing PR: ${err instanceof Error ? err.message : err}`,
			);
			return null;
		}
	}

	private async findExistingPrViaGh(
		branchName: string,
	): Promise<{ number: number; url: string } | null> {
		try {
			const output = await this.runCommand("gh", [
				"pr",
				"list",
				"--state",
				"open",
				"--json",
				"number,url",
				"--head",
				branchName,
				"--limit",
				"1",
			]);
			const data = JSON.parse(output) as { number?: number; url?: string }[];
			const pr = data?.[0];
			if (!pr?.number || !pr?.url) {
				return null;
			}
			return { number: pr.number, url: pr.url };
		} catch {
			return null;
		}
	}

	private async applyPrMetadata(prNumber: number): Promise<void> {
		if (!this.githubClient) return;
		const labels = this.config.prLabels?.filter(Boolean) ?? [];
		const reviewers = this.config.requestReviewers?.filter(Boolean) ?? [];
		const teamReviewers =
			this.config.requestTeamReviewers?.filter(Boolean) ?? [];

		if (labels.length) {
			try {
				await this.githubClient.addIssueLabels(prNumber, labels);
			} catch (err) {
				this.log(
					`[executor] Failed to apply PR labels: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		if (reviewers.length || teamReviewers.length) {
			try {
				await this.githubClient.requestReviewers({
					pullNumber: prNumber,
					reviewers,
					teamReviewers,
				});
			} catch (err) {
				this.log(
					`[executor] Failed to request reviewers: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
	}

	private async applyMergePolicy(
		prNumber: number,
		branchName: string,
	): Promise<void> {
		if (!this.githubClient) return;
		const wantsMergeQueue = Boolean(this.config.mergeQueue);
		const wantsAutoMerge = Boolean(this.config.autoMerge);
		if (!wantsMergeQueue && !wantsAutoMerge) {
			return;
		}

		try {
			const pr = await this.githubClient.getPullRequest(prNumber);
			const nodeId = pr.nodeId;
			if (!nodeId) {
				this.log(
					`[executor] Unable to resolve pull request node id for #${prNumber}; skipping merge policy`,
				);
				return;
			}
			const expectedHeadOid =
				pr.headSha || (await this.githubClient.getBranchHeadSha(branchName));

			if (wantsMergeQueue) {
				try {
					await this.githubClient.enqueuePullRequest({
						pullRequestId: nodeId,
						expectedHeadOid,
						jump: this.config.mergeQueueJump ?? false,
					});
					this.log(`[executor] Enqueued PR #${prNumber} into merge queue`);
					return;
				} catch (err) {
					this.log(
						`[executor] Merge queue enqueue failed: ${err instanceof Error ? err.message : err}`,
					);
					if (!wantsAutoMerge) {
						return;
					}
				}
			}

			if (wantsAutoMerge) {
				await this.githubClient.enableAutoMerge({
					pullRequestId: nodeId,
					mergeMethod: this.config.autoMergeMethod ?? "squash",
					commitHeadline: this.config.autoMergeCommitHeadline,
					commitBody: this.config.autoMergeCommitBody,
					expectedHeadOid,
				});
				this.log(`[executor] Auto-merge enabled for PR #${prNumber}`);
			}
		} catch (err) {
			this.log(
				`[executor] Failed to apply merge policy: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private buildPRBody(task: Task): string {
		const lines: string[] = [
			"## Summary",
			"",
			task.description.split("\n").slice(0, 10).join("\n"),
			"",
		];

		if (task.sourceIssue) {
			lines.push(`Fixes #${task.sourceIssue}`);
			lines.push("");
		}

		lines.push(
			"## Test Plan",
			"",
			"- [ ] Tests pass locally",
			"- [ ] Lint passes",
			"- [ ] Type check passes",
			"- [ ] Manual verification (if applicable)",
			"",
			"---",
			"",
			"_This PR was generated autonomously by the GitHub Agent (Composer building Composer)._",
		);

		return lines.join("\n");
	}

	private buildInitialProgress(task: Task, startTime: number): TaskProgress {
		const steps: TaskProgress["steps"] = {
			queued: "done",
			branch: "pending",
			composer: "pending",
			pr: "pending",
		};
		steps.typecheck = this.config.requireTypeCheck ? "pending" : "skipped";
		steps.lint = this.config.requireLint ? "pending" : "skipped";
		steps.tests = this.config.requireTests ? "pending" : "skipped";
		steps.selfReview = this.config.selfReview ? "pending" : "skipped";

		return {
			status: "in_progress",
			steps,
			attempt: task.attempts,
			maxAttempts: this.config.maxAttemptsPerTask,
			startedAt: new Date(startTime).toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}

	private async reportProgress(
		task: Task,
		progress: TaskProgress,
	): Promise<void> {
		progress.updatedAt = new Date().toISOString();
		if (this.reporter && task.sourceIssue) {
			try {
				const commentId = await this.reporter.upsertIssueComment(
					task,
					progress,
				);
				if (commentId && commentId !== task.reportCommentId) {
					this.memory.updateTask(task.id, { reportCommentId: commentId });
					task.reportCommentId = commentId;
				}
			} catch (err) {
				this.log(
					`[executor] Failed to update issue comment: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
		await this.updateCheckRunProgress(task, progress);
	}

	private async runStep(
		task: Task,
		progress: TaskProgress,
		step: keyof TaskProgress["steps"],
		action: () => Promise<void>,
	): Promise<void> {
		progress.steps[step] = "running";
		await this.reportProgress(task, progress);
		try {
			await action();
			progress.steps[step] = "done";
			await this.reportProgress(task, progress);
		} catch (err) {
			progress.steps[step] = "failed";
			progress.status = "failed";
			progress.error = err instanceof Error ? err.message : String(err);
			await this.reportProgress(task, progress);
			throw err;
		}
	}

	private async ensureCheckRun(
		task: Task,
		progress: TaskProgress,
		branchName: string,
	): Promise<void> {
		if (!this.githubClient || task.checkRunId) return;
		try {
			const supportsCheckRuns = await this.githubClient.supportsCheckRuns();
			if (!supportsCheckRuns) return;
			const headSha = await this.githubClient.getBranchHeadSha(branchName);
			const summary = this.buildProgressSummary(task, progress);
			const checkRun = await this.githubClient.createCheckRun({
				name: "Composer Agent",
				headSha,
				status: "in_progress",
				summary,
			});
			this.memory.updateTask(task.id, { checkRunId: checkRun.id });
			task.checkRunId = checkRun.id;
		} catch (err) {
			this.log(
				`[executor] Failed to initialize check run: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private async updateCheckRunProgress(
		task: Task,
		progress: TaskProgress,
	): Promise<void> {
		if (!this.githubClient || !task.checkRunId) return;
		if (progress.status !== "in_progress") return;
		try {
			const summary = this.buildProgressSummary(
				task,
				progress,
				progress.prUrl ?? task.result?.prUrl,
			);
			await this.githubClient.updateCheckRun({
				id: task.checkRunId,
				status: "in_progress",
				conclusion: null,
				detailsUrl: progress.prUrl ?? task.result?.prUrl,
				summary,
			});
		} catch (err) {
			this.log(
				`[executor] Failed to update check run progress: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private async publishCheckRun(
		task: Task,
		progress: TaskProgress,
		branchName: string,
		pr: { number: number; url: string },
	): Promise<void> {
		if (!this.githubClient) return;
		try {
			const headSha = await this.githubClient.getBranchHeadSha(branchName);
			const summary = this.buildCheckRunSummary(task, progress, pr);
			const text = progress.error ? `Error: ${progress.error}` : undefined;
			const conclusion =
				progress.status === "failed" || progress.error ? "failure" : "success";
			const supportsCheckRuns = await this.githubClient.supportsCheckRuns();
			if (supportsCheckRuns) {
				try {
					if (task.checkRunId) {
						await this.githubClient.updateCheckRun({
							id: task.checkRunId,
							status: "completed",
							conclusion,
							detailsUrl: pr.url,
							summary,
							text,
						});
					} else {
						const checkRun = await this.githubClient.createCheckRun({
							name: "Composer Agent",
							headSha,
							status: "completed",
							conclusion,
							detailsUrl: pr.url,
							summary,
							text,
						});
						this.memory.updateTask(task.id, { checkRunId: checkRun.id });
						task.checkRunId = checkRun.id;
					}
					return;
				} catch (err) {
					this.log(
						`[executor] Check run creation failed, falling back to commit status: ${err instanceof Error ? err.message : err}`,
					);
				}
			}

			try {
				await this.githubClient.createCommitStatus({
					sha: headSha,
					state: conclusion === "success" ? "success" : "failure",
					description:
						conclusion === "success"
							? "Composer Agent completed successfully"
							: "Composer Agent reported failures",
					context: "Composer Agent",
					targetUrl: pr.url,
				});
			} catch (err) {
				this.log(
					`[executor] Failed to create commit status: ${err instanceof Error ? err.message : err}`,
				);
			}
		} catch (err) {
			this.log(
				`[executor] Failed to publish check run: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private async publishFailureCheckRun(
		task: Task,
		progress: TaskProgress,
		branchName: string,
	): Promise<void> {
		if (!this.githubClient) return;
		const summary = this.buildFailureSummary(task, progress);
		const text = progress.error ? `Error: ${progress.error}` : undefined;
		try {
			const supportsCheckRuns = await this.githubClient.supportsCheckRuns();
			if (supportsCheckRuns) {
				try {
					if (task.checkRunId) {
						await this.githubClient.updateCheckRun({
							id: task.checkRunId,
							status: "completed",
							conclusion: "failure",
							summary,
							text,
						});
						return;
					}
					const headSha = await this.githubClient.getBranchHeadSha(branchName);
					const checkRun = await this.githubClient.createCheckRun({
						name: "Composer Agent",
						headSha,
						status: "completed",
						conclusion: "failure",
						summary,
						text,
					});
					this.memory.updateTask(task.id, { checkRunId: checkRun.id });
					task.checkRunId = checkRun.id;
					return;
				} catch (err) {
					this.log(
						`[executor] Failed to update failure check run: ${err instanceof Error ? err.message : err}`,
					);
				}
			}

			const headSha = await this.githubClient.getBranchHeadSha(branchName);
			await this.githubClient.createCommitStatus({
				sha: headSha,
				state: "failure",
				description: "Composer Agent reported failures",
				context: "Composer Agent",
				targetUrl: task.result?.prUrl,
			});
		} catch (err) {
			this.log(
				`[executor] Failed to publish failure status: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private buildFailureSummary(task: Task, progress: TaskProgress): string {
		const lines: string[] = [`Task: ${task.title}`, "PR: not created"];
		if (progress.branch) {
			lines.push(`Branch: ${progress.branch}`);
		}
		if (progress.attempt && progress.maxAttempts) {
			lines.push(`Attempt: ${progress.attempt}/${progress.maxAttempts}`);
		}
		for (const [label, key] of [
			["Composer", "composer"],
			["Type check", "typecheck"],
			["Lint", "lint"],
			["Tests", "tests"],
			["Self-review", "selfReview"],
		] as const) {
			const status = progress.steps[key];
			if (status && status !== "skipped") {
				lines.push(`${label}: ${status}`);
			}
		}
		if (progress.error) {
			lines.push(`Error: ${progress.error}`);
		}
		if (typeof progress.durationMs === "number") {
			lines.push(`Duration: ${Math.round(progress.durationMs / 1000)}s`);
		}
		return lines.join("\n");
	}

	private buildProgressSummary(
		task: Task,
		progress: TaskProgress,
		prUrl?: string | null,
	): string {
		const lines: string[] = [
			`Task: ${task.title}`,
			`PR: ${prUrl ?? "pending"}`,
		];
		if (progress.branch) {
			lines.push(`Branch: ${progress.branch}`);
		}
		if (progress.attempt && progress.maxAttempts) {
			lines.push(`Attempt: ${progress.attempt}/${progress.maxAttempts}`);
		}
		for (const [label, key] of [
			["Composer", "composer"],
			["Type check", "typecheck"],
			["Lint", "lint"],
			["Tests", "tests"],
			["Self-review", "selfReview"],
		] as const) {
			const status = progress.steps[key];
			if (status && status !== "skipped") {
				lines.push(`${label}: ${status}`);
			}
		}
		return lines.join("\n");
	}

	private buildCheckRunSummary(
		task: Task,
		progress: TaskProgress,
		pr: { number: number; url: string },
	): string {
		const lines = this.buildProgressSummary(task, progress, pr.url).split("\n");
		if (typeof progress.tokensUsed === "number") {
			lines.push(`Tokens: ${progress.tokensUsed.toLocaleString()}`);
		}
		if (typeof progress.cost === "number") {
			lines.push(`Cost: $${progress.cost.toFixed(2)}`);
		}
		if (progress.durationMs) {
			lines.push(`Duration: ${Math.round(progress.durationMs / 1000)}s`);
		}
		return lines.join("\n");
	}

	private runCommand(command: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = spawn(command, args, {
				cwd: this.config.workingDir,
				env: process.env,
			});

			let stdout = "";
			let stderr = "";
			const maxOutputSize = 8 * 1024 * 1024; // 8MB limit to prevent memory issues
			let truncated = false;

			proc.stdout.on("data", (data) => {
				if (stdout.length < maxOutputSize) {
					stdout += data.toString();
					if (stdout.length >= maxOutputSize) {
						truncated = true;
						stdout = stdout.slice(0, maxOutputSize);
					}
				}
			});

			proc.stderr.on("data", (data) => {
				if (stderr.length < maxOutputSize) {
					stderr += data.toString();
				}
			});

			proc.on("close", (code) => {
				if (code === 0) {
					if (truncated) {
						stdout += "\n... (output truncated at 8MB)";
					}
					resolve(stdout);
				} else {
					reject(new Error(`${command} failed: ${stderr || stdout}`));
				}
			});

			proc.on("error", reject);
		});
	}
}
