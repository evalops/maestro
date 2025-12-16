/**
 * GitHub Watcher - Polls GitHub for new issues and PR updates
 *
 * Watches for:
 * - New issues with target labels
 * - PR status changes (merged, closed, review comments)
 * - Mentions in comments
 */

import { Octokit } from "@octokit/rest";
import type {
	AgentConfig,
	GitHubIssue,
	GitHubPR,
	PRComment,
	PRReview,
} from "../types.js";

export interface WatcherEvents {
	onNewIssue: (issue: GitHubIssue) => Promise<void>;
	onPRMerged: (pr: GitHubPR) => Promise<void>;
	onPRClosed: (pr: GitHubPR) => Promise<void>;
	onPRReview: (pr: GitHubPR, review: PRReview) => Promise<void>;
	onPRComment: (pr: GitHubPR, comment: PRComment) => Promise<void>;
}

export class GitHubWatcher {
	private octokit: Octokit;
	private config: AgentConfig;
	private events: WatcherEvents;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastPollTime: string;
	private trackedPRs: Set<number> = new Set();

	constructor(token: string, config: AgentConfig, events: WatcherEvents) {
		this.octokit = new Octokit({ auth: token });
		this.config = config;
		this.events = events;
		// Start from now - don't process historical issues
		this.lastPollTime = new Date().toISOString();
	}

	async start(): Promise<void> {
		console.log(
			`[watcher] Starting GitHub watcher for ${this.config.owner}/${this.config.repo}`,
		);
		console.log(
			`[watcher] Watching labels: ${this.config.issueLabels.join(", ")}`,
		);
		console.log(`[watcher] Poll interval: ${this.config.pollIntervalMs}ms`);

		// Initial poll
		await this.poll();

		// Set up recurring poll
		this.pollTimer = setInterval(() => {
			this.poll().catch((err) => {
				console.error("[watcher] Poll error:", err.message);
			});
		}, this.config.pollIntervalMs);
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		console.log("[watcher] Stopped");
	}

	/**
	 * Track a PR for outcome monitoring
	 */
	trackPR(prNumber: number): void {
		this.trackedPRs.add(prNumber);
	}

	private async poll(): Promise<void> {
		const since = this.lastPollTime;
		this.lastPollTime = new Date().toISOString();

		await Promise.all([this.pollIssues(since), this.pollTrackedPRs(since)]);
	}

	private async pollIssues(since: string): Promise<void> {
		try {
			// Fetch issues updated since last poll
			const { data: issues } = await this.octokit.issues.listForRepo({
				owner: this.config.owner,
				repo: this.config.repo,
				state: "open",
				since,
				per_page: 50,
			});

			for (const issue of issues) {
				// Skip PRs (they show up in issues API too)
				if (issue.pull_request) continue;

				// Check if issue has any of our target labels
				const labels = issue.labels.map((l) =>
					typeof l === "string" ? l : l.name || "",
				);
				const hasTargetLabel = labels.some((l) =>
					this.config.issueLabels.includes(l),
				);

				if (!hasTargetLabel) continue;

				// Check if this is a new issue (created since last poll)
				const createdAt = new Date(issue.created_at);
				const sinceTime = new Date(since);
				const isNew = createdAt > sinceTime;

				if (isNew) {
					console.log(`[watcher] New issue #${issue.number}: ${issue.title}`);
					await this.events.onNewIssue({
						number: issue.number,
						title: issue.title,
						body: issue.body ?? null,
						labels,
						state: issue.state as "open" | "closed",
						author: issue.user?.login || "unknown",
						createdAt: issue.created_at,
						updatedAt: issue.updated_at,
						url: issue.html_url,
						comments: issue.comments,
					});
				}
			}
		} catch (err) {
			console.error("[watcher] Error polling issues:", err);
		}
	}

