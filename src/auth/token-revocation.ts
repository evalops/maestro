/**
 * Token Revocation Service
 *
 * Database-backed token revocation with in-memory cache for performance.
 * Supports graceful degradation when DB is unavailable.
 */

import crypto from "node:crypto";
import { and, eq, gt, gte, lte } from "drizzle-orm";
import { getDb, isDbAvailable } from "../db/client.js";
import {
	revokedTokens,
	userRevocationTimestamps as userRevocationTimestampsTable,
} from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("auth:revocation");

// ============================================================================
// TYPES
// ============================================================================

export type TokenType = "access" | "refresh" | "api_key";
export type RevocationReason =
	| "logout"
	| "logout_all"
	| "password_change"
	| "admin_revoke"
	| "security_incident"
	| "token_refresh";

// ============================================================================
// USER REVOCATION TIMESTAMPS (for "revoke all" functionality)
// ============================================================================

/**
 * Stores the "revoke all tokens before" timestamp per user.
 * Any token issued before this time is considered revoked.
 */
const userRevocationTimestamps = new Map<string, number>();

/**
 * Check if a token was issued before the user's revocation timestamp.
 */
export function isTokenIssuedBeforeRevocation(
	userId: string,
	issuedAt: number,
): boolean {
	const revokedBefore = userRevocationTimestamps.get(userId);
	if (!revokedBefore) return false;
	return issuedAt < revokedBefore;
}

/**
 * Set the revocation timestamp for a user (revoke all tokens before this time).
 */
export function setUserRevocationTimestamp(
	userId: string,
	timestamp: number,
): void {
	userRevocationTimestamps.set(userId, timestamp);
}

/**
 * Get the revocation timestamp for a user.
 */
export function getUserRevocationTimestamp(userId: string): number | undefined {
	return userRevocationTimestamps.get(userId);
}

export interface RevokeTokenOptions {
	token: string;
	tokenType: TokenType;
	expiresAt: Date;
	userId?: string;
	orgId?: string;
	reason?: RevocationReason;
	revokedBy?: string;
}

// ============================================================================
// IN-MEMORY CACHE (hot path optimization)
// ============================================================================

interface CacheEntry {
	expiresAt: number;
	addedAt: number;
}

class RevocationCache {
	private cache = new Map<string, CacheEntry>();
	private maxSize = 10_000;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor() {
		// Clean up expired entries every 5 minutes
		this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
	}

	add(tokenHash: string, expiresAt: Date): void {
		// Evict oldest entries if at capacity
		if (this.cache.size >= this.maxSize) {
			this.evictOldest(this.maxSize / 10);
		}

		this.cache.set(tokenHash, {
			expiresAt: expiresAt.getTime(),
			addedAt: Date.now(),
		});
	}

	has(tokenHash: string): boolean {
		const entry = this.cache.get(tokenHash);
		if (!entry) return false;

		// Check if expired
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(tokenHash);
			return false;
		}

		return true;
	}

	private cleanup(): void {
		const now = Date.now();
		let cleaned = 0;

		for (const [hash, entry] of this.cache.entries()) {
			if (now > entry.expiresAt) {
				this.cache.delete(hash);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			logger.debug("Revocation cache cleanup", {
				cleaned,
				remaining: this.cache.size,
			});
		}
	}

	private evictOldest(count: number): void {
		const entries = [...this.cache.entries()]
			.sort((a, b) => a[1].addedAt - b[1].addedAt)
			.slice(0, count);

		for (const [hash] of entries) {
			this.cache.delete(hash);
		}
	}

	get size(): number {
		return this.cache.size;
	}

	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.cache.clear();
	}
}

// Singleton cache instance
let cache: RevocationCache | null = null;

function getCache(): RevocationCache {
	if (!cache) {
		cache = new RevocationCache();
	}
	return cache;
}

// ============================================================================
// HASH UTILITY
// ============================================================================

/**
 * Hash a token for storage. Never store raw tokens.
 */
export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

// ============================================================================
// REVOCATION OPERATIONS
// ============================================================================

/**
 * Revoke a token. Stores in database and cache.
 */
export async function revokeToken(options: RevokeTokenOptions): Promise<void> {
	const tokenHash = hashToken(options.token);

	// Always add to cache first (fast path)
	getCache().add(tokenHash, options.expiresAt);

	// Persist to database if available
	if (isDbAvailable()) {
		try {
			const db = getDb();
			await db
				.insert(revokedTokens)
				.values({
					tokenHash,
					tokenType: options.tokenType,
					userId: options.userId,
					orgId: options.orgId,
					reason: options.reason,
					expiresAt: options.expiresAt,
					revokedBy: options.revokedBy,
				})
				.onConflictDoNothing(); // Ignore if already revoked

			logger.info("Token revoked", {
				tokenType: options.tokenType,
				reason: options.reason,
				userId: options.userId,
			});
		} catch (error) {
			logger.error(
				"Failed to persist token revocation",
				error instanceof Error ? error : undefined,
				{
					tokenType: options.tokenType,
				},
			);
			// Cache still has it, so revocation is still effective until restart
		}
	} else {
		logger.warn("Database unavailable, token revocation only in cache", {
			tokenType: options.tokenType,
		});
	}
}

