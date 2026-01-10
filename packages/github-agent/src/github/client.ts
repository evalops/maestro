import { Octokit } from "@octokit/rest";
import type {
	CheckRunSummary,
	GitHubIssue,
	GitHubPR,
	PRComment,
	PRReview,
	PRReviewThread,
} from "../types.js";
import {
	type GitHubAuth,
	type GitHubToken,
	resolveGitHubApiUrl,
	resolveGitHubGraphqlUrl,
} from "./auth.js";
import { getNextCursorFromLink, getNextPageFromLink } from "./pagination.js";
import { RequestScheduler } from "./request-scheduler.js";

export interface GitHubClientOptions {
	owner: string;
	repo: string;
	auth: GitHubAuth;
	apiUrl?: string;
	userAgent?: string;
	timeoutMs?: number;
	serializeRequests?: boolean;
	minMutationDelayMs?: number;
}

export interface GitHubRateLimitSnapshot {
	remaining: number;
	resetAt?: number;
	limit?: number;
	resource?: string;
}

export interface WebhookDelivery {
	id: number;
	guid: string;
	deliveredAt: string | null;
	status: string | null;
	statusCode: number | null;
	redelivery?: boolean;
	event?: string | null;
	action?: string | null;
}

type GitHubResponse<T> = {
	data: T | null;
	status: number;
	headers: Record<string, string>;
	notModified?: boolean;
};

type RequestOptions = {
	useEtag?: boolean;
	useConditional?: boolean;
};

type PaginateOptions = RequestOptions & {
	perPage?: number;
	maxPages?: number;
};

type GraphqlResponse<T> = T & {
	rateLimit?: GraphqlRateLimit;
};

type GraphqlRateLimit = {
	remaining: number;
	resetAt?: string;
	limit?: number;
	cost?: number;
};

class ConditionalCache {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly store = new Map<
		string,
		{ etag?: string; lastModified?: string; updatedAt: number }
	>();

	constructor(ttlMs = 5 * 60 * 1000, maxEntries = 1000) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	get(key: string): { etag?: string; lastModified?: string } | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.updatedAt > this.ttlMs) {
			this.store.delete(key);
			return undefined;
		}
		return { etag: entry.etag, lastModified: entry.lastModified };
	}

	set(key: string, value: { etag?: string; lastModified?: string }) {
		this.store.set(key, {
			etag: value.etag,
			lastModified: value.lastModified,
			updatedAt: Date.now(),
		});
		this.prune();
	}

	private prune() {
		const now = Date.now();
		for (const [cacheKey, entry] of this.store) {
			if (now - entry.updatedAt > this.ttlMs) {
				this.store.delete(cacheKey);
			}
		}

		if (this.store.size <= this.maxEntries) {
			return;
		}

		const entries = Array.from(this.store.entries()).sort(
			(a, b) => a[1].updatedAt - b[1].updatedAt,
		);
		for (const [oldest] of entries) {
			if (this.store.size <= this.maxEntries) {
				break;
			}
			this.store.delete(oldest);
		}
	}
}

class ResponseCache {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly store = new Map<
		string,
		{ data: unknown; updatedAt: number }
	>();

