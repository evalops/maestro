/**
 * Webhook Delivery Service
 *
 * Handles reliable webhook delivery with:
 * - HMAC signing for payload integrity
 * - Exponential backoff retries
 * - Database-backed delivery queue
 * - Delivery status tracking
 */

import crypto from "node:crypto";
import { and, eq, lt, lte, or } from "drizzle-orm";
import { getDb, isDbAvailable } from "../db/client.js";
import { organizations, webhookDeliveries } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("webhooks:delivery");

// ============================================================================
// TYPES
// ============================================================================

export interface WebhookPayload {
	event: string;
	timestamp: string;
	data: Record<string, unknown>;
}

export interface WebhookDeliveryOptions {
	orgId: string;
	url: string;
	payload: WebhookPayload;
	signingSecret?: string;
	maxAttempts?: number;
}

export interface DeliveryResult {
	success: boolean;
	statusCode?: number;
	responseTimeMs?: number;
	error?: string;
}

// ============================================================================
// HMAC SIGNING
// ============================================================================

/**
 * Sign a webhook payload with HMAC-SHA256.
 * Format: t=timestamp,v1=signature
 */
export function signPayload(
	payload: string,
	secret: string,
	timestamp?: number,
): { signature: string; timestamp: number } {
	const ts = timestamp ?? Math.floor(Date.now() / 1000);
	const signatureBase = `${ts}.${payload}`;

	const signature = crypto
		.createHmac("sha256", secret)
		.update(signatureBase)
		.digest("hex");

	return {
		signature: `t=${ts},v1=${signature}`,
		timestamp: ts,
	};
}

/**
 * Verify a webhook signature.
 */
export function verifySignature(
	payload: string,
	signature: string,
	secret: string,
	toleranceSeconds = 300,
): { valid: boolean; error?: string } {
	// Parse signature: t=timestamp,v1=hash
	const parts = signature.split(",");
	const timestampPart = parts.find((p) => p.startsWith("t="));
	const signaturePart = parts.find((p) => p.startsWith("v1="));

	if (!timestampPart || !signaturePart) {
		return { valid: false, error: "Invalid signature format" };
	}

	const timestamp = Number.parseInt(timestampPart.slice(2), 10);
	const providedSig = signaturePart.slice(3);

	if (Number.isNaN(timestamp)) {
		return { valid: false, error: "Invalid timestamp" };
	}

	// Check timestamp freshness
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > toleranceSeconds) {
		return { valid: false, error: "Timestamp outside tolerance" };
	}

	// Compute expected signature
	const signatureBase = `${timestamp}.${payload}`;
	const expected = crypto
		.createHmac("sha256", secret)
		.update(signatureBase)
		.digest("hex");

	// Timing-safe comparison
	const providedBuf = Buffer.from(providedSig, "hex");
	const expectedBuf = Buffer.from(expected, "hex");

	if (providedBuf.length !== expectedBuf.length) {
		return { valid: false, error: "Signature length mismatch" };
	}

	if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
		return { valid: false, error: "Signature mismatch" };
	}

	return { valid: true };
}

// ============================================================================
// HTTP DELIVERY
// ============================================================================

/**
 * Deliver a webhook via HTTP POST.
 */
