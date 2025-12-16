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
import type { MemoryStore } from "../memory/store.js";
import type { AgentConfig, Task, TaskResult } from "../types.js";

export interface ExecutorOptions {
	config: AgentConfig;
	memory: MemoryStore;
	onLog?: (message: string) => void;
}

export class TaskExecutor {
	private config: AgentConfig;
	private memory: MemoryStore;
	private log: (message: string) => void;

	constructor(options: ExecutorOptions) {
		this.config = options.config;
		this.memory = options.memory;
		this.log = options.onLog || console.log;
	}

	/**
	 * Execute a task and return the result
	 */
	async execute(task: Task): Promise<TaskResult> {
		const startTime = Date.now();

		try {
			// Ensure working directory exists
			mkdirSync(this.config.workingDir, { recursive: true });

			// Generate branch name
			const branchName = this.generateBranchName(task);
			this.log(`[executor] Starting task ${task.id}`);
			this.log(`[executor] Branch: ${branchName}`);

			// Step 1: Create feature branch
			await this.createBranch(branchName);

			// Step 2: Build the prompt
			const prompt = this.buildPrompt(task);

			// Step 3: Run composer exec
			this.log("[executor] Running composer...");
			const composerResult = await this.runComposer(prompt);

			if (!composerResult.success) {
				throw new Error(`Composer failed: ${composerResult.error}`);
			}

			// Step 4: Run quality gates
			this.log("[executor] Running quality gates...");
			await this.runQualityGates();

			// Step 5: Optional self-review
			if (this.config.selfReview) {
				this.log("[executor] Running self-review...");
				await this.runSelfReview();
			}

			// Step 6: Create PR
			this.log("[executor] Creating PR...");
			const pr = await this.createPR(task, branchName);

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

			const proc = spawn(composerBin, args, {
				cwd: this.config.workingDir,
				env: {
					...process.env,
					// Inherit API keys from environment
				},
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let tokensUsed = 0;
			let cost = 0;

			proc.stdout.on("data", (data) => {
				const chunk = data.toString();
				stdout += chunk;

				// Parse JSONL events for token usage
				for (const line of chunk.split("\n")) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "assistant_turn_end" && event.usage) {
							tokensUsed += event.usage.input_tokens || 0;
							tokensUsed += event.usage.output_tokens || 0;
							cost += event.usage.cost || 0;
						}
					} catch {
						// Not JSON, skip
					}
				}
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code === 0) {
					resolve({ success: true, tokensUsed, cost });
				} else {
					resolve({
						success: false,
						error: stderr || `Exit code ${code}`,
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

	private async runQualityGates(): Promise<void> {
		if (this.config.requireTypeCheck) {
			this.log("[executor] Type checking...");
			await this.runCommand("npx", [
				"nx",
				"run",
				"composer:build:all",
				"--skip-nx-cache",
			]);
		}

		if (this.config.requireLint) {
			this.log("[executor] Linting...");
			await this.runCommand("bun", ["run", "bun:lint"]);
		}

		if (this.config.requireTests) {
			this.log("[executor] Running tests...");
			await this.runCommand("npx", [
				"nx",
				"run",
				"composer:test",
				"--skip-nx-cache",
			]);
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
		branchName: string,
	): Promise<{ number: number; url: string }> {
		// Push the branch
		await this.runCommand("git", ["push", "-u", "origin", branchName]);

		// Sanitize title: remove special chars, limit length (GitHub max is 256)
		const sanitizedTaskTitle = task.title
			.replace(/[^\w\s\-.,!?()]/g, "") // Remove special chars except common punctuation
			.slice(0, 200) // Leave room for prefix and suffix
			.trim();

		// Create PR using gh CLI
		const title = task.sourceIssue
			? `[composer] ${sanitizedTaskTitle} (fixes #${task.sourceIssue})`
			: `[composer] ${sanitizedTaskTitle}`;

		const body = this.buildPRBody(task);

		const output = await this.runCommand("gh", [
			"pr",
			"create",
			"--title",
			title,
			"--body",
			body,
			"--base",
			this.config.baseBranch,
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
