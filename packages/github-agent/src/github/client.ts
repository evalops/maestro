import { setTimeout as sleep } from "node:timers/promises";
import { Octokit } from "@octokit/rest";
import type { GitHubIssue, GitHubPR, PRComment, PRReview } from "../types.js";
import {
	type GitHubAuth,
	resolveGitHubApiUrl,
	resolveGitHubGraphqlUrl,
} from "./auth.js";

export interface GitHubClientOptions {
	owner: string;
	repo: string;
	auth: GitHubAuth;
	apiUrl?: string;
	userAgent?: string;
	timeoutMs?: number;
}

export interface GitHubRateLimitSnapshot {
	remaining: number;
	resetAt?: number;
	limit?: number;
	resource?: string;
}

type GitHubResponse<T> = {
	data: T | null;
	status: number;
	headers: Record<string, string>;
	notModified?: boolean;
};

type RequestOptions = {
	useEtag?: boolean;
};

type PaginateOptions = RequestOptions & {
	perPage?: number;
};

type GraphqlResponse<T> = {
	data: T;
	rateLimit?: {
		remaining: number;
		resetAt?: string;
	};
};

class EtagCache {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly store = new Map<
		string,
		{ etag: string; updatedAt: number }
	>();

	constructor(ttlMs = 5 * 60 * 1000, maxEntries = 1000) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	get(key: string): string | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.updatedAt > this.ttlMs) {
			this.store.delete(key);
			return undefined;
		}
		return entry.etag;
	}

	set(key: string, etag: string) {
		this.store.set(key, { etag, updatedAt: Date.now() });
		this.prune();
	}

	private prune() {
		const now = Date.now();
		for (const [cacheKey, entry] of this.store) {
			if (now - entry.updatedAt > this.ttlMs) {
				this.store.delete(cacheKey);
			}
		}

		while (this.store.size > this.maxEntries) {
			const oldest = this.store.keys().next().value as string | undefined;
			if (!oldest) break;
			this.store.delete(oldest);
		}
	}
}

export class GitHubApiClient {
	private readonly owner: string;
	private readonly repo: string;
	private readonly auth: GitHubAuth;
	private readonly octokit: Octokit;
	private readonly graphqlUrl: string;
	private readonly userAgent: string;
	private readonly etags = new EtagCache();
	private rateLimit: GitHubRateLimitSnapshot = { remaining: 0 };

	constructor(options: GitHubClientOptions) {
		this.owner = options.owner;
		this.repo = options.repo;
		this.auth = options.auth;
		const apiUrl = resolveGitHubApiUrl(options.apiUrl);
		this.graphqlUrl = resolveGitHubGraphqlUrl(apiUrl);
		this.userAgent = options.userAgent ?? "evalops-github-agent";
		this.octokit = new Octokit({
			baseUrl: apiUrl,
			userAgent: this.userAgent,
			request: { timeout: options.timeoutMs ?? 15_000 },
		});
	}

	getRateLimitSnapshot(): GitHubRateLimitSnapshot {
		return { ...this.rateLimit };
	}

	async listIssuesUpdatedSince(since: string): Promise<GitHubIssue[]> {
		const results = await this.paginate<{
			number: number;
			title: string;
			body: string | null;
			labels: Array<{ name: string } | string>;
			state: string;
			user: { login: string } | null;
			created_at: string;
			updated_at: string;
			html_url: string;
			comments: number;
			pull_request?: unknown;
		}>(
			"GET /repos/{owner}/{repo}/issues",
			{
				owner: this.owner,
				repo: this.repo,
				state: "all",
				since,
			},
			{ useEtag: true },
		);
		return results
			.filter((issue) => !issue.pull_request)
			.map((issue) => ({
				number: issue.number,
				title: issue.title,
				body: issue.body ?? null,
				labels: issue.labels.map((label) =>
					typeof label === "string" ? label : label.name,
				),
				state: issue.state as "open" | "closed",
				author: issue.user?.login || "unknown",
				createdAt: issue.created_at,
				updatedAt: issue.updated_at,
				url: issue.html_url,
				comments: issue.comments,
			}));
	}

