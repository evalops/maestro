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

function maxIsoTimestamp(
	current: string | null,
	candidate?: string | null,
): string | null {
	if (!candidate) return current;
	if (!current) return candidate;
	return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

export class GitHubWatcher {
	private octokit: Octokit;
	private config: AgentConfig;
	private events: WatcherEvents;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastIssuePollTime: string;
	private lastTrackedPrPollTime: string;
	private trackedPRs: Set<number> = new Set();
	private trackedPrPollTimes: Map<number, string> = new Map();
	private notifiedIssues: Set<number> = new Set();
	private issueLabelSnapshots: Map<number, Set<string>> = new Map();

	constructor(token: string, config: AgentConfig, events: WatcherEvents) {
		this.octokit = new Octokit({ auth: token });
		this.config = config;
		this.events = events;
		// Start from now - don't process historical issues
		const now = new Date().toISOString();
		this.lastIssuePollTime = now;
		this.lastTrackedPrPollTime = now;
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
		if (!this.trackedPrPollTimes.has(prNumber)) {
			this.trackedPrPollTimes.set(prNumber, new Date().toISOString());
		}
	}

	private async poll(): Promise<void> {
		const pollStartedAt = new Date().toISOString();
		const issuesSince = this.lastIssuePollTime;
		const prsSince = this.lastTrackedPrPollTime;

		const [issuesCursor, prsCursor] = await Promise.all([
			this.pollIssues(issuesSince, pollStartedAt),
			this.pollTrackedPRs(prsSince, pollStartedAt),
		]);

		if (issuesCursor) {
			this.lastIssuePollTime = issuesCursor;
		}
		if (prsCursor) {
			this.lastTrackedPrPollTime = prsCursor;
		}
	}

	private async pollIssues(
		since: string,
		pollStartedAt: string,
	): Promise<string | null> {
		try {
			// Fetch issues updated since last poll
			const issues = await this.octokit.paginate(
				this.octokit.issues.listForRepo,
				{
					owner: this.config.owner,
					repo: this.config.repo,
					state: "all",
					since,
					per_page: 100,
				},
			);

			let maxUpdatedAt: string | null = null;
			for (const issue of issues) {
				maxUpdatedAt = maxIsoTimestamp(maxUpdatedAt, issue.updated_at);

				// Skip PRs (they show up in issues API too)
				if (issue.pull_request) continue;

				if (issue.state !== "open") {
					this.notifiedIssues.delete(issue.number);
					this.issueLabelSnapshots.delete(issue.number);
					continue;
				}

				// Check if issue has any of our target labels
				const labels = issue.labels.map((l) =>
					typeof l === "string" ? l : l.name || "",
				);
				const hasTargetLabel = labels.some((l) =>
					this.config.issueLabels.includes(l),
				);

				const labelSnapshot = new Set(labels.filter((l) => l.length > 0));
				const previousLabels = this.issueLabelSnapshots.get(issue.number);
				const hadTargetLabel = previousLabels
					? Array.from(previousLabels).some((l) =>
							this.config.issueLabels.includes(l),
						)
					: false;

				// Check if this is a new issue (created since last poll)
				const createdAt = new Date(issue.created_at);
				const sinceTime = new Date(since);
				const isNew = createdAt > sinceTime;

				if (
					hasTargetLabel &&
					!this.notifiedIssues.has(issue.number) &&
					(isNew || !hadTargetLabel)
				) {
					const reason = isNew ? "New issue" : "Issue labeled";
					console.log(`[watcher] ${reason} #${issue.number}: ${issue.title}`);
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
					this.notifiedIssues.add(issue.number);
				}

				this.issueLabelSnapshots.set(issue.number, labelSnapshot);
			}
			return maxIsoTimestamp(pollStartedAt, maxUpdatedAt);
		} catch (err) {
			console.error("[watcher] Error polling issues:", err);
			return null;
		}
	}

	private async pollTrackedPRs(
		since: string,
		pollStartedAt: string,
	): Promise<string | null> {
		let hadError = false;
		let maxEventAt: string | null = null;
		for (const prNumber of this.trackedPRs) {
			const prSince = this.trackedPrPollTimes.get(prNumber) ?? since;
			try {
				const pr = await this.fetchPR(prNumber);

				if (pr.state === "merged") {
					console.log(`[watcher] PR #${prNumber} merged`);
					await this.events.onPRMerged(pr);
					this.trackedPRs.delete(prNumber);
					this.trackedPrPollTimes.delete(prNumber);
				} else if (pr.state === "closed") {
					console.log(`[watcher] PR #${prNumber} closed without merge`);
					await this.events.onPRClosed(pr);
					this.trackedPRs.delete(prNumber);
					this.trackedPrPollTimes.delete(prNumber);
				} else {
					// Check for new reviews
					const result = await this.pollPRReviews(prNumber, pr, prSince);
					if (!result.ok) {
						hadError = true;
						continue;
					}
					const nextCursor =
						maxIsoTimestamp(pollStartedAt, result.latest) ?? pollStartedAt;
					this.trackedPrPollTimes.set(prNumber, nextCursor);
					maxEventAt = maxIsoTimestamp(maxEventAt, nextCursor);
				}
			} catch (err) {
				const status =
					typeof err === "object" &&
					err !== null &&
					"status" in err &&
					typeof (err as { status?: unknown }).status === "number"
						? (err as { status: number }).status
						: undefined;
				if (status === 404 || status === 410) {
					console.warn(
						`[watcher] PR #${prNumber} not found (status ${status}); removing from tracking`,
					);
					this.trackedPRs.delete(prNumber);
					this.trackedPrPollTimes.delete(prNumber);
					continue;
				}
				console.error(`[watcher] Error checking PR #${prNumber}:`, err);
				hadError = true;
			}
		}
		if (hadError) return null;
		return maxIsoTimestamp(pollStartedAt, maxEventAt);
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
	): Promise<{ latest: string | null; ok: boolean }> {
		try {
			const reviews = await this.octokit.paginate(
				this.octokit.pulls.listReviews,
				{
					owner: this.config.owner,
					repo: this.config.repo,
					pull_number: prNumber,
					per_page: 100,
				},
			);

			// Check for reviews submitted since last poll
			const sinceTime = new Date(since);
			let maxEventAt: string | null = null;
			for (const review of reviews) {
				if (!review.submitted_at) continue;
				const submittedAt = new Date(review.submitted_at);
				// Use < (not <=) so reviews at the exact poll time are included.
				if (submittedAt < sinceTime) continue;
				maxEventAt = maxIsoTimestamp(maxEventAt, review.submitted_at);

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
			const comments = await this.octokit.paginate(
				this.octokit.pulls.listReviewComments,
				{
					owner: this.config.owner,
					repo: this.config.repo,
					pull_number: prNumber,
					since,
					per_page: 100,
				},
			);

			for (const comment of comments) {
				maxEventAt = maxIsoTimestamp(maxEventAt, comment.created_at);
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
			return { latest: maxEventAt, ok: true };
		} catch (err) {
			console.error(`[watcher] Error polling PR #${prNumber} reviews:`, err);
			return { latest: null, ok: false };
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
