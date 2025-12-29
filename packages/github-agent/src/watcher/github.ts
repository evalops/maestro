/**
 * GitHub Watcher - Polls GitHub for new issues and PR updates
 *
 * Watches for:
 * - New issues with target labels
 * - PR status changes (merged, closed, review comments)
 * - Mentions in comments
 */

import type { GitHubApiClient } from "../github/client.js";
import type {
	AgentConfig,
	GitHubIssue,
	GitHubPR,
	IssueComment,
	PRComment,
	PRReview,
} from "../types.js";

export interface WatcherEvents {
	onNewIssue: (issue: GitHubIssue) => Promise<void>;
	onPRMerged: (pr: GitHubPR) => Promise<void>;
	onPRClosed: (pr: GitHubPR) => Promise<void>;
	onPRReview: (pr: GitHubPR, review: PRReview) => Promise<void>;
	onPRComment: (pr: GitHubPR, comment: PRComment) => Promise<void>;
	onIssueComment?: (issue: GitHubIssue, comment: IssueComment) => Promise<void>;
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
	private client: GitHubApiClient;
	private config: AgentConfig;
	private events: WatcherEvents;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastIssuePollTime: string;
	private lastTrackedPrPollTime: string;
	private lastIssueCommentPollTime: string;
	private trackedPRs: Set<number> = new Set();
	private trackedPrPollTimes: Map<number, string> = new Map();
	private notifiedIssues: Set<number> = new Set();
	private issueLabelSnapshots: Map<number, Set<string>> = new Map();

	constructor(
		client: GitHubApiClient,
		config: AgentConfig,
		events: WatcherEvents,
	) {
		this.client = client;
		this.config = config;
		this.events = events;
		// Start from now - don't process historical issues
		const now = new Date().toISOString();
		this.lastIssuePollTime = now;
		this.lastTrackedPrPollTime = now;
		this.lastIssueCommentPollTime = now;
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
		const commentsSince = this.lastIssueCommentPollTime;

		const [issuesCursor, prsCursor, commentsCursor] = await Promise.all([
			this.pollIssues(issuesSince, pollStartedAt),
			this.pollTrackedPRs(prsSince, pollStartedAt),
			this.pollIssueComments(commentsSince, pollStartedAt),
		]);

		if (issuesCursor) {
			this.lastIssuePollTime = issuesCursor;
		}
		if (prsCursor) {
			this.lastTrackedPrPollTime = prsCursor;
		}
		if (commentsCursor) {
			this.lastIssueCommentPollTime = commentsCursor;
		}
	}

	private async pollIssues(
		since: string,
		pollStartedAt: string,
	): Promise<string | null> {
		try {
			// Fetch issues updated since last poll
			const issues = await this.client.listIssuesUpdatedSince(since);

			let maxUpdatedAt: string | null = null;
			for (const issue of issues) {
				maxUpdatedAt = maxIsoTimestamp(maxUpdatedAt, issue.updatedAt);

				if (issue.state !== "open") {
					this.notifiedIssues.delete(issue.number);
					this.issueLabelSnapshots.delete(issue.number);
					continue;
				}

				// Check if issue has any of our target labels
				const labels = issue.labels;
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
				const createdAt = new Date(issue.createdAt);
				const sinceTime = new Date(since);
				const isNew = createdAt > sinceTime;

				if (
					hasTargetLabel &&
					!this.notifiedIssues.has(issue.number) &&
					(isNew || !hadTargetLabel)
				) {
					const reason = isNew ? "New issue" : "Issue labeled";
					console.log(`[watcher] ${reason} #${issue.number}: ${issue.title}`);
					await this.events.onNewIssue(issue);
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
				const pr = await this.client.getPullRequest(prNumber);

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

	private async pollPRReviews(
		prNumber: number,
		pr: GitHubPR,
		since: string,
	): Promise<{ latest: string | null; ok: boolean }> {
		try {
			const reviews = await this.client.listPullRequestReviews(prNumber);

			// Check for reviews submitted since last poll
			const sinceTime = new Date(since);
			let maxEventAt: string | null = null;
			for (const review of reviews) {
				if (!review.submittedAt) continue;
				const submittedAt = new Date(review.submittedAt);
				// Use < (not <=) so reviews at the exact poll time are included.
				if (submittedAt < sinceTime) continue;
				maxEventAt = maxIsoTimestamp(maxEventAt, review.submittedAt);

				const reviewState = review.state as PRReview["state"];
				if (reviewState === "APPROVED" || reviewState === "CHANGES_REQUESTED") {
					console.log(
						`[watcher] PR #${prNumber} received ${reviewState} from ${review.author}`,
					);
					await this.events.onPRReview(pr, {
						id: review.id,
						author: review.author || "unknown",
						state: reviewState,
						body: review.body,
						submittedAt: review.submittedAt,
					});
				}
			}

			// Check for new comments
			const comments = await this.client.listPullRequestReviewComments(
				prNumber,
				since,
			);

			for (const comment of comments) {
				maxEventAt = maxIsoTimestamp(maxEventAt, comment.createdAt);
				console.log(
					`[watcher] PR #${prNumber} new comment from ${comment.author}`,
				);
				await this.events.onPRComment(pr, {
					id: comment.id,
					author: comment.author || "unknown",
					body: comment.body,
					path: comment.path ?? null,
					line: comment.line ?? null,
					createdAt: comment.createdAt,
				});
			}
			return { latest: maxEventAt, ok: true };
		} catch (err) {
			console.error(`[watcher] Error polling PR #${prNumber} reviews:`, err);
			return { latest: null, ok: false };
		}
	}

	private async pollIssueComments(
		since: string,
		pollStartedAt: string,
	): Promise<string | null> {
		if (!this.events.onIssueComment) {
			return pollStartedAt;
		}
		try {
			const comments = await this.client.listIssueCommentsSince(since);
			let maxUpdatedAt: string | null = null;
			for (const { issue, comment } of comments) {
				maxUpdatedAt = maxIsoTimestamp(maxUpdatedAt, comment.createdAt);
				if (issue.state !== "open") continue;
				await this.events.onIssueComment(issue, {
					id: comment.id,
					issueNumber: issue.number,
					author: comment.author,
					body: comment.body,
					createdAt: comment.createdAt,
					url: issue.url,
				});
			}
			return maxIsoTimestamp(pollStartedAt, maxUpdatedAt);
		} catch (err) {
			console.error("[watcher] Error polling issue comments:", err);
			return null;
		}
	}

	/**
	 * Fetch a specific issue
	 */
	async getIssue(issueNumber: number): Promise<GitHubIssue> {
		return this.client.getIssue(issueNumber);
	}
}