	async listIssueCommentsSince(
		since: string,
	): Promise<Array<{ issue: GitHubIssue; comment: PRComment }>> {
		const comments = await this.paginate<{
			issue_url: string;
			id: number;
			user: { login: string } | null;
			body: string;
			html_url: string;
			created_at: string;
			updated_at: string;
		}>(
			"GET /repos/{owner}/{repo}/issues/comments",
			{
				owner: this.owner,
				repo: this.repo,
				since,
			},
			{ useEtag: true },
		);

		const results: Array<{ issue: GitHubIssue; comment: PRComment }> = [];
		for (const comment of comments) {
			const issueNumber = extractIssueNumber(comment.issue_url);
			if (!issueNumber) continue;
			const issue = await this.getIssue(issueNumber);
			results.push({
				issue,
				comment: {
					id: comment.id,
					author: comment.user?.login || "unknown",
					body: comment.body,
					path: null,
					line: null,
					createdAt: comment.created_at,
				},
			});
		}
		return results;
	}

	async getIssue(issueNumber: number): Promise<GitHubIssue> {
		const { data } = await this.request<{
			number: number;
			title: string;
			body: string | null;
			labels: Array<{ name: string } | string>;
			state: string;
			user: { login: string } | null;
			created_at: string;
			updated_at: string;
			html_url: string;
			comments: number;
		}>("GET /repos/{owner}/{repo}/issues/{issue_number}", {
			owner: this.owner,
			repo: this.repo,
			issue_number: issueNumber,
		});
		if (!data) {
			throw new Error(`Issue ${issueNumber} not found`);
		}
		return {
			number: data.number,
			title: data.title,
			body: data.body,
			labels: data.labels.map((label) =>
				typeof label === "string" ? label : label.name,
			),
			state: data.state as "open" | "closed",
			author: data.user?.login || "unknown",
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			url: data.html_url,
			comments: data.comments,
		};
	}