	constructor(ttlMs = 5 * 60 * 1000, maxEntries = 200) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	get<T>(key: string): T | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.updatedAt > this.ttlMs) {
			this.store.delete(key);
			return undefined;
		}
		return entry.data as T;
	}

	set<T>(key: string, data: T) {
		this.store.set(key, { data, updatedAt: Date.now() });
		this.prune();
	}

	private prune() {
		const now = Date.now();
		for (const [cacheKey, entry] of this.store) {
			if (now - entry.updatedAt > this.ttlMs) {
				this.store.delete(cacheKey);
			}
		}

		if (this.store.size <= this.maxEntries) {
			return;
		}

		const entries = Array.from(this.store.entries()).sort(
			(a, b) => a[1].updatedAt - b[1].updatedAt,
		);
		for (const [oldest] of entries) {
			if (this.store.size <= this.maxEntries) {
				break;
			}
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
	private readonly conditionalCache = new ConditionalCache();
	private readonly responseCache = new ResponseCache();
	private readonly scheduler: RequestScheduler;
	private cachedTokenType?: GitHubToken["type"];
	private rateLimit: GitHubRateLimitSnapshot = { remaining: 0 };
	private globalPauseUntil = 0;

	constructor(options: GitHubClientOptions) {
		this.owner = options.owner;
		this.repo = options.repo;
		this.auth = options.auth;
		const apiUrl = resolveGitHubApiUrl(options.apiUrl);
		this.graphqlUrl = resolveGitHubGraphqlUrl(apiUrl);
		this.userAgent = options.userAgent ?? "evalops-github-agent";
		this.scheduler = new RequestScheduler({
			serialize: options.serializeRequests ?? true,
			minMutationDelayMs: options.minMutationDelayMs ?? 1000,
		});
		this.octokit = new Octokit({
			baseUrl: apiUrl,
			userAgent: this.userAgent,
			request: { timeout: options.timeoutMs ?? 15_000 },
		});
	}

	getRateLimitSnapshot(): GitHubRateLimitSnapshot {
		return { ...this.rateLimit };
	}

	async supportsCheckRuns(): Promise<boolean> {
		if (this.cachedTokenType) {
			return this.cachedTokenType === "app";
		}
		const token = await this.auth.getToken();
		this.cachedTokenType = token.type;
		return token.type === "app";
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
			url: string;
			html_url: string;
			comments: number;
			node_id?: string;
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
				apiUrl: issue.url,
				nodeId: issue.node_id,
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

		const issueByNumber = new Map<number, GitHubIssue>();
		const issueByApiUrl = new Map<string, GitHubIssue>();
		for (const issue of await this.listIssuesUpdatedSince(since)) {
			issueByNumber.set(issue.number, issue);
			if (issue.apiUrl) {
				issueByApiUrl.set(issue.apiUrl, issue);
			}
		}

		const results: Array<{ issue: GitHubIssue; comment: PRComment }> = [];
		const missingIssues = new Set<number>();
		const entries: Array<{ issueNumber: number; comment: PRComment }> = [];
		for (const comment of comments) {
			const issueFromUrl = issueByApiUrl.get(comment.issue_url);
			const issueNumber =
				issueFromUrl?.number ?? extractIssueNumber(comment.issue_url);
			if (!issueNumber) continue;
			entries.push({
				issueNumber,
				comment: {
					id: comment.id,
					author: comment.user?.login || "unknown",
					body: comment.body,
					path: null,
					line: null,
					createdAt: comment.created_at,
				},
			});
			if (!issueByNumber.has(issueNumber)) {
				missingIssues.add(issueNumber);
			}
		}

		if (missingIssues.size > 0) {
			const missing = Array.from(missingIssues);
			const fetched = await this.fetchIssuesByNumber(missing);
			for (const issue of fetched) {
				issueByNumber.set(issue.number, issue);
			}

			const unresolved = missing.filter(
				(issueNumber) => !issueByNumber.has(issueNumber),
			);
			if (unresolved.length > 0) {
				const fallback = await Promise.all(
					unresolved.map((issueNumber) =>
						this.getIssue(issueNumber).catch(() => null),
					),
				);
				for (const issue of fallback) {
					if (issue) {
						issueByNumber.set(issue.number, issue);
					}
				}
			}
		}

		for (const entry of entries) {
			const issue = issueByNumber.get(entry.issueNumber);
			if (!issue) continue;
			results.push({ issue, comment: entry.comment });
		}
		return results;
	}

	private async fetchIssuesByNumber(
		issueNumbers: number[],
	): Promise<GitHubIssue[]> {
		const unique = Array.from(new Set(issueNumbers)).filter(
			(number) => Number.isFinite(number) && number > 0,
		);
		if (unique.length === 0) return [];

		const results: GitHubIssue[] = [];
		for (const batch of chunkArray(unique, 40)) {
			const queryParts: string[] = [];
			const variableDefs: string[] = ["$owner: String!", "$repo: String!"];
			const variables: Record<string, unknown> = {
				owner: this.owner,
				repo: this.repo,
			};

			batch.forEach((issueNumber, index) => {
				const alias = `issue${index}`;
				const variableName = `n${index}`;
				queryParts.push(
					`${alias}: issue(number: $${variableName}) { id number title body state url createdAt updatedAt author { login } labels(first: 100) { nodes { name } } comments { totalCount } }`,
				);
				variableDefs.push(`$${variableName}: Int!`);
				variables[variableName] = issueNumber;
			});

			const query = `
        query(${variableDefs.join(", ")}) {
          repository(owner: $owner, name: $repo) {
            ${queryParts.join("\n")}
          }
          rateLimit {
            limit
            cost
            remaining
            resetAt
          }
        }
      `;

			type GraphqlIssue = {
				id: string;
				number: number;
				title: string;
				body: string | null;
				state: "OPEN" | "CLOSED";
				url: string;
				createdAt: string;
				updatedAt: string;
				author: { login: string } | null;
				labels: { nodes: Array<{ name: string } | null> } | null;
				comments: { totalCount: number } | null;
			};

			try {
				const data = await this.graphqlRequest<
					GraphqlResponse<{
						repository: Record<string, GraphqlIssue | null>;
						rateLimit?: {
							remaining: number;
							resetAt: string;
							limit?: number;
							cost?: number;
						};
					}>
				>(query, variables, { mutating: false });

				if (data.rateLimit) {
					this.captureGraphqlRateLimit(data.rateLimit);
				}

				for (const issue of Object.values(data.repository)) {
					if (!issue) continue;
					const labels =
						issue.labels?.nodes
							?.map((label) => label?.name)
							.filter((label): label is string => Boolean(label)) ?? [];
					results.push({
						nodeId: issue.id,
						number: issue.number,
						title: issue.title,
						body: issue.body,
						labels,
						state: issue.state === "OPEN" ? "open" : "closed",
						author: issue.author?.login || "unknown",
						createdAt: issue.createdAt,
						updatedAt: issue.updatedAt,
						url: issue.url,
						comments: issue.comments?.totalCount ?? 0,
					});
				}
			} catch (error) {
				console.warn(
					"[github-client] GraphQL batch fetch failed; continuing with next batch and REST fallback.",
					error,
				);
			}
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
			url: string;
			html_url: string;
			comments: number;
			node_id?: string;
		}>(
			"GET /repos/{owner}/{repo}/issues/{issue_number}",
			{
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
			},
			{ useEtag: true },
		);
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
			apiUrl: data.url,
			nodeId: data.node_id,
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
			head: { ref: string; sha: string };
			base: { ref: string };
			created_at: string;
			updated_at: string;
			merged_at: string | null;
			html_url: string;
			node_id?: string;
		}>(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}",
			{
				owner: this.owner,
				repo: this.repo,
				pull_number: prNumber,
			},
			{ useEtag: true },
		);
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
			headSha: data.head.sha,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			mergedAt: data.merged_at,
			url: data.html_url,
			reviewDecision: null,
			nodeId: data.node_id ?? null,
		};
	}

	async listPullRequestReviews(prNumber: number): Promise<PRReview[]> {
		const reviews = await this.paginate<{
			id: number;
			user: { login: string } | null;
			state: PRReview["state"];
			body: string | null;
			submitted_at: string | null;
		}>(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner: this.owner,
				repo: this.repo,
				pull_number: prNumber,
			},
			{ useEtag: true },
		);
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
		}>(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
			{
				owner: this.owner,
				repo: this.repo,
				pull_number: prNumber,
				since,
			},
			{ useEtag: true },
		);
		return comments.map((comment) => ({
			id: comment.id,
			author: comment.user?.login || "unknown",
			body: comment.body,
			path: comment.path ?? null,
			line: comment.line ?? null,
			createdAt: comment.created_at,
		}));
	}

	async listPullRequestReviewThreads(
		prNumber: number,
		options: { maxThreads?: number; maxCommentsPerThread?: number } = {},
	): Promise<PRReviewThread[]> {
		type ReviewThreadComment = {
			id: string;
			body: string;
			createdAt: string;
			author: { login: string } | null;
		};
		type ReviewThreadNode = {
			id: string;
			isResolved: boolean;
			path: string;
			line: number | null;
			comments: {
				nodes: Array<ReviewThreadComment | null>;
			};
		};
		type ReviewThreadsResponse = GraphqlResponse<{
			repository: {
				pullRequest: {
					reviewThreads: {
						nodes: Array<ReviewThreadNode | null>;
						pageInfo: {
							hasNextPage: boolean;
							endCursor: string | null;
						};
					};
				} | null;
			};
		}>;

		const maxThreads = options.maxThreads ?? 50;
		const maxCommentsPerThread = options.maxCommentsPerThread ?? 50;
		const results: PRReviewThread[] = [];
		let cursor: string | null = null;
		let remaining = maxThreads;

		while (remaining > 0) {
			const pageSize = Math.min(remaining, 50);
			try {
				const data: ReviewThreadsResponse =
					await this.graphqlRequest<ReviewThreadsResponse>(
						`
          query($owner: String!, $repo: String!, $number: Int!, $threads: Int!, $comments: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewThreads(first: $threads, after: $after) {
                  nodes {
                    id
                    isResolved
                    path
                    line
                    comments(first: $comments) {
                      nodes {
                        id
                        body
                        createdAt
                        author { login }
                      }
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
            rateLimit {
              limit
              cost
              remaining
              resetAt
            }
          }
        `,
						{
							owner: this.owner,
							repo: this.repo,
							number: prNumber,
							threads: pageSize,
							comments: maxCommentsPerThread,
							after: cursor,
						},
						{ mutating: false },
					);

				if (data.rateLimit) {
					this.captureGraphqlRateLimit(data.rateLimit);
				}

				const threads = data.repository.pullRequest?.reviewThreads;
				if (!threads) {
					return results;
				}
				for (const thread of threads.nodes ?? []) {
					if (!thread?.path) continue;
					results.push({
						id: thread.id,
						isResolved: thread.isResolved,
						path: thread.path,
						line: thread.line ?? null,
						comments:
							thread.comments.nodes
								?.filter((comment): comment is ReviewThreadComment =>
									Boolean(comment),
								)
								.map((comment) => ({
									id: comment.id,
									body: comment.body,
									createdAt: comment.createdAt,
									author: comment.author?.login || "unknown",
								})) ?? [],
					});
				}

				const nodeCount = threads.nodes?.length ?? 0;
				remaining -= nodeCount;
				if (!threads.pageInfo.hasNextPage) {
					break;
				}
				if (nodeCount === 0 && !threads.pageInfo.endCursor) {
					break;
				}
				cursor = threads.pageInfo.endCursor;
			} catch (error) {
				console.warn(
					"[github-client] GraphQL review thread fetch failed; returning partial results.",
					error,
				);
				break;
			}
		}

		return results;
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

	async findOpenPullRequestByBranch(
		branch: string,
	): Promise<{ number: number; url: string } | null> {
		const head = `${this.owner}:${branch}`;
		const { data } = await this.request<
			{
				number: number;
				html_url: string;
				state: string;
			}[]
		>(
			"GET /repos/{owner}/{repo}/pulls",
			{
				owner: this.owner,
				repo: this.repo,
				state: "open",
				head,
			},
			{ useEtag: true },
		);
		if (!data || data.length === 0) {
			return null;
		}
		const pr = data[0];
		return { number: pr.number, url: pr.html_url };
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

	async requestReviewers(input: {
		pullNumber: number;
		reviewers?: string[];
		teamReviewers?: string[];
	}): Promise<void> {
		if (!input.reviewers?.length && !input.teamReviewers?.length) {
			return;
		}
		await this.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
			{
				owner: this.owner,
				repo: this.repo,
				pull_number: input.pullNumber,
				reviewers: input.reviewers,
				team_reviewers: input.teamReviewers,
			},
		);
	}

	async enableAutoMerge(input: {
		pullRequestId: string;
		mergeMethod?: MergeMethod;
		commitHeadline?: string;
		commitBody?: string;
		expectedHeadOid?: string;
	}): Promise<void> {
		const mergeMethod = toGraphqlMergeMethod(input.mergeMethod ?? "squash");
		const data = await this.graphqlRequest<
			GraphqlResponse<{
				enablePullRequestAutoMerge: {
					pullRequest: { id: string } | null;
				} | null;
				rateLimit?: {
					remaining: number;
					resetAt: string;
					limit?: number;
					cost?: number;
				};
			}>
		>(
			`
        mutation($input: EnablePullRequestAutoMergeInput!) {
          enablePullRequestAutoMerge(input: $input) {
            pullRequest { id }
          }
          rateLimit {
            limit
            cost
            remaining
            resetAt
          }
        }
      `,
			{
				input: {
					pullRequestId: input.pullRequestId,
					mergeMethod,
					commitHeadline: input.commitHeadline,
					commitBody: input.commitBody,
					expectedHeadOid: input.expectedHeadOid,
				},
			},
			{ mutating: true },
		);
		if (data.rateLimit) {
			this.captureGraphqlRateLimit(data.rateLimit);
		}
	}

	async enqueuePullRequest(input: {
		pullRequestId: string;
		expectedHeadOid?: string;
		jump?: boolean;
	}): Promise<void> {
		const data = await this.graphqlRequest<
			GraphqlResponse<{
				enqueuePullRequest: {
					mergeQueueEntry: { id: string } | null;
				} | null;
				rateLimit?: {
					remaining: number;
					resetAt: string;
					limit?: number;
					cost?: number;
				};
			}>
		>(
			`
        mutation($input: EnqueuePullRequestInput!) {
          enqueuePullRequest(input: $input) {
            mergeQueueEntry { id }
          }
          rateLimit {
            limit
            cost
            remaining
            resetAt
          }
        }
      `,
			{
				input: {
					pullRequestId: input.pullRequestId,
					expectedHeadOid: input.expectedHeadOid,
					jump: input.jump,
				},
			},
			{ mutating: true },
		);
		if (data.rateLimit) {
			this.captureGraphqlRateLimit(data.rateLimit);
		}
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

	async listCheckRunsForRef(ref: string): Promise<CheckRunSummary[]> {
		const { data } = await this.request<{
			check_runs: Array<{
				id: number;
				name: string;
				status: CheckRunSummary["status"];
				conclusion: CheckRunSummary["conclusion"];
				details_url: string | null;
				started_at: string | null;
				completed_at: string | null;
			}>;
		}>(
			"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
			{
				owner: this.owner,
				repo: this.repo,
				ref,
				per_page: 100,
				filter: "latest",
			},
			{ useEtag: true },
		);
		if (!data?.check_runs?.length) {
			return [];
		}
		return data.check_runs.map((run) => ({
			id: run.id,
			name: run.name,
			status: run.status,
			conclusion: run.conclusion ?? null,
			detailsUrl: run.details_url ?? null,
			startedAt: run.started_at ?? null,
			completedAt: run.completed_at ?? null,
		}));
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
			| "action_required"
			| null;
		detailsUrl?: string;
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
				details_url: input.detailsUrl,
				output: input.summary
					? { title: "GitHub Agent", summary: input.summary, text: input.text }
					: undefined,
			},
		);
	}

	async listWebhookDeliveries(input: {
		hookId: number;
		cursor?: string;
		perPage?: number;
	}): Promise<{ deliveries: WebhookDelivery[]; nextCursor?: string | null }> {
		type DeliveryResponse = {
			id: number;
			guid: string;
			delivered_at: string | null;
			status?: string | null;
			status_code?: number | null;
			redelivery?: boolean;
			event?: string | null;
			action?: string | null;
		};
		const { data, headers } = await this.request<DeliveryResponse[]>(
			"GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries",
			{
				owner: this.owner,
				repo: this.repo,
				hook_id: input.hookId,
				per_page: input.perPage ?? 50,
				cursor: input.cursor,
			},
		);
		const deliveries =
			data?.map((delivery) => ({
				id: delivery.id,
				guid: delivery.guid,
				deliveredAt: delivery.delivered_at ?? null,
				status: delivery.status ?? null,
				statusCode: delivery.status_code ?? null,
				redelivery: delivery.redelivery,
				event: delivery.event ?? null,
				action: delivery.action ?? null,
			})) ?? [];
		const nextCursor = getNextCursorFromLink(
			headers?.link ?? headers?.Link ?? null,
		);
		return { deliveries, nextCursor };
	}

	async redeliverWebhookDelivery(
		hookId: number,
		deliveryId: number,
	): Promise<void> {
		await this.request(
			"POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts",
			{
				owner: this.owner,
				repo: this.repo,
				hook_id: hookId,
				delivery_id: deliveryId,
			},
		);
	}

	private async request<T>(
		endpoint: string,
		params: Record<string, unknown>,
		options: RequestOptions = {},
	): Promise<GitHubResponse<T>> {
		const method = endpoint.split(" ")[0]?.toUpperCase() ?? "GET";
		const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
		const shouldUseConditional =
			options.useConditional ?? options.useEtag ?? false;
		const cacheKey = shouldUseConditional
			? this.buildEtagKey(endpoint, params)
			: null;
		let bypassConditional = false;

		for (let attempt = 0; attempt <= 5; attempt += 1) {
			await this.awaitGlobalPause();
			const token = await this.auth.getToken();
			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": this.userAgent,
				Authorization:
					token.type === "app"
						? `Bearer ${token.token}`
						: `token ${token.token}`,
			};

			if (cacheKey && !bypassConditional) {
				const conditional = this.conditionalCache.get(cacheKey);
				if (conditional?.etag) {
					headers["If-None-Match"] = conditional.etag;
				}
				if (conditional?.lastModified) {
					headers["If-Modified-Since"] = conditional.lastModified;
				}
			}

			try {
				const response = await this.scheduler.schedule(
					() =>
						this.octokit.request(endpoint, {
							...params,
							headers,
						}) as Promise<{
							data: T;
							status: number;
							headers: Record<string, string | number | undefined>;
						}>,
					{ mutating: isMutation },
				);
				this.captureRateLimit(response.headers);
				if (cacheKey) {
					const rawEtag = response.headers.etag;
					const rawLastModified = response.headers["last-modified"];
					const etag = typeof rawEtag === "string" ? rawEtag : undefined;
					const lastModified =
						typeof rawLastModified === "string" ? rawLastModified : undefined;
					if (etag || lastModified) {
						this.conditionalCache.set(cacheKey, {
							etag,
							lastModified,
						});
					}
					if (response.data !== null) {
						this.responseCache.set(cacheKey, response.data);
					}
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
					let cachedData: T | null = null;
					if (cacheKey) {
						const cached = this.conditionalCache.get(cacheKey);
						const etag = responseHeaders?.etag ?? cached?.etag;
						const lastModified =
							responseHeaders?.["last-modified"] ?? cached?.lastModified;
						if (etag || lastModified) {
							this.conditionalCache.set(cacheKey, {
								etag,
								lastModified,
							});
						}
						const cachedResponse = this.responseCache.get<T>(cacheKey);
						if (cachedResponse) {
							cachedData = cachedResponse;
							this.responseCache.set(cacheKey, cachedResponse);
						} else if (!bypassConditional) {
							// Retry once without conditional headers to repopulate cache.
							bypassConditional = true;
							continue;
						}
					}
					return {
						data: cachedData,
						status,
						headers: responseHeaders ?? {},
						notModified: true,
					};
				}
				this.captureRateLimit(responseHeaders);
				const retryDelay = this.getRetryDelayMs(
					error,
					status,
					responseHeaders,
					attempt,
				);
				if (
					retryDelay !== null &&
					status &&
					(status === 403 || status === 429)
				) {
					this.applyGlobalPause(retryDelay);
				}
				if (retryDelay === null || attempt >= 5) {
					throw error;
				}
				await wait(retryDelay);
			}
		}

		throw new Error("GitHub request failed after retries");
	}

	private async paginate<T>(
		endpoint: string,
		params: Record<string, unknown>,
		options: PaginateOptions = {},
	): Promise<T[]> {
		const perPage = options.perPage ?? 100;
		const maxPages = options.maxPages ?? 200;
		const useConditional = options.useConditional ?? options.useEtag ?? false;
		const results: T[] = [];
		let page = 1;
		for (let pagesFetched = 0; pagesFetched < maxPages; pagesFetched += 1) {
			const requestParams = { ...params, per_page: perPage, page };
			const cacheKey = useConditional
				? this.buildEtagKey(endpoint, requestParams)
				: null;
			const response = await this.request<T[]>(
				endpoint,
				requestParams,
				options,
			);
			if (response.notModified && cacheKey) {
				const cached = this.responseCache.get<T[]>(cacheKey);
				if (cached) {
					results.push(...cached);
					const nextPage = getNextPageFromLink(
						response.headers?.link ?? response.headers?.Link,
					);
					if (nextPage) {
						page = nextPage;
						continue;
					}
					if (cached.length < perPage) {
						break;
					}
					page += 1;
					continue;
				}
				const fallback = await this.request<T[]>(endpoint, requestParams, {
					...options,
					useEtag: false,
					useConditional: false,
				});
				if (fallback.notModified) {
					return results;
				}
				const fallbackData = fallback.data ?? [];
				results.push(...fallbackData);
				const nextPage = getNextPageFromLink(
					fallback.headers?.link ?? fallback.headers?.Link,
				);
				if (cacheKey) {
					const etag = fallback.headers?.etag;
					const lastModified = fallback.headers?.["last-modified"];
					if (etag || lastModified) {
						this.conditionalCache.set(cacheKey, {
							etag,
							lastModified,
						});
					}
					this.responseCache.set(cacheKey, fallbackData);
				}
				if (nextPage) {
					page = nextPage;
					continue;
				}
				if (fallbackData.length < perPage) {
					break;
				}
				page += 1;
				continue;
			}
			const data = response.data ?? [];
			results.push(...data);
			const nextPage = getNextPageFromLink(
				response.headers?.link ?? response.headers?.Link,
			);
			if (nextPage) {
				page = nextPage;
				continue;
			}
			if (data.length < perPage) {
				break;
			}
			page += 1;
		}
		return results;
	}

	private async graphqlRequest<T>(
		query: string,
		variables: Record<string, unknown>,
		options: { mutating?: boolean } = {},
	): Promise<T> {
		for (let attempt = 0; attempt <= 5; attempt += 1) {
			await this.awaitGlobalPause();
			const token = await this.auth.getToken();
			const headers = {
				Authorization:
					token.type === "app"
						? `Bearer ${token.token}`
						: `token ${token.token}`,
				"User-Agent": this.userAgent,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};
			try {
				return await this.scheduler.schedule(
					() =>
						this.octokit.graphql<T>(query, {
							...variables,
							headers,
							uri: this.graphqlUrl,
						}),
					{ mutating: options.mutating ?? false },
				);
			} catch (error) {
				const status = getStatus(error);
				const responseHeaders = getHeaders(error);
				this.captureRateLimit(responseHeaders);
				const retryDelay = this.getRetryDelayMs(
					error,
					status,
					responseHeaders,
					attempt,
				);
				if (
					retryDelay !== null &&
					status &&
					(status === 403 || status === 429)
				) {
					this.applyGlobalPause(retryDelay);
				}
				if (retryDelay === null || attempt >= 5) {
					throw error;
				}
				await wait(retryDelay);
			}
		}

		throw new Error("GitHub GraphQL request failed after retries");
	}

	private async queryPullRequestGraphql(
		prNumber: number,
	): Promise<GitHubPR | null> {
		try {
			const data = await this.graphqlRequest<
				GraphqlResponse<{
					repository: {
						pullRequest: {
							id: string;
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
							headRefOid: string;
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
						limit?: number;
						cost?: number;
					};
				}>
			>(
				`
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              id
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
              headRefOid
              baseRefName
              reviewDecision
              author { login }
            }
          }
          rateLimit {
            limit
            cost
            remaining
            resetAt
          }
        }
      `,
				{
					owner: this.owner,
					repo: this.repo,
					number: prNumber,
				},
				{ mutating: false },
			);
			const pr = data.repository.pullRequest;
			if (!pr) return null;
			if (data.rateLimit) {
				this.captureGraphqlRateLimit(data.rateLimit);
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
				headSha: pr.headRefOid,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				mergedAt: pr.mergedAt,
				url: pr.url,
				reviewDecision: pr.reviewDecision,
				nodeId: pr.id,
			};
		} catch {
			return null;
		}
	}

	private captureGraphqlRateLimit(rateLimit?: GraphqlRateLimit): void {
		if (!rateLimit) return;
		this.rateLimit = {
			remaining: rateLimit.remaining,
			limit: rateLimit.limit ?? undefined,
			resetAt: rateLimit.resetAt ? Date.parse(rateLimit.resetAt) : undefined,
			resource: "graphql",
		};
	}

	private captureRateLimit(
		headers?: Record<string, string | number | undefined> | null,
	): void {
		if (!headers) return;
		const remaining = parseNumber(headers["x-ratelimit-remaining"]);
		const limit = parseNumber(headers["x-ratelimit-limit"]);
		const reset = parseNumber(headers["x-ratelimit-reset"]);
		const rawResource = headers["x-ratelimit-resource"];
		const resource = typeof rawResource === "string" ? rawResource : undefined;
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
		headers: Record<string, string> | null | undefined,
		attempt: number,
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
				const baseDelay = Math.max(60_000, 60_000 * 2 ** attempt);
				return jitterDelay(Math.min(baseDelay, 15 * 60_000));
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

	private applyGlobalPause(delayMs: number): void {
		if (delayMs <= 0) return;
		const until = Date.now() + delayMs;
		if (until > this.globalPauseUntil) {
			this.globalPauseUntil = until;
		}
	}

	private async awaitGlobalPause(): Promise<void> {
		const now = Date.now();
		if (now >= this.globalPauseUntil) return;
		await wait(this.globalPauseUntil - now);
	}
}

type MergeMethod = "merge" | "squash" | "rebase";
type GraphqlMergeMethod = "MERGE" | "SQUASH" | "REBASE";

function toGraphqlMergeMethod(method: MergeMethod): GraphqlMergeMethod {
	switch (method) {
		case "merge":
			return "MERGE";
		case "rebase":
			return "REBASE";
		default:
			return "SQUASH";
	}
}

function chunkArray<T>(items: T[], size: number): T[][] {
	if (items.length === 0 || size <= 0) return [];
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

function extractIssueNumber(issueUrl: string): number | null {
	const match = issueUrl.match(/\/issues\/(\d+)/);
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseNumber(value?: string | number | null): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") return value;
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
		const message = (error as { message: string }).message.toLowerCase();
		return (
			message.includes("secondary rate limit") ||
			message.includes("abuse detection")
		);
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
			const message = data.message.toLowerCase();
			return (
				message.includes("secondary rate limit") ||
				message.includes("abuse detection")
			);
		}
	}
	return false;
}

function jitterDelay(baseMs: number): number {
	const jitter = Math.floor(Math.random() * 500);
	return baseMs + jitter;
}

function wait(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
