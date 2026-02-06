/**
 * Session Share Store - Rate limiting, storage, and DB operations for session sharing
 *
 * @module web/handlers/session-share-store
 */
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { getDb, isDbAvailable } from "../../db/client.js";
import { sharedSessions as sharedSessionsTable } from "../../db/schema.js";
import { RateLimiter } from "../rate-limiter.js";

// ============================================================================
// RATE LIMITING (uses Redis when COMPOSER_REDIS_URL is configured)
// ============================================================================

const shareRateLimiter = new RateLimiter(
	{
		windowMs: Number(process.env.COMPOSER_SHARE_RATE_LIMIT_WINDOW_MS ?? 60_000),
		max: Number(process.env.COMPOSER_SHARE_RATE_LIMIT_MAX ?? 10),
	},
	"share",
);

/**
 * Check if a client IP is rate limited for share access.
 * Uses Redis when configured, falls back to in-memory.
 * Exported for testing.
 */
export async function checkShareRateLimit(clientIp: string): Promise<{
	allowed: boolean;
	retryAfterSeconds?: number;
}> {
	const result = await shareRateLimiter.checkAsync(clientIp);
	if (!result.allowed) {
		const retryAfterSeconds = Math.ceil((result.reset - Date.now()) / 1000);
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, retryAfterSeconds),
		};
	}
	return { allowed: true };
}

/**
 * Reset rate limit state for a client IP. Exported for testing.
 */
export async function resetShareRateLimit(clientIp?: string): Promise<void> {
	await shareRateLimiter.reset(clientIp);
}

/**
 * Stop the rate limiter cleanup. Call during graceful shutdown.
 */
export function stopShareRateLimiter(): void {
	shareRateLimiter.stop();
}

// Fallback in-memory store when DB not available
const inMemoryShares = new Map<
	string,
	{
		sessionId: string;
		expiresAt: Date;
		maxAccesses: number | null;
		accessCount: number;
	}
>();

export interface SessionUpdateBody {
	title?: string;
	tags?: string[];
	favorite?: boolean;
}

export interface SessionShareOptions {
	expiresInHours?: number;
	maxAccesses?: number | null;
}

export interface SessionExportFormat {
	format: "json" | "markdown" | "text";
}

// ============================================================================
// SHARED SESSION DB OPERATIONS
// ============================================================================

export async function createSharedSessionInDb(
	sessionId: string,
	shareToken: string,
	expiresAt: Date,
	maxAccesses: number | null,
): Promise<void> {
	if (!isDbAvailable()) {
		// Fallback to in-memory
		inMemoryShares.set(shareToken, {
			sessionId,
			expiresAt,
			maxAccesses,
			accessCount: 0,
		});
		return;
	}

	const db = getDb();
	await db.insert(sharedSessionsTable).values({
		shareToken,
		sessionId,
		expiresAt,
		maxAccesses,
		accessCount: 0,
	});
}

export async function getSharedSessionFromDb(shareToken: string): Promise<{
	sessionId: string;
	expiresAt: Date;
	maxAccesses: number | null;
	accessCount: number;
} | null> {
	if (!isDbAvailable()) {
		// Fallback to in-memory
		const share = inMemoryShares.get(shareToken);
		if (!share) return null;
		return share;
	}

	const db = getDb();
	const [row] = await db
		.select({
			sessionId: sharedSessionsTable.sessionId,
			expiresAt: sharedSessionsTable.expiresAt,
			maxAccesses: sharedSessionsTable.maxAccesses,
			accessCount: sharedSessionsTable.accessCount,
		})
		.from(sharedSessionsTable)
		.where(eq(sharedSessionsTable.shareToken, shareToken))
		.limit(1);

	if (!row) return null;

	return {
		sessionId: row.sessionId,
		expiresAt: row.expiresAt,
		maxAccesses: row.maxAccesses,
		accessCount: row.accessCount,
	};
}

/**
 * Atomically try to access a shared session.
 * Returns the session ID if access is allowed, null otherwise.
 * This prevents race conditions by doing the check and increment in one operation.
 */
export async function tryAccessShare(shareToken: string): Promise<{
	allowed: boolean;
	sessionId?: string;
	reason?: "not_found" | "expired" | "max_accesses";
}> {
	if (!isDbAvailable()) {
		const share = inMemoryShares.get(shareToken);
		if (!share) return { allowed: false, reason: "not_found" };
		if (share.expiresAt < new Date()) {
			inMemoryShares.delete(shareToken);
			return { allowed: false, reason: "expired" };
		}
		if (share.maxAccesses !== null && share.accessCount >= share.maxAccesses) {
			return { allowed: false, reason: "max_accesses" };
		}
		share.accessCount++;
		return { allowed: true, sessionId: share.sessionId };
	}

	const db = getDb();
	const now = new Date();

	// Atomically increment access count only if:
	// 1. Token exists
	// 2. Not expired
	// 3. Under max accesses (or no limit)
	const result = await db
		.update(sharedSessionsTable)
		.set({ accessCount: sql`${sharedSessionsTable.accessCount} + 1` })
		.where(
			and(
				eq(sharedSessionsTable.shareToken, shareToken),
				gt(sharedSessionsTable.expiresAt, now),
				or(
					sql`${sharedSessionsTable.maxAccesses} IS NULL`,
					lt(sharedSessionsTable.accessCount, sharedSessionsTable.maxAccesses),
				),
			),
		)
		.returning({
			sessionId: sharedSessionsTable.sessionId,
		});

	if (result.length > 0 && result[0]) {
		return { allowed: true, sessionId: result[0].sessionId };
	}

	// Access denied - determine why
	const share = await getSharedSessionFromDb(shareToken);
	if (!share) return { allowed: false, reason: "not_found" };
	if (share.expiresAt < now) return { allowed: false, reason: "expired" };
	return { allowed: false, reason: "max_accesses" };
}

export async function deleteExpiredShares(): Promise<number> {
	if (!isDbAvailable()) {
		let deleted = 0;
		const now = new Date();
		for (const [token, share] of inMemoryShares.entries()) {
			if (share.expiresAt < now) {
				inMemoryShares.delete(token);
				deleted++;
			}
		}
		return deleted;
	}

	const db = getDb();
	const result = await db
		.delete(sharedSessionsTable)
		.where(lt(sharedSessionsTable.expiresAt, new Date()))
		.returning({ id: sharedSessionsTable.id });

	return result.length;
}

export async function deleteShareByToken(shareToken: string): Promise<void> {
	if (!isDbAvailable()) {
		inMemoryShares.delete(shareToken);
		return;
	}

	const db = getDb();
	await db
		.delete(sharedSessionsTable)
		.where(eq(sharedSessionsTable.shareToken, shareToken));
}