	async getPullRequest(prNumber: number): Promise<GitHubPR> {
		const graphql = await this.queryPullRequestGraphql(prNumber);
		if (graphql) {
			return graphql;
		}
		const { data } = await this.request<{
			number: number;
			title: string;
			body: string | null;
			state: string;
			merged: boolean;
			user: { login: string } | null;
			head: { ref: string };
			base: { ref: string };
			created_at: string;
			updated_at: string;
			merged_at: string | null;
			html_url: string;
		}>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
			owner: this.owner,
			repo: this.repo,
			pull_number: prNumber,
		});
		if (!data) {
			throw new Error(`Pull request ${prNumber} not found`);
		}
		const state =
			data.state === "closed" && data.merged ? "merged" : data.state;
		return {
			number: data.number,
			title: data.title,
			body: data.body,
			state: state as "open" | "closed" | "merged",
			author: data.user?.login || "unknown",
			branch: data.head.ref,
			base: data.base.ref,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			mergedAt: data.merged_at,
			url: data.html_url,
			reviewDecision: null,
		};
	}

	async listPullRequestReviews(prNumber: number): Promise<PRReview[]> {
		const reviews = await this.paginate<{
			id: number;
			user: { login: string } | null;
			state: PRReview["state"];
			body: string | null;
			submitted_at: string | null;
		}>("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
			owner: this.owner,
			repo: this.repo,
			pull_number: prNumber,
		});
		return reviews
			.filter((review) => Boolean(review.submitted_at))
			.map((review) => ({
				id: review.id,
				author: review.user?.login || "unknown",
				state: review.state,
				body: review.body,
				submittedAt: review.submitted_at ?? "",
			}));
	}

	async listPullRequestReviewComments(
		prNumber: number,
		since?: string,
	): Promise<PRComment[]> {
		const comments = await this.paginate<{
			id: number;
			user: { login: string } | null;
			body: string;
			path: string | null;
			line: number | null;
			created_at: string;
		}>("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
			owner: this.owner,
			repo: this.repo,
			pull_number: prNumber,
			since,
		});
		return comments.map((comment) => ({
			id: comment.id,
			author: comment.user?.login || "unknown",
			body: comment.body,
			path: comment.path ?? null,
			line: comment.line ?? null,
			createdAt: comment.created_at,
		}));
	}

	async createIssueComment(
		issueNumber: number,
		body: string,
	): Promise<{ id: number; url: string }> {
		const { data } = await this.request<{ id: number; html_url: string }>(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
				body,
			},
		);
		if (!data) {
			throw new Error("Failed to create issue comment");
		}
		return { id: data.id, url: data.html_url };
	}

	async updateIssueComment(commentId: number, body: string): Promise<void> {
		await this.request(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
			{
				owner: this.owner,
				repo: this.repo,
				comment_id: commentId,
				body,
			},
		);
	}

	async addIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
		if (labels.length === 0) return;
		await this.request(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
			{
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
				labels,
			},
		);
	}

	async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
		await this.request(
			"DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
			{
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
				name: label,
			},
		);
	}

	async createPullRequest(input: {
		title: string;
		head: string;
		base: string;
		body?: string;
		draft?: boolean;
	}): Promise<{ number: number; url: string }> {
		const { data } = await this.request<{
			number: number;
			html_url: string;
		}>("POST /repos/{owner}/{repo}/pulls", {
			owner: this.owner,
			repo: this.repo,
			title: input.title,
			head: input.head,
			base: input.base,
			body: input.body,
			draft: input.draft,
		});
		if (!data) {
			throw new Error("Failed to create pull request");
		}
		return { number: data.number, url: data.html_url };
	}

	async getBranchHeadSha(branch: string): Promise<string> {
		const { data } = await this.request<{
			object: { sha: string };
		}>("GET /repos/{owner}/{repo}/git/ref/heads/{ref}", {
			owner: this.owner,
			repo: this.repo,
			ref: branch,
		});
		if (!data?.object?.sha) {
			throw new Error(`Unable to resolve HEAD sha for ${branch}`);
		}
		return data.object.sha;
	}

	async createCommitStatus(input: {
		sha: string;
		state: "error" | "failure" | "pending" | "success";
		description?: string;
		context?: string;
		targetUrl?: string;
	}): Promise<void> {
		await this.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
			owner: this.owner,
			repo: this.repo,
			sha: input.sha,
			state: input.state,
			description: input.description,
			context: input.context ?? "Composer Agent",
			target_url: input.targetUrl,
		});
	}

	async createCheckRun(input: {
		name: string;
		headSha: string;
		status?: "queued" | "in_progress" | "completed";
		conclusion?:
			| "success"
			| "failure"
			| "neutral"
			| "cancelled"
			| "timed_out"
			| "action_required";
		detailsUrl?: string;
		summary?: string;
		text?: string;
	}): Promise<{ id: number }> {
		const { data } = await this.request<{ id: number }>(
			"POST /repos/{owner}/{repo}/check-runs",
			{
				owner: this.owner,
				repo: this.repo,
				name: input.name,
				head_sha: input.headSha,
				status: input.status,
				conclusion: input.conclusion,
				details_url: input.detailsUrl,
				output: input.summary
					? { title: input.name, summary: input.summary, text: input.text }
					: undefined,
			},
		);
		if (!data) {
			throw new Error("Failed to create check run");
		}
		return { id: data.id };
	}

	async updateCheckRun(input: {
		id: number;
		status?: "queued" | "in_progress" | "completed";
		conclusion?:
			| "success"
			| "failure"
			| "neutral"
			| "cancelled"
			| "timed_out"
			| "action_required";
		summary?: string;
		text?: string;
	}): Promise<void> {
		await this.request(
			"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
			{
				owner: this.owner,
				repo: this.repo,
				check_run_id: input.id,
				status: input.status,
				conclusion: input.conclusion,
				output: input.summary
					? { title: "GitHub Agent", summary: input.summary, text: input.text }
					: undefined,
			},
		);
	}

	private async request<T>(
		endpoint: string,
		params: Record<string, unknown>,
		options: RequestOptions = {},
		attempt = 0,
	): Promise<GitHubResponse<T>> {
		const token = await this.auth.getToken();
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": this.userAgent,
			Authorization:
				token.type === "app" ? `Bearer ${token.token}` : `token ${token.token}`,
		};

		const method = endpoint.split(" ")[0]?.toUpperCase() ?? "GET";
		const etagKey = options.useEtag
			? this.buildEtagKey(endpoint, params)
			: null;
		if (etagKey) {
			const etag = this.etags.get(etagKey);
			if (etag) {
				headers["If-None-Match"] = etag;
			}
		}

		try {
			const response = await this.octokit.request<T>(endpoint, {
				...params,
				headers,
			});
			this.captureRateLimit(response.headers);
			if (etagKey && response.headers.etag) {
				this.etags.set(etagKey, response.headers.etag);
			}
			return {
				data: response.data ?? null,
				status: response.status,
				headers: response.headers as Record<string, string>,
			};
		} catch (error) {
			const status = getStatus(error);
			const responseHeaders = getHeaders(error);
			if (status === 304) {
				if (etagKey && responseHeaders?.etag) {
					this.etags.set(etagKey, responseHeaders.etag);
				}
				return {
					data: null,
					status,
					headers: responseHeaders ?? {},
					notModified: true,
				};
			}
			this.captureRateLimit(responseHeaders);
			const retryDelay = this.getRetryDelayMs(error, status, responseHeaders);
			if (retryDelay !== null && attempt < 5) {
				await sleep(retryDelay);
				return this.request<T>(endpoint, params, options, attempt + 1);
			}
			throw error;
		}
	}

	private async paginate<T>(
		endpoint: string,
		params: Record<string, unknown>,
		options: PaginateOptions = {},
	): Promise<T[]> {
		const perPage = options.perPage ?? 100;
		const results: T[] = [];
		for (let page = 1; page <= 50; page += 1) {
			const response = await this.request<T[]>(
				endpoint,
				{ ...params, per_page: perPage, page },
				options,
			);
			if (response.notModified) {
				return [];
			}
			const data = response.data ?? [];
			results.push(...data);
			if (data.length < perPage) {
				break;
			}
		}
		return results;
	}

	private async queryPullRequestGraphql(
		prNumber: number,
	): Promise<GitHubPR | null> {
		try {
			const token = await this.auth.getToken();
			const data = await this.octokit.graphql<
				GraphqlResponse<{
					repository: {
						pullRequest: {
							number: number;
							title: string;
							body: string | null;
							state: "OPEN" | "CLOSED" | "MERGED";
							merged: boolean;
							mergedAt: string | null;
							url: string;
							createdAt: string;
							updatedAt: string;
							headRefName: string;
							baseRefName: string;
							author: { login: string } | null;
							reviewDecision:
								| "APPROVED"
								| "CHANGES_REQUESTED"
								| "REVIEW_REQUIRED"
								| null;
						};
					};
					rateLimit?: {
						remaining: number;
						resetAt: string;
					};
				}>
			>(
				`
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              number
              title
              body
              state
              merged
              mergedAt
              url
              createdAt
              updatedAt
              headRefName
              baseRefName
              reviewDecision
              author { login }
            }
          }
          rateLimit {
            remaining
            resetAt
          }
        }
      `,
				{
					owner: this.owner,
					repo: this.repo,
					number: prNumber,
					headers: {
						Authorization:
							token.type === "app"
								? `Bearer ${token.token}`
								: `token ${token.token}`,
						"User-Agent": this.userAgent,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					uri: this.graphqlUrl,
				},
			);
			const pr = data.repository.pullRequest;
			if (!pr) return null;
			if (data.rateLimit) {
				this.rateLimit = {
					remaining: data.rateLimit.remaining,
					resetAt: Date.parse(data.rateLimit.resetAt),
				};
			}
			const state =
				pr.state === "MERGED"
					? "merged"
					: pr.state === "CLOSED"
						? "closed"
						: "open";
			return {
				number: pr.number,
				title: pr.title,
				body: pr.body,
				state,
				author: pr.author?.login ?? "unknown",
				branch: pr.headRefName,
				base: pr.baseRefName,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				mergedAt: pr.mergedAt,
				url: pr.url,
				reviewDecision: pr.reviewDecision,
			};
		} catch {
			return null;
		}
	}

	private captureRateLimit(headers?: Record<string, string> | null): void {
		if (!headers) return;
		const remaining = parseNumber(headers["x-ratelimit-remaining"]);
		const limit = parseNumber(headers["x-ratelimit-limit"]);
		const reset = parseNumber(headers["x-ratelimit-reset"]);
		const resource = headers["x-ratelimit-resource"];
		if (remaining !== null) {
			this.rateLimit = {
				remaining,
				limit: limit ?? undefined,
				resetAt: reset ? reset * 1000 : undefined,
				resource,
			};
		}
	}

	private getRetryDelayMs(
		error: unknown,
		status: number | undefined,
		headers?: Record<string, string> | null,
	): number | null {
		if (!status) return null;
		if (status === 403 || status === 429) {
			const retryAfter = parseNumber(headers?.["retry-after"]);
			if (retryAfter !== null) {
				return retryAfter * 1000;
			}
			const remaining = parseNumber(headers?.["x-ratelimit-remaining"]);
			const reset = parseNumber(headers?.["x-ratelimit-reset"]);
			if (remaining === 0 && reset) {
				const waitMs = Math.max(reset * 1000 - Date.now(), 1000);
				return waitMs;
			}
			if (isSecondaryRateLimit(error)) {
				return jitterDelay(5_000);
			}
		}
		if (status >= 500 && status < 600) {
			return jitterDelay(2_000);
		}
		return null;
	}

	private buildEtagKey(
		endpoint: string,
		params: Record<string, unknown>,
	): string {
		const sortedKeys = Object.keys(params).sort();
		const stableParams: Record<string, unknown> = {};
		for (const key of sortedKeys) {
			stableParams[key] = params[key];
		}
		return `${endpoint}:${JSON.stringify(stableParams)}`;
	}
}

