/**
 * Application lifecycle management
 * Handles startup initialization and periodic cleanup tasks
 */

import { warmHashCache } from "./audit/integrity.js";
import {
	cleanupExpiredRevocations,
	getRevocationMetrics,
	warmUserRevocationCache,
} from "./auth/token-revocation.js";
import { cleanupRateLimits, cleanupUsedCodes } from "./auth/totp.js";
import { isDbAvailable } from "./db/client.js";
import { initEncryption, isEncryptionEnabled } from "./db/encryption.js";
import { migrate } from "./db/migrate.js";
import { createLogger } from "./utils/logger.js";
import { registerGauge } from "./web/logger.js";
import {
	cleanupWebhookQueue,
	getWebhookQueueMetrics,
	startWebhookProcessor,
	stopWebhookProcessor,
} from "./webhooks/delivery.js";

const logger = createLogger("lifecycle");

// Configuration from environment
const CLEANUP_INTERVAL_MS = Number.parseInt(
	process.env.COMPOSER_CLEANUP_INTERVAL_MS || String(5 * 60 * 1000),
	10,
);

const WEBHOOK_RETENTION_DAYS = Number.parseInt(
	process.env.COMPOSER_WEBHOOK_RETENTION_DAYS || "7",
	10,
);

const TOTP_CODE_RETENTION_HOURS = Number.parseInt(
	process.env.COMPOSER_TOTP_RETENTION_HOURS || "24",
	10,
);

const REVOCATION_RETENTION_DAYS = Number.parseInt(
	process.env.COMPOSER_REVOCATION_RETENTION_DAYS || "30",
	10,
);

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

// Delay between cleanup tasks to avoid DB spikes
const CLEANUP_STAGGER_MS = Number.parseInt(
	process.env.COMPOSER_CLEANUP_STAGGER_MS || "1000",
	10,
);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run all cleanup tasks with staggered execution. */
async function runCleanupTasks(): Promise<void> {
	if (!isDbAvailable()) {
		return;
	}

	const tasks = [
		{ name: "revocations", fn: () => cleanupExpiredRevocations() },
		{
			name: "totp-codes",
			fn: () => cleanupUsedCodes(TOTP_CODE_RETENTION_HOURS * 60),
		},
		{ name: "rate-limits", fn: () => cleanupRateLimits() },
		{ name: "webhooks", fn: () => cleanupWebhookQueue(WEBHOOK_RETENTION_DAYS) },
	];

	let totalCleaned = 0;

	for (const task of tasks) {
		try {
			const count = await task.fn();
			totalCleaned += count;
		} catch (error) {
			logger.error(
				`Cleanup task "${task.name}" failed`,
				error instanceof Error ? error : undefined,
			);
		}

		// Stagger tasks to avoid DB pressure
		if (CLEANUP_STAGGER_MS > 0) {
			await delay(CLEANUP_STAGGER_MS);
		}
	}

	if (totalCleaned > 0) {
		logger.debug("Cleanup completed", { entriesRemoved: totalCleaned });
	}
}

/** Start periodic cleanup tasks. */
function startCleanupScheduler(): void {
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
	}, CLEANUP_INTERVAL_MS);

	logger.debug("Cleanup scheduler started", {
		intervalMs: CLEANUP_INTERVAL_MS,
		webhookRetentionDays: WEBHOOK_RETENTION_DAYS,
		totpRetentionHours: TOTP_CODE_RETENTION_HOURS,
	});
}

function stopCleanupScheduler(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
}

function registerMetrics(): void {
	// Token revocation cache metrics
	registerGauge(
		"composer_token_revocation_cache_size",
		"Size of the token revocation cache",
		() => getRevocationMetrics().cacheSize,
	);

	registerGauge(
		"composer_token_revocation_cache_max_size",
		"Maximum size of the token revocation cache",
		() => getRevocationMetrics().cacheMaxSize,
	);

	// Webhook queue metrics
	registerGauge(
		"composer_webhook_queue_pending",
		"Number of pending webhook deliveries",
		async () => (await getWebhookQueueMetrics()).pendingCount,
	);

	registerGauge(
		"composer_webhook_queue_failed",
		"Number of failed webhook deliveries",
		async () => (await getWebhookQueueMetrics()).failedCount,
	);

	registerGauge(
		"composer_webhook_queue_total",
		"Total number of webhook deliveries in queue",
		async () => (await getWebhookQueueMetrics()).totalCount,
	);
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

	// Initialize field encryption
	const encryptionReady = initEncryption();
	if (encryptionReady) {
		logger.info("Field encryption enabled");
	} else {
		logger.warn(
			"Field encryption disabled - set COMPOSER_DB_ENCRYPTION_KEY to enable",
		);
	}

	// Run database migrations
	if (isDbAvailable()) {
		try {
			const migrationsApplied = await migrate();
			if (migrationsApplied > 0) {
				logger.info("Database migrations completed", {
					count: migrationsApplied,
				});
			}
		} catch (error) {
			logger.error(
				"Database migration failed",
				error instanceof Error ? error : undefined,
			);
			// Don't fail startup - the app can work with existing schema
		}
	}

	// Register metrics
	registerMetrics();

	// Warm caches
	await warmCaches();

	// Start background processors
	startWebhookProcessor();
	startCleanupScheduler();

	initialized = true;
	logger.info("Lifecycle services initialized", {
		encryption: isEncryptionEnabled(),
	});
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

	// Shutdown rate limiter and Redis connection
	const { shutdownRedis } = await import("./web/rate-limiter.js");
	await shutdownRedis();

	initialized = false;
	logger.info("Lifecycle services shut down");
}
