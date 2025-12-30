import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { Webhooks } from "@octokit/webhooks";
import type {
	AgentConfig,
	CheckRunEvent,
	GitHubIssue,
	GitHubPR,
	IssueComment,
	PRComment,
	PRReview,
} from "../types.js";

export interface WebhookHandlers {
	onNewIssue: (issue: GitHubIssue) => Promise<void>;
	onIssueComment?: (issue: GitHubIssue, comment: IssueComment) => Promise<void>;
	onPRMerged: (pr: GitHubPR) => Promise<void>;
	onPRClosed: (pr: GitHubPR) => Promise<void>;
	onPRReview: (pr: GitHubPR, review: PRReview) => Promise<void>;
	onPRComment: (pr: GitHubPR, comment: PRComment) => Promise<void>;
	onCheckRunRerequested?: (checkRun: CheckRunEvent) => Promise<void>;
}

export interface WebhookServerOptions {
	config: AgentConfig;
	handlers: WebhookHandlers;
	secret: string;
	port: number;
	path: string;
}

export class GitHubWebhookServer {
	private readonly config: AgentConfig;
	private readonly handlers: WebhookHandlers;
	private readonly webhooks: Webhooks;
	private readonly port: number;
	private readonly path: string;
	private server?: ReturnType<typeof createServer>;

	constructor(options: WebhookServerOptions) {
		this.config = options.config;
		this.handlers = options.handlers;
		this.webhooks = new Webhooks({
			secret: options.secret,
			userAgent: "evalops-github-agent",
		});
		this.port = options.port;
		this.path = options.path.startsWith("/")
			? options.path
			: `/${options.path}`;
		this.registerHandlers();
	}

	async start(): Promise<void> {
		if (this.server) return;
		this.server = createServer((req, res) => {
			this.handleRequest(req, res).catch((err) => {
				console.error("[webhook] handler error:", err);
				res.statusCode = 500;
				res.end("internal error");
			});
		});
		await new Promise<void>((resolve) => {
			this.server?.listen(this.port, resolve);
		});
		console.log(
			`[webhook] Listening on http://localhost:${this.port}${this.path}`,
		);
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		this.server = undefined;
		console.log("[webhook] Stopped");
	}

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		if (!req.url || !req.method) {
			res.statusCode = 400;
			res.end("invalid request");
			return;
		}
		if (req.method !== "POST" || !req.url.startsWith(this.path)) {
			res.statusCode = 404;
			res.end("not found");
			return;
		}
		const signature =
			req.headers["x-hub-signature-256"] ?? req.headers["x-hub-signature"];
		const event = req.headers["x-github-event"];
		const delivery = req.headers["x-github-delivery"] ?? "";
		if (!signature || typeof signature !== "string") {
			res.statusCode = 400;
			res.end("missing signature");
			return;
		}
		if (!event || typeof event !== "string") {
			res.statusCode = 400;
			res.end("missing event");
			return;
		}

