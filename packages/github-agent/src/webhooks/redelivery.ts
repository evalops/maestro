import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubApiClient, WebhookDelivery } from "../github/client.js";
import type { AgentConfig } from "../types.js";

const DEFAULT_REDELIVERY_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 3;
const MAX_REDELIVERIES_PER_RUN = 5;
const RECENT_REDELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_REDELIVERIES = 5000;
const DEFAULT_ALLOWED_EVENTS = new Set([
	"issues",
	"issue_comment",
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
	"check_run",
]);

type RedeliveryState = {
	hookId?: number;
	recentRedeliveries?: Record<string, number>;
};

export class WebhookRedeliveryManager {
	private readonly client: GitHubApiClient;
	private readonly intervalMs: number;
	private readonly statePath: string;
	private readonly getHookId?: () => number | undefined;
	private hookId?: number;
	private timer?: ReturnType<typeof setInterval>;
	private inFlight = false;
	private missingHookIdLogged = false;
	private recentRedeliveries = new Map<string, number>();

	constructor(options: {
		config: AgentConfig;
		client: GitHubApiClient;
		hookId?: number;
		getHookId?: () => number | undefined;
	}) {
		this.client = options.client;
		this.intervalMs =
			options.config.webhookRedeliveryIntervalMs ??
			DEFAULT_REDELIVERY_INTERVAL_MS;
		this.statePath = join(options.config.memoryDir, "webhook-redelivery.json");
		this.hookId = options.hookId;
		this.getHookId = options.getHookId;
		this.loadState();
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.run();
		}, this.intervalMs);
		void this.run();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.saveState();
	}

	setHookId(hookId: number): void {
		this.hookId = hookId;
		this.saveState();
	}

	private resolveHookId(): number | undefined {
		const resolved = this.hookId ?? this.getHookId?.();
		if (!this.hookId && resolved) {
			this.hookId = resolved;
		}
		return resolved;
	}

	private async run(): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			const hookId = this.resolveHookId();
			if (!hookId) {
				if (!this.missingHookIdLogged) {
					console.warn(
						"[webhook-redelivery] Skipping redelivery; webhook ID not available.",
					);
					this.missingHookIdLogged = true;
				}
				return;
			}

			const deliveries = (await this.listRecentDeliveries(hookId)).filter(
				isRelevantDelivery,
			);
			if (!deliveries.length) {
				return;
			}

			const deliveriesByGuid = new Map<string, WebhookDelivery[]>();
			for (const delivery of deliveries) {
				if (!delivery.guid) continue;
				const existing = deliveriesByGuid.get(delivery.guid);
				if (existing) {
					existing.push(delivery);
				} else {
					deliveriesByGuid.set(delivery.guid, [delivery]);
				}
			}

			const now = Date.now();
			this.pruneRecentRedeliveries(now);
			let attempted = 0;

			for (const [guid, group] of deliveriesByGuid) {
				group.sort((a, b) => deliverySortKey(b) - deliverySortKey(a));

				if (group.some(isSuccessfulDelivery)) {
					continue;
				}
				const candidate = group.find(
					(delivery) => !isPendingDelivery(delivery),
				);
				if (!candidate) continue;
				if (!this.shouldRedeliver(guid, now)) continue;

				let didAttempt = false;
				try {
					await this.client.redeliverWebhookDelivery(hookId, candidate.id);
					console.log(
						`[webhook-redelivery] Redelivered webhook delivery ${candidate.id} (${guid}).`,
					);
					didAttempt = true;
				} catch (error) {
					console.warn(
						`[webhook-redelivery] Failed to redeliver ${candidate.id} (${guid}).`,
						error,
					);
					didAttempt = true;
				}
				if (didAttempt) {
					this.recentRedeliveries.set(guid, now);
					attempted += 1;
					if (attempted >= MAX_REDELIVERIES_PER_RUN) {
						break;
					}
				}
			}
		} finally {
			this.inFlight = false;
			this.saveState();
		}
	}

	private async listRecentDeliveries(
		hookId: number,
	): Promise<WebhookDelivery[]> {
		const deliveries: WebhookDelivery[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < DEFAULT_MAX_PAGES; page += 1) {
			const pageResult = await this.client.listWebhookDeliveries({
				hookId,
				cursor,
				perPage: DEFAULT_PER_PAGE,
			});
			deliveries.push(...pageResult.deliveries);
			if (!pageResult.nextCursor) {
				break;
			}
			if (pageResult.nextCursor === cursor) {
				break;
			}
			cursor = pageResult.nextCursor ?? undefined;
		}
		return deliveries;
	}

	private shouldRedeliver(guid: string, now: number): boolean {
		const lastAttempt = this.recentRedeliveries.get(guid);
		if (lastAttempt && now - lastAttempt < this.intervalMs) {
			return false;
		}
		return true;
	}

	private pruneRecentRedeliveries(now: number): void {
		for (const [guid, timestamp] of this.recentRedeliveries) {
			if (now - timestamp > RECENT_REDELIVERY_TTL_MS) {
				this.recentRedeliveries.delete(guid);
			}
		}
		if (this.recentRedeliveries.size <= MAX_RECENT_REDELIVERIES) {
			return;
		}
		const entries = Array.from(this.recentRedeliveries.entries()).sort(
			(a, b) => a[1] - b[1],
		);
		for (const [guid] of entries) {
			if (this.recentRedeliveries.size <= MAX_RECENT_REDELIVERIES) {
				break;
			}
			this.recentRedeliveries.delete(guid);
		}
	}

	private loadState(): void {
		if (!existsSync(this.statePath)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf-8"));
			if (
				parsed &&
				typeof parsed === "object" &&
				parsed.recentRedeliveries &&
				typeof parsed.recentRedeliveries === "object"
			) {
				for (const [guid, timestamp] of Object.entries(
					parsed.recentRedeliveries as Record<string, number>,
				)) {
					if (Number.isFinite(timestamp)) {
						this.recentRedeliveries.set(guid, timestamp);
					}
				}
			}
			if (!this.hookId && Number.isFinite(parsed.hookId)) {
				this.hookId = Number(parsed.hookId);
			}
		} catch {
			// Ignore corrupt state.
		}
	}

	private saveState(): void {
		const state: RedeliveryState = {
			hookId: this.hookId,
			recentRedeliveries: Object.fromEntries(this.recentRedeliveries),
		};
		try {
			writeFileSync(this.statePath, JSON.stringify(state, null, 2));
		} catch (error) {
			console.warn(
				"[webhook-redelivery] Failed to persist redelivery state.",
				error,
			);
		}
	}
}

function deliverySortKey(delivery: WebhookDelivery): number {
	if (delivery.deliveredAt) {
		const parsed = Date.parse(delivery.deliveredAt);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}
	return delivery.id;
}

function isPendingDelivery(delivery: WebhookDelivery): boolean {
	const status = delivery.status?.toLowerCase();
	return status === "pending" || status === "in_progress";
}

function isSuccessfulDelivery(delivery: WebhookDelivery): boolean {
	if (
		typeof delivery.statusCode === "number" &&
		delivery.statusCode >= 200 &&
		delivery.statusCode < 300
	) {
		return true;
	}
	const status = delivery.status?.toLowerCase();
	return status === "ok" || status === "success";
}

function isRelevantDelivery(delivery: WebhookDelivery): boolean {
	if (!delivery.event) return true;
	return DEFAULT_ALLOWED_EVENTS.has(delivery.event);
}