/**
 * Revoke all tokens for a user (e.g., on password change or logout all).
 * Sets a "revoked before" timestamp - any token issued before this is invalid.
 */
export async function revokeAllUserTokens(
	userId: string,
	reason: RevocationReason,
	revokedBy?: string,
): Promise<boolean> {
	const now = Date.now();
	const revokedBefore = new Date(now);

	// Always update in-memory cache first
	setUserRevocationTimestamp(userId, now);

	if (!isDbAvailable()) {
		logger.warn("Database unavailable, user token revocation only in memory", {
			userId,
		});
		return true; // In-memory revocation is still effective
	}

	try {
		const db = getDb();

		// Upsert the revocation timestamp
		await db
			.insert(userRevocationTimestampsTable)
			.values({
				userId,
				revokedBefore,
				reason,
				revokedBy,
			})
			.onConflictDoUpdate({
				target: userRevocationTimestampsTable.userId,
				set: {
					revokedBefore,
					reason,
					revokedBy,
					updatedAt: new Date(),
				},
			});

		logger.info("All user tokens revoked", { userId, reason });
		return true;
	} catch (error) {
		logger.error(
			"Failed to persist user token revocation",
			error instanceof Error ? error : undefined,
			{ userId },
		);
		// In-memory revocation is still effective
		return true;
	}
}

/**
 * Load user revocation timestamps from DB into memory cache.
 * Call this on server startup for cache warming.
 */
export async function warmUserRevocationCache(): Promise<number> {
	if (!isDbAvailable()) {
		return 0;
	}

	try {
		const db = getDb();
		const entries = await db.select().from(userRevocationTimestampsTable);

		for (const entry of entries) {
			setUserRevocationTimestamp(entry.userId, entry.revokedBefore.getTime());
		}

		logger.info("User revocation cache warmed", { count: entries.length });
		return entries.length;
	} catch (error) {
		logger.error(
			"Failed to warm user revocation cache",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

/**
 * Options for revocation check behavior on DB errors.
 */
export interface RevocationCheckOptions {
	/**
	 * If true, return "revoked" when DB check fails (fail-closed).
	 * If false, return "not revoked" when DB check fails (fail-open).
	 * Default: true (fail-closed for security)
	 */
	failClosed?: boolean;
}

/**
 * Check if a token is revoked. Checks cache first, then database.
 *
 * By default, fails closed (returns true/revoked) on DB errors for security.
 * Set failClosed: false for availability-critical paths.
 */
export async function isTokenRevoked(
	token: string,
	options: RevocationCheckOptions = {},
): Promise<boolean> {
	const { failClosed = true } = options;
	const tokenHash = hashToken(token);

	// Fast path: check cache
	if (getCache().has(tokenHash)) {
		return true;
	}

	// Slow path: check database
	if (!isDbAvailable()) {
		if (failClosed) {
			logger.warn("Database unavailable, failing closed on revocation check");
			return true;
		}
		return false;
	}

	try {
		const db = getDb();
		const result = await db
			.select({ id: revokedTokens.id })
			.from(revokedTokens)
			.where(
				and(
					eq(revokedTokens.tokenHash, tokenHash),
					gt(revokedTokens.expiresAt, new Date()),
				),
			)
			.limit(1);

		if (result.length > 0) {
			// Add to cache for future lookups
			// We don't have the exact expiry here, so use a conservative 1 hour
			getCache().add(tokenHash, new Date(Date.now() + 60 * 60 * 1000));
			return true;
		}

		return false;
	} catch (error) {
		logger.error(
			"Failed to check token revocation",
			error instanceof Error ? error : undefined,
		);
		if (failClosed) {
			logger.warn("Failing closed on revocation check due to error");
			return true;
		}
		return false;
	}
}

/**
 * Synchronous revocation check (cache only).
 * Use this in hot paths where async is not acceptable.
 * Note: May miss recently revoked tokens not yet in cache.
 */
export function isTokenRevokedSync(token: string): boolean {
	const tokenHash = hashToken(token);
	return getCache().has(tokenHash);
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up expired revocation entries from database.
 * Run this periodically (e.g., daily cron job).
 */
export async function cleanupExpiredRevocations(): Promise<number> {
	if (!isDbAvailable()) {
		return 0;
	}

	try {
		const db = getDb();
		const result = await db
			.delete(revokedTokens)
			.where(lte(revokedTokens.expiresAt, new Date()))
			.returning({ id: revokedTokens.id });

		if (result.length > 0) {
			logger.info("Cleaned up expired revocations", { count: result.length });
		}

		return result.length;
	} catch (error) {
		logger.error(
			"Failed to cleanup expired revocations",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

// ============================================================================
// METRICS
// ============================================================================

export function getRevocationMetrics(): {
	cacheSize: number;
	cacheMaxSize: number;
} {
	return {
		cacheSize: getCache().size,
		cacheMaxSize: 10_000,
	};
}

// ============================================================================
// TESTING UTILITIES
// ============================================================================

/** Reset cache - only for testing */
export function _resetCacheForTesting(): void {
	if (cache) {
		cache.destroy();
		cache = null;
	}
}