		const payload = await readRequestBody(req);
		await this.webhooks.verifyAndReceive({
			id: Array.isArray(delivery) ? delivery[0] : delivery,
			name: event,
			signature,
			payload,
		});
		res.statusCode = 202;
		res.end("ok");
	}

	private registerHandlers(): void {
		this.webhooks.on("issues.labeled", async ({ payload }) => {
			if (payload.issue.state !== "open") return;
			const labels = payload.issue.labels.map((l) => l.name ?? "");
			if (!matchesAnyLabel(labels, this.config.issueLabels)) return;
			await this.handlers.onNewIssue(toIssue(payload.issue));
		});

		this.webhooks.on("issues.opened", async ({ payload }) => {
			const labels = payload.issue.labels.map((l) => l.name ?? "");
			if (!matchesAnyLabel(labels, this.config.issueLabels)) return;
			await this.handlers.onNewIssue(toIssue(payload.issue));
		});

		this.webhooks.on("issue_comment.created", async ({ payload }) => {
			if (!this.handlers.onIssueComment) return;
			await this.handlers.onIssueComment(toIssue(payload.issue), {
				id: payload.comment.id,
				issueNumber: payload.issue.number,
				author: payload.comment.user?.login ?? "unknown",
				body: payload.comment.body ?? "",
				createdAt: payload.comment.created_at,
				url: payload.comment.html_url,
			});
		});

		this.webhooks.on("pull_request.closed", async ({ payload }) => {
			const pr = toPullRequest(payload.pull_request);
			if (payload.pull_request.merged) {
				await this.handlers.onPRMerged(pr);
				return;
			}
			await this.handlers.onPRClosed(pr);
		});

		this.webhooks.on("pull_request_review.submitted", async ({ payload }) => {
			const pr = toPullRequest(payload.pull_request);
			const reviewState = payload.review.state as PRReview["state"];
			await this.handlers.onPRReview(pr, {
				id: payload.review.id,
				author: payload.review.user?.login ?? "unknown",
				state: reviewState,
				body: payload.review.body,
				submittedAt: payload.review.submitted_at ?? new Date().toISOString(),
			});
		});

		this.webhooks.on(
			"pull_request_review_comment.created",
			async ({ payload }) => {
				const pr = toPullRequest(payload.pull_request);
				await this.handlers.onPRComment(pr, {
					id: payload.comment.id,
					author: payload.comment.user?.login ?? "unknown",
					body: payload.comment.body,
					path: payload.comment.path ?? null,
					line: payload.comment.line ?? null,
					createdAt: payload.comment.created_at,
				});
			},
		);

		this.webhooks.on("check_run.rerequested", async ({ payload }) => {
			if (!this.handlers.onCheckRunRerequested) return;
			const pullRequests = payload.check_run.pull_requests ?? [];
			const event: CheckRunEvent = {
				id: payload.check_run.id,
				name: payload.check_run.name,
				headSha: payload.check_run.head_sha,
				pullRequests: pullRequests
					.map((pr) => pr.number)
					.filter((number): number is number => typeof number === "number"),
			};
			await this.handlers.onCheckRunRerequested(event);
		});
	}
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk.toString("utf8");
		});
		req.on("end", () => resolve(data));
		req.on("error", (err) => reject(err));
	});
}

function matchesAnyLabel(labels: string[], targets: string[]): boolean {
	const normalized = labels.map((label) => label.toLowerCase());
	return targets.some((label) => normalized.includes(label.toLowerCase()));
}

function toIssue(issue: {
	number: number;
	title: string;
	body: string | null;
	labels: Array<{ name?: string | null }>;
	state: "open" | "closed";
	user: { login?: string | null } | null;
	created_at: string;
	updated_at: string;
	html_url: string;
	comments: number;
}): GitHubIssue {
	return {
		number: issue.number,
		title: issue.title,
		body: issue.body ?? null,
		labels: issue.labels.map((label) => label.name ?? "").filter(Boolean),
		state: issue.state,
		author: issue.user?.login ?? "unknown",
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
		url: issue.html_url,
		comments: issue.comments,
	};
}

function toPullRequest(pr: {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	merged: boolean;
	user: { login?: string | null } | null;
	head: { ref: string; sha: string };
	base: { ref: string };
	created_at: string;
	updated_at: string;
	merged_at: string | null;
	html_url: string;
}): GitHubPR {
	const state = pr.state === "closed" && pr.merged ? "merged" : pr.state;
	return {
		number: pr.number,
		title: pr.title,
		body: pr.body,
		state,
		author: pr.user?.login ?? "unknown",
		branch: pr.head.ref,
		base: pr.base.ref,
		headSha: pr.head.sha,
		createdAt: pr.created_at,
		updatedAt: pr.updated_at,
		mergedAt: pr.merged_at,
		url: pr.html_url,
		reviewDecision: null,
	};
}
