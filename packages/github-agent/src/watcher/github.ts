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
	CheckRunSummary,
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
	onPRCheckRuns?: (pr: GitHubPR, checkRuns: CheckRunSummary[]) => Promise<void>;
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

function isFailureConclusion(
	conclusion: CheckRunSummary["conclusion"],
): boolean {
	if (!conclusion) return false;
	return !["success", "neutral", "skipped"].includes(conclusion);
}

const ISSUE_TRACK_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_TRACKED_ISSUES = 5000;

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
	private trackedPrCheckRunTimes: Map<number, string> = new Map();
	private notifiedIssues: Set<number> = new Set();
	private issueLabelSnapshots: Map<number, Set<string>> = new Map();
	private issueLastSeen: Map<number, number> = new Map();
	private pollInProgress = false;

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
		if (!this.trackedPrCheckRunTimes.has(prNumber)) {
			this.trackedPrCheckRunTimes.set(prNumber, new Date().toISOString());
		}
	}

	private async poll(): Promise<void> {
		if (this.pollInProgress) {
			return;
		}
		this.pollInProgress = true;
		const pollStartedAt = new Date().toISOString();
		const issuesSince = this.lastIssuePollTime;
		const prsSince = this.lastTrackedPrPollTime;
		const commentsSince = this.lastIssueCommentPollTime;

		try {
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
		} finally {
			this.pollInProgress = false;
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
					this.issueLastSeen.delete(issue.number);
					continue;
				}

				const now = Date.now();
				if (this.issueLastSeen.has(issue.number)) {
					this.issueLastSeen.delete(issue.number);
				}
				this.issueLastSeen.set(issue.number, now);

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
			this.pruneIssueTracking();
			return maxIsoTimestamp(pollStartedAt, maxUpdatedAt);
		} catch (err) {
			console.error("[watcher] Error polling issues:", err);
			return null;
		}
	}

	private pruneIssueTracking(): void {
		const now = Date.now();
		for (const [issueNumber, lastSeen] of this.issueLastSeen) {
			if (now - lastSeen > ISSUE_TRACK_TTL_MS) {
				this.issueLastSeen.delete(issueNumber);
				this.notifiedIssues.delete(issueNumber);
				this.issueLabelSnapshots.delete(issueNumber);
			}
		}

		while (this.issueLastSeen.size > MAX_TRACKED_ISSUES) {
			const oldest = this.issueLastSeen.keys().next().value as
				| number
				| undefined;
			if (oldest === undefined) break;
			this.issueLastSeen.delete(oldest);
			this.notifiedIssues.delete(oldest);
			this.issueLabelSnapshots.delete(oldest);
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
					this.trackedPrCheckRunTimes.delete(prNumber);
				} else if (pr.state === "closed") {
					console.log(`[watcher] PR #${prNumber} closed without merge`);
					await this.events.onPRClosed(pr);
					this.trackedPRs.delete(prNumber);
					this.trackedPrPollTimes.delete(prNumber);
					this.trackedPrCheckRunTimes.delete(prNumber);
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

					const checkSince =
						this.trackedPrCheckRunTimes.get(prNumber) ?? prSince;
					const checkResult = await this.pollPRCheckRuns(
						prNumber,
						pr,
						checkSince,
					);
					if (!checkResult.ok) {
						hadError = true;
						continue;
					}
					if (checkResult.latest) {
						this.trackedPrCheckRunTimes.set(
							prNumber,
							maxIsoTimestamp(pollStartedAt, checkResult.latest) ??
								pollStartedAt,
						);
						maxEventAt = maxIsoTimestamp(maxEventAt, checkResult.latest);
					}
					if (checkResult.failures.length > 0 && this.events.onPRCheckRuns) {
						await this.events.onPRCheckRuns(pr, checkResult.failures);
					}
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
					this.trackedPrCheckRunTimes.delete(prNumber);
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

	private async pollPRCheckRuns(
		prNumber: number,
		pr: GitHubPR,
		since: string,
	): Promise<{
		latest: string | null;
		ok: boolean;
		failures: CheckRunSummary[];
	}> {
		if (!pr.headSha) {
			return { latest: null, ok: true, failures: [] };
		}
		try {
			const checkRuns = await this.client.listCheckRunsForRef(pr.headSha);
			const sinceTime = new Date(since);
			let maxEventAt: string | null = null;
			const failures: CheckRunSummary[] = [];

			for (const run of checkRuns) {
				const eventAt = run.completedAt ?? run.startedAt ?? null;
				if (eventAt) {
					const eventDate = new Date(eventAt);
					if (eventDate < sinceTime) {
						continue;
					}
					maxEventAt = maxIsoTimestamp(maxEventAt, eventAt);
				}

				if (run.status === "completed" && isFailureConclusion(run.conclusion)) {
					failures.push(run);
				}
			}

			if (failures.length > 0) {
				console.log(
					`[watcher] PR #${prNumber} check run failures: ${failures
						.map((run) => run.name)
						.join(", ")}`,
				);
			}

			return { latest: maxEventAt, ok: true, failures };
		} catch (err) {
			console.error(`[watcher] Error polling PR #${prNumber} check runs:`, err);
			return { latest: null, ok: false, failures: [] };
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