function extractIssueNumber(issueUrl: string): number | null {
	const match = issueUrl.match(/\/issues\/(\d+)/);
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseNumber(value?: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function getStatus(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null && "status" in error) {
		const status = (error as { status?: number }).status;
		return typeof status === "number" ? status : undefined;
	}
	return undefined;
}

function getHeaders(error: unknown): Record<string, string> | null {
	if (
		typeof error === "object" &&
		error !== null &&
		"response" in error &&
		typeof (error as { response?: unknown }).response === "object" &&
		(error as { response?: { headers?: Record<string, string> } }).response
			?.headers
	) {
		return (error as { response?: { headers?: Record<string, string> } })
			.response?.headers as Record<string, string>;
	}
	return null;
}

function isSecondaryRateLimit(error: unknown): boolean {
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as { message?: string }).message === "string"
	) {
		return (error as { message: string }).message
			.toLowerCase()
			.includes("secondary rate limit");
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"response" in error &&
		typeof (error as { response?: unknown }).response === "object"
	) {
		const data = (error as { response?: { data?: { message?: string } } })
			.response?.data;
		if (data?.message) {
			return data.message.toLowerCase().includes("secondary rate limit");
		}
	}
	return false;
}

function jitterDelay(baseMs: number): number {
	const jitter = Math.floor(Math.random() * 500);
	return baseMs + jitter;
}
