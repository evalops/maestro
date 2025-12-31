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
	private readonly maxPayloadBytes = 5 * 1024 * 1024;
	private readonly deliveryTtlMs = 10 * 60 * 1000;
	private readonly deliveryCleanupIntervalMs = 60 * 1000;
	private readonly maxDeliveryCacheSize = 5000;
	private readonly maxEventAttempts = 3;
	private readonly eventRetryBaseDelayMs = 1000;
	private readonly eventRetryMaxDelayMs = 10_000;
	private lastDeliveryCleanupMs = 0;
	private readonly deliveryCache = new Map<string, number>();
	private readonly pendingEvents: Array<{
		id: string;
		name: string;
		payload: unknown;
		attempt: number;
	}> = [];
	private processingEvents = false;
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

		const contentLength = req.headers["content-length"];
		if (contentLength && typeof contentLength === "string") {
			const parsed = Number.parseInt(contentLength, 10);
			if (Number.isFinite(parsed) && parsed > this.maxPayloadBytes) {
				res.statusCode = 413;
				res.end("payload too large");
				return;
			}
		}

		let payload: string;
		try {
			payload = await readRequestBody(req, this.maxPayloadBytes);
		} catch (error) {
			const status = error instanceof PayloadTooLargeError ? 413 : 400;
			res.statusCode = status;
			res.end(error instanceof Error ? error.message : "invalid request");
			return;
		}

		const signatureValue = Array.isArray(signature) ? signature[0] : signature;
		const verified = await this.webhooks.verify(payload, signatureValue);
		if (!verified) {
			res.statusCode = 401;
			res.end("invalid signature");
			return;
		}

		let parsedPayload: unknown;
		try {
			parsedPayload = JSON.parse(payload);
		} catch {
			res.statusCode = 400;
			res.end("invalid json");
			return;
		}

		const deliveryId = Array.isArray(delivery) ? delivery[0] : delivery;
		if (deliveryId && this.isDuplicateDelivery(deliveryId)) {
			res.statusCode = 202;
			res.end("duplicate");
			return;
		}

		this.enqueueEvent({
			id: deliveryId || "",
			name: event,
			payload: parsedPayload,
			attempt: 0,
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

	private enqueueEvent(event: {
		id: string;
		name: string;
		payload: unknown;
		attempt: number;
	}) {
		this.pendingEvents.push(event);
		void this.processEvents();
	}

	private async processEvents(): Promise<void> {
		if (this.processingEvents) return;
		this.processingEvents = true;
		while (this.pendingEvents.length > 0) {
			const event = this.pendingEvents.shift();
			if (!event) continue;
			try {
				await this.webhooks.receive({
					id: event.id,
					name: event.name,
					payload: event.payload,
				});
			} catch (error) {
				this.handleEventError(event, error);
			}
		}
		this.processingEvents = false;
	}

	private handleEventError(
		event: { id: string; name: string; payload: unknown; attempt: number },
		error: unknown,
	): void {
		const attempt = event.attempt + 1;
		if (attempt >= this.maxEventAttempts) {
			console.error(
				`[webhook] event failed after ${attempt} attempts (${event.name}:${event.id})`,
				error,
			);
			return;
		}
		const delayMs = jitterDelay(
			Math.min(
				this.eventRetryBaseDelayMs * 2 ** (attempt - 1),
				this.eventRetryMaxDelayMs,
			),
			250,
		);
		console.warn(
			`[webhook] retrying event ${event.name}:${event.id} in ${delayMs}ms (attempt ${attempt})`,
		);
		setTimeout(() => {
			this.pendingEvents.push({ ...event, attempt });
			void this.processEvents();
		}, delayMs);
	}

	private isDuplicateDelivery(deliveryId: string): boolean {
		const now = Date.now();
		if (now - this.lastDeliveryCleanupMs > this.deliveryCleanupIntervalMs) {
			this.pruneDeliveryCache(now);
		}
		const seenAt = this.deliveryCache.get(deliveryId);
		if (seenAt && now - seenAt < this.deliveryTtlMs) {
			return true;
		}
		this.deliveryCache.set(deliveryId, now);
		if (this.deliveryCache.size > this.maxDeliveryCacheSize) {
			const overflow = this.deliveryCache.size - this.maxDeliveryCacheSize;
			let removed = 0;
			for (const key of this.deliveryCache.keys()) {
				this.deliveryCache.delete(key);
				removed += 1;
				if (removed >= overflow) break;
			}
		}
		return false;
	}

	private pruneDeliveryCache(now: number): void {
		for (const [key, timestamp] of this.deliveryCache) {
			if (now - timestamp > this.deliveryTtlMs) {
				this.deliveryCache.delete(key);
			}
		}
		this.lastDeliveryCleanupMs = now;
	}
}

class PayloadTooLargeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PayloadTooLargeError";
	}
}

async function readRequestBody(
	req: IncomingMessage,
	maxBytes: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				req.destroy();
				reject(new PayloadTooLargeError("payload too large"));
				return;
			}
			data += chunk.toString("utf8");
		});
		req.on("end", () => resolve(data));
		req.on("error", (err) => reject(err));
	});
}

function jitterDelay(baseMs: number, jitterMs: number): number {
	if (baseMs <= 0) return 0;
	const jitter = Math.floor(Math.random() * jitterMs);
	return baseMs + jitter;
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
	url?: string;
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
		apiUrl: issue.url,
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
