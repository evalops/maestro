/**
 * Application lifecycle management
 * Handles startup initialization and periodic cleanup tasks
 */

import { warmHashCache } from "./audit/integrity.js";
import {
	cleanupExpiredRevocations,
	warmUserRevocationCache,
} from "./auth/token-revocation.js";
import { cleanupRateLimits, cleanupUsedCodes } from "./auth/totp.js";
import { isDbAvailable } from "./db/client.js";
import { createLogger } from "./utils/logger.js";
import {
	cleanupWebhookQueue,
	startWebhookProcessor,
	stopWebhookProcessor,
} from "./webhooks/delivery.js";

const logger = createLogger("lifecycle");

let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;

/** Warm all caches from database. Call on server startup. */
export async function warmCaches(): Promise<void> {
	if (!isDbAvailable()) {
		logger.debug("Database unavailable, skipping cache warming");
		return;
	}

	const results = await Promise.allSettled([
		warmUserRevocationCache(),
		warmHashCache(),
	]);

	for (const result of results) {
		if (result.status === "rejected") {
			logger.error("Cache warming failed", result.reason);
		}
	}
}

/** Run all cleanup tasks. */
async function runCleanupTasks(): Promise<void> {
	if (!isDbAvailable()) {
		return;
	}

	const results = await Promise.allSettled([
		cleanupExpiredRevocations(),
		cleanupUsedCodes(),
		cleanupRateLimits(),
		cleanupWebhookQueue(),
	]);

	let totalCleaned = 0;
	for (const result of results) {
		if (result.status === "fulfilled") {
			totalCleaned += result.value;
		} else {
			logger.error("Cleanup task failed", result.reason);
		}
	}

	if (totalCleaned > 0) {
		logger.debug("Cleanup completed", { entriesRemoved: totalCleaned });
	}
}

/** Start periodic cleanup tasks. */
function startCleanupScheduler(intervalMs = 5 * 60 * 1000): void {
	if (cleanupInterval) {
		return;
	}

	// Run immediately on start
	runCleanupTasks().catch((err) => {
		logger.error("Initial cleanup failed", err);
	});

	// Then run periodically
	cleanupInterval = setInterval(() => {
		runCleanupTasks().catch((err) => {
			logger.error("Scheduled cleanup failed", err);
		});
	}, intervalMs);

	logger.debug("Cleanup scheduler started", { intervalMs });
}

function stopCleanupScheduler(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
}

/**
 * Initialize application lifecycle services.
 * Call this once on server startup.
 */
export async function initLifecycle(): Promise<void> {
	if (initialized) {
		return;
	}

	logger.info("Initializing lifecycle services");

	// Warm caches
	await warmCaches();

	// Start background processors
	startWebhookProcessor();
	startCleanupScheduler();

	initialized = true;
	logger.info("Lifecycle services initialized");
}

/**
 * Shutdown lifecycle services gracefully.
 * Call this on server shutdown.
 */
export async function shutdownLifecycle(): Promise<void> {
	if (!initialized) {
		return;
	}

	logger.info("Shutting down lifecycle services");

	stopCleanupScheduler();
	await stopWebhookProcessor();

	initialized = false;
	logger.info("Lifecycle services shut down");
}