	private async pollTrackedPRs(since: string): Promise<void> {
		for (const prNumber of this.trackedPRs) {
			try {
				const pr = await this.fetchPR(prNumber);

				if (pr.state === "merged") {
					console.log(`[watcher] PR #${prNumber} merged`);
					await this.events.onPRMerged(pr);
					this.trackedPRs.delete(prNumber);
				} else if (pr.state === "closed") {
					console.log(`[watcher] PR #${prNumber} closed without merge`);
					await this.events.onPRClosed(pr);
					this.trackedPRs.delete(prNumber);
				} else {
					// Check for new reviews
					await this.pollPRReviews(prNumber, pr, since);
				}
			} catch (err) {
				console.error(`[watcher] Error checking PR #${prNumber}:`, err);
			}
		}
	}

	private async fetchPR(prNumber: number): Promise<GitHubPR> {
		const { data: pr } = await this.octokit.pulls.get({
			owner: this.config.owner,
			repo: this.config.repo,
			pull_number: prNumber,
		});

		let state: "open" | "closed" | "merged" = pr.state as "open" | "closed";
		if (pr.merged) {
			state = "merged";
		}

		return {
			number: pr.number,
			title: pr.title,
			body: pr.body,
			state,
			author: pr.user?.login || "unknown",
			branch: pr.head.ref,
			base: pr.base.ref,
			createdAt: pr.created_at,
			updatedAt: pr.updated_at,
			mergedAt: pr.merged_at,
			url: pr.html_url,
			reviewDecision: null, // Would need GraphQL for this
		};
	}

	private async pollPRReviews(
		prNumber: number,
		pr: GitHubPR,
		since: string,
	): Promise<void> {
		try {
			const { data: reviews } = await this.octokit.pulls.listReviews({
				owner: this.config.owner,
				repo: this.config.repo,
				pull_number: prNumber,
				per_page: 10,
			});

			// Check for reviews submitted since last poll
			const sinceTime = new Date(since);
			for (const review of reviews) {
				if (!review.submitted_at) continue;
				const submittedAt = new Date(review.submitted_at);
				// Use < not <= to include reviews at exact poll time
				if (submittedAt < sinceTime) continue;

				const reviewState = review.state as PRReview["state"];
				if (reviewState === "APPROVED" || reviewState === "CHANGES_REQUESTED") {
					console.log(
						`[watcher] PR #${prNumber} received ${reviewState} from ${review.user?.login}`,
					);
					await this.events.onPRReview(pr, {
						id: review.id,
						author: review.user?.login || "unknown",
						state: reviewState,
						body: review.body,
						submittedAt: review.submitted_at,
					});
				}
			}

			// Check for new comments
			const { data: comments } = await this.octokit.pulls.listReviewComments({
				owner: this.config.owner,
				repo: this.config.repo,
				pull_number: prNumber,
				since,
				per_page: 50,
			});

			for (const comment of comments) {
				console.log(
					`[watcher] PR #${prNumber} new comment from ${comment.user?.login}`,
				);
				await this.events.onPRComment(pr, {
					id: comment.id,
					author: comment.user?.login || "unknown",
					body: comment.body,
					path: comment.path ?? null,
					line: comment.line ?? null,
					createdAt: comment.created_at,
				});
			}
		} catch (err) {
			console.error(`[watcher] Error polling PR #${prNumber} reviews:`, err);
		}
	}

	/**
	 * Fetch a specific issue
	 */
	async getIssue(issueNumber: number): Promise<GitHubIssue> {
		const { data: issue } = await this.octokit.issues.get({
			owner: this.config.owner,
			repo: this.config.repo,
			issue_number: issueNumber,
		});

		const labels = issue.labels.map((l) =>
			typeof l === "string" ? l : l.name || "",
		);

		return {
			number: issue.number,
			title: issue.title,
			body: issue.body ?? null,
			labels,
			state: issue.state as "open" | "closed",
			author: issue.user?.login || "unknown",
			createdAt: issue.created_at,
			updatedAt: issue.updated_at,
			url: issue.html_url,
			comments: issue.comments,
		};
	}
}
