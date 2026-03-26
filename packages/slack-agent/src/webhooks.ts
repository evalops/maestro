/**
 * Webhook Ingestion Server
 *
 * Receives webhook events from external services (GitHub, Stripe, Linear, etc.)
 * and routes them to the appropriate Slack channel via a callback.
 *
 * Endpoints:
 *   POST /webhooks/:source     - Receive webhook payload from any source
 *   GET  /webhooks/health      - Health check
 *
 * Each source maps to a handler that extracts a summary and optional channel routing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import * as logger from "./logger.js";

export interface WebhookEvent {
	teamId: string;
	source: string;
	summary: string;
	data: unknown;
	channel?: string;
	timestamp: string;
}

export type WebhookCallback = (event: WebhookEvent) => Promise<void>;

export interface WebhookServerConfig {
	port: number;
	/** Secret used to verify webhook signatures (optional per-source) */
	secrets?: Record<string, string>;
	/** Default Slack workspace/team ID to use for legacy /webhooks/:source routes */
	defaultTeamId?: string;
	/** Default Slack channel to post unrouted events to */
	defaultChannel?: string;
	/** Max request body size in bytes (default: 1MB) */
	maxBodySize?: number;
}

export interface WebhookServerInstance {
	start(): Promise<void>;
	stop(): Promise<void>;
	port: number;
}

/**
 * Built-in source handlers that extract a human-readable summary from webhook payloads.
 */
type SourceHandler = (body: Record<string, unknown>) => {
	summary: string;
	channel?: string;
};

type SourceHandlers = Record<string, SourceHandler> & {
	generic: SourceHandler;
};

const sourceHandlers: SourceHandlers = {
	github: (body) => {
		const action = body.action ?? "event";
		const repo =
			(body.repository as Record<string, unknown>)?.full_name ?? "unknown";
		if (body.pull_request) {
			const pr = body.pull_request as Record<string, unknown>;
			return {
				summary: `GitHub PR ${action}: ${pr.title} (#${pr.number}) in ${repo}`,
			};
		}
		if (body.issue) {
			const issue = body.issue as Record<string, unknown>;
			return {
				summary: `GitHub issue ${action}: ${issue.title} (#${issue.number}) in ${repo}`,
			};
		}
		if (body.ref && body.commits) {
			const commits = body.commits as unknown[];
			return {
				summary: `GitHub push: ${commits.length} commit(s) to ${body.ref} in ${repo}`,
			};
		}
		return { summary: `GitHub ${action} event in ${repo}` };
	},

	stripe: (body) => {
		const type = String(body.type ?? "event");
		const obj = (body.data as Record<string, unknown>)?.object as
			| Record<string, unknown>
			| undefined;
		const amount = obj?.amount
			? ` ($${(Number(obj.amount) / 100).toFixed(2)})`
			: "";
		return { summary: `Stripe: ${type}${amount}` };
	},

	linear: (body) => {
		const action = body.action ?? "event";
		const type = body.type ?? "Issue";
		const data = body.data as Record<string, unknown> | undefined;
		const title = data?.title ?? "";
		const identifier = data?.identifier ?? "";
		return {
			summary: `Linear ${type} ${action}: ${identifier} ${title}`.trim(),
		};
	},

	generic: (body) => {
		const event = body.event ?? body.type ?? body.action ?? "webhook";
		return { summary: `Webhook: ${String(event)}` };
	},
};