async function deliverHttp(
	url: string,
	payload: string,
	signature?: string,
	timeoutMs = 30_000,
): Promise<DeliveryResult> {
	const startTime = Date.now();

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": "Composer-Webhooks/1.0",
		"X-Webhook-Id": crypto.randomUUID(),
	};

	if (signature) {
		headers["X-Composer-Signature"] = signature;
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: payload,
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const responseTimeMs = Date.now() - startTime;

		if (response.ok) {
			return {
				success: true,
				statusCode: response.status,
				responseTimeMs,
			};
		}

		return {
			success: false,
			statusCode: response.status,
			responseTimeMs,
			error: `HTTP ${response.status}: ${response.statusText}`,
		};
	} catch (error) {
		const responseTimeMs = Date.now() - startTime;

		if (error instanceof Error && error.name === "AbortError") {
			return {
				success: false,
				responseTimeMs,
				error: "Request timeout",
			};
		}

		return {
			success: false,
			responseTimeMs,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

// ============================================================================
// QUEUE OPERATIONS
// ============================================================================

/**
 * Queue a webhook for delivery.
 */
export async function queueWebhook(
	options: WebhookDeliveryOptions,
): Promise<string | null> {
	if (!isDbAvailable()) {
		logger.warn("Database unavailable, delivering webhook immediately");
		// Fall back to immediate delivery without persistence
		const payload = JSON.stringify(options.payload);
		const signature = options.signingSecret
			? signPayload(payload, options.signingSecret).signature
			: undefined;

		const result = await deliverHttp(options.url, payload, signature);
		if (!result.success) {
			logger.error("Immediate webhook delivery failed", undefined, {
				url: options.url,
				error: result.error,
			});
		}
		return null;
	}

	try {
		const db = getDb();
		const payload = JSON.stringify(options.payload);
		const signature = options.signingSecret
			? signPayload(payload, options.signingSecret).signature
			: undefined;

		const [delivery] = await db
			.insert(webhookDeliveries)
			.values({
				orgId: options.orgId,
				url: options.url,
				payload: options.payload,
				signature,
				maxAttempts: options.maxAttempts ?? 5,
				nextRetryAt: new Date(), // Immediate first attempt
			})
			.returning({ id: webhookDeliveries.id });

		logger.debug("Webhook queued", {
			id: delivery.id,
			url: options.url,
			event: options.payload.event,
		});

		return delivery.id;
	} catch (error) {
		logger.error(
			"Failed to queue webhook",
			error instanceof Error ? error : undefined,
			{ url: options.url },
		);
		return null;
	}
}

/**
 * Process pending webhooks from the queue.
 * Call this periodically (e.g., every 10 seconds).
 */
export async function processWebhookQueue(batchSize = 10): Promise<number> {
	if (!isDbAvailable()) {
		return 0;
	}

	try {
		const db = getDb();
		const now = new Date();

		// Fetch pending webhooks ready for delivery/retry
		const pending = await db
			.select()
			.from(webhookDeliveries)
			.where(
				and(
					or(
						eq(webhookDeliveries.status, "pending"),
						eq(webhookDeliveries.status, "retrying"),
					),
					lte(webhookDeliveries.nextRetryAt, now),
					lt(webhookDeliveries.attempts, webhookDeliveries.maxAttempts),
				),
			)
			.limit(batchSize);

		if (pending.length === 0) {
			return 0;
		}

		let processed = 0;

		for (const delivery of pending) {
			const payload = JSON.stringify(delivery.payload);
			const result = await deliverHttp(
				delivery.url,
				payload,
				delivery.signature ?? undefined,
			);

			const newAttempts = delivery.attempts + 1;

			if (result.success) {
				// Mark as delivered
				await db
					.update(webhookDeliveries)
					.set({
						status: "delivered",
						attempts: newAttempts,
						lastStatusCode: result.statusCode,
						lastResponseTimeMs: result.responseTimeMs,
						deliveredAt: new Date(),
					})
					.where(eq(webhookDeliveries.id, delivery.id));

				logger.info("Webhook delivered", {
					id: delivery.id,
					url: delivery.url,
					attempts: newAttempts,
					responseTimeMs: result.responseTimeMs,
				});
			} else if (newAttempts >= delivery.maxAttempts) {
				// Max retries exceeded, mark as failed
				await db
					.update(webhookDeliveries)
					.set({
						status: "failed",
						attempts: newAttempts,
						lastStatusCode: result.statusCode,
						lastResponseTimeMs: result.responseTimeMs,
						lastError: result.error,
					})
					.where(eq(webhookDeliveries.id, delivery.id));

				logger.error("Webhook delivery failed permanently", undefined, {
					id: delivery.id,
					url: delivery.url,
					attempts: newAttempts,
					error: result.error,
				});
			} else {
				// Schedule retry with exponential backoff
				const backoffMs = Math.min(
					1000 * 2 ** newAttempts, // 2s, 4s, 8s, 16s, 32s...
					300_000, // Max 5 minutes
				);
				const nextRetry = new Date(Date.now() + backoffMs);

				await db
					.update(webhookDeliveries)
					.set({
						status: "retrying",
						attempts: newAttempts,
						lastStatusCode: result.statusCode,
						lastResponseTimeMs: result.responseTimeMs,
						lastError: result.error,
						nextRetryAt: nextRetry,
					})
					.where(eq(webhookDeliveries.id, delivery.id));

				logger.warn("Webhook delivery failed, scheduling retry", {
					id: delivery.id,
					url: delivery.url,
					attempts: newAttempts,
					nextRetryIn: `${backoffMs / 1000}s`,
					error: result.error,
				});
			}

			processed++;
		}

		return processed;
	} catch (error) {
		logger.error(
			"Failed to process webhook queue",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

/**
 * Clean up old delivered/failed webhooks.
 */
export async function cleanupWebhookQueue(retentionDays = 7): Promise<number> {
	if (!isDbAvailable()) {
		return 0;
	}

	try {
		const db = getDb();
		const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

		const result = await db
			.delete(webhookDeliveries)
			.where(
				and(
					or(
						eq(webhookDeliveries.status, "delivered"),
						eq(webhookDeliveries.status, "failed"),
					),
					lte(webhookDeliveries.createdAt, cutoff),
				),
			)
			.returning({ id: webhookDeliveries.id });

		if (result.length > 0) {
			logger.info("Cleaned up old webhook deliveries", {
				count: result.length,
				retentionDays,
			});
		}

		return result.length;
	} catch (error) {
		logger.error(
			"Failed to cleanup webhook queue",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

// ============================================================================
// ALERT WEBHOOK INTEGRATION
// ============================================================================

/**
 * Send alert webhooks to all configured endpoints for an organization.
 */
export async function sendAlertWebhooks(
	orgId: string,
	alert: {
		type: string;
		severity: string;
		message: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	if (!isDbAvailable()) {
		logger.warn("Database unavailable, skipping alert webhooks");
		return;
	}

	try {
		const db = getDb();

		// Get org settings to find webhook URLs and signing secret
		const [org] = await db
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.limit(1);

		if (!org?.settings?.alertWebhooks?.length) {
			return; // No webhooks configured
		}

		const payload: WebhookPayload = {
			event: `alert.${alert.type}`,
			timestamp: new Date().toISOString(),
			data: {
				severity: alert.severity,
				message: alert.message,
				...alert.metadata,
			},
		};

		// Queue webhooks to all configured URLs
		for (const url of org.settings.alertWebhooks) {
			await queueWebhook({
				orgId,
				url,
				payload,
				signingSecret: org.settings.webhookSigningSecret,
			});
		}

		logger.debug("Alert webhooks queued", {
			orgId,
			alertType: alert.type,
			webhookCount: org.settings.alertWebhooks.length,
		});
	} catch (error) {
		logger.error(
			"Failed to send alert webhooks",
			error instanceof Error ? error : undefined,
			{ orgId, alertType: alert.type },
		);
	}
}

// ============================================================================
// BACKGROUND PROCESSOR
// ============================================================================

let processorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background webhook processor.
 */
export function startWebhookProcessor(intervalMs = 10_000): void {
	if (processorInterval) {
		return; // Already running
	}

	processorInterval = setInterval(() => {
		processWebhookQueue().catch((error) => {
			logger.error(
				"Webhook processor error",
				error instanceof Error ? error : undefined,
			);
		});
	}, intervalMs);

	logger.info("Webhook processor started", { intervalMs });
}

/**
 * Stop the background webhook processor.
 */
export function stopWebhookProcessor(): void {
	if (processorInterval) {
		clearInterval(processorInterval);
		processorInterval = null;
		logger.info("Webhook processor stopped");
	}
}