export function createWebhookServer(
	config: WebhookServerConfig,
	callback: WebhookCallback,
): WebhookServerInstance {
	const maxBody = config.maxBodySize ?? 1024 * 1024;

	const server = createServer(
		async (req: IncomingMessage, res: ServerResponse) => {
			try {
				if (req.method === "GET" && req.url === "/webhooks/health") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ status: "ok" }));
					return;
				}

				if (req.method !== "POST" || !req.url?.startsWith("/webhooks/")) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}

				const parts = req.url.split("/").filter(Boolean);
				// /webhooks/:teamId/:source (preferred)
				// /webhooks/:source (legacy single-workspace)
				let teamId = "";
				let source = "generic";

				if (parts.length >= 3) {
					teamId = parts[1] ?? "";
					source = parts[2] ?? "generic";
				} else if (parts.length === 2) {
					source = parts[1] ?? "generic";
					teamId = config.defaultTeamId ?? "";
					if (!teamId) {
						res.writeHead(400);
						res.end("Missing teamId. Use /webhooks/:teamId/:source.");
						return;
					}
				} else {
					res.writeHead(404);
					res.end("Not found");
					return;
				}

				const bodyBuf = await readBody(req, maxBody);
				if (!bodyBuf) {
					res.writeHead(413);
					res.end("Payload too large");
					return;
				}

				const secret = config.secrets?.[source];
				if (secret) {
					const valid = verifySignature(req, bodyBuf, secret, source);
					if (!valid) {
						res.writeHead(401);
						res.end("Invalid signature");
						return;
					}
				}

				let body: Record<string, unknown>;
				try {
					body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;
				} catch {
					res.writeHead(400);
					res.end("Invalid JSON");
					return;
				}

				const handler = sourceHandlers[source] ?? sourceHandlers.generic;
				const { summary, channel } = handler(body);

				const event: WebhookEvent = {
					teamId,
					source,
					summary,
					data: body,
					channel: channel ?? config.defaultChannel,
					timestamp: new Date().toISOString(),
				};

				await callback(event);

				logger.logInfo(`Webhook received: ${source} - ${summary}`);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				logger.logWarning(
					"Webhook handler error",
					error instanceof Error ? error.message : String(error),
				);
				res.writeHead(500);
				res.end("Internal error");
			}
		},
	);

	return {
		port: config.port,
		start: () =>
			new Promise<void>((resolve) => {
				server.listen(config.port, () => {
					logger.logInfo(`Webhook server listening on port ${config.port}`);
					resolve();
				});
			}),
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			}),
	};
}

function readBody(
	req: IncomingMessage,
	maxSize: number,
): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxSize) {
				req.destroy();
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", () => resolve(null));
	});
}

function verifySignature(
	req: IncomingMessage,
	body: Buffer,
	secret: string,
	source: string,
): boolean {
	if (source === "github") {
		const sig = req.headers["x-hub-signature-256"];
		if (!sig || typeof sig !== "string") return false;
		const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		return (
			sig.length === expected.length &&
			timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
		);
	}

	if (source === "stripe") {
		const sig = req.headers["stripe-signature"];
		if (!sig || typeof sig !== "string") return false;
		const parts = sig.split(",").reduce(
			(acc, part) => {
				const [key, val] = part.split("=");
				if (key && val) acc[key] = val;
				return acc;
			},
			{} as Record<string, string>,
		);
		const timestamp = parts.t;
		const v1 = parts.v1;
		if (!timestamp || !v1) return false;
		const payload = `${timestamp}.${body.toString()}`;
		const expected = createHmac("sha256", secret).update(payload).digest("hex");
		return (
			v1.length === expected.length &&
			timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
		);
	}

	if (source === "linear") {
		const sig = req.headers["linear-signature"];
		if (!sig || typeof sig !== "string") return false;
		const expected = createHmac("sha256", secret).update(body).digest("hex");
		return (
			sig.length === expected.length &&
			timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
		);
	}

	// Generic: check X-Webhook-Signature header
	const sig = req.headers["x-webhook-signature"];
	if (!sig || typeof sig !== "string") return false; // Secret is configured; reject unsigned requests
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	return sig === expected;
}

/**
 * Register a custom source handler for webhook event summarization.
 */
export function registerWebhookHandler(
	source: string,
	handler: (body: Record<string, unknown>) => {
		summary: string;
		channel?: string;
	},
): void {
	sourceHandlers[source] = handler;
}
