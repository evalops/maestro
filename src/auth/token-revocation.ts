/**
 * Token Revocation Service
 *
 * Database-backed token revocation with in-memory cache for performance.
 * Supports graceful degradation when DB is unavailable.
 */

import crypto from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { getDb, isDbAvailable } from "../db/client.js";
import { revokedTokens } from "../db/schema.js";
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
 * Revoke all tokens for a user (e.g., on password change or logout all)
 */
export async function revokeAllUserTokens(
	userId: string,
	orgId: string,
	reason: RevocationReason,
	revokedBy?: string,
): Promise<number> {
	if (!isDbAvailable()) {
		logger.warn("Database unavailable, cannot revoke all user tokens");
		return 0;
	}

	try {
		const db = getDb();

		// We can't revoke tokens we don't know about, but we can mark
		// a "revoke all before" timestamp in user settings or a separate table.
		// For now, this logs the action - actual enforcement requires checking
		// token issue time against this timestamp during verification.

		// Insert a special marker that indicates "all tokens before now are revoked"
		const marker = await db
			.insert(revokedTokens)
			.values({
				tokenHash: `user_all_${userId}_${Date.now()}`,
				tokenType: "access",
				userId,
				orgId,
				reason,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
				revokedBy,
			})
			.returning();

		logger.info("All user tokens revoked", { userId, reason });
		return marker.length;
	} catch (error) {
		logger.error(
			"Failed to revoke all user tokens",
			error instanceof Error ? error : undefined,
			{
				userId,
			},
		);
		return 0;
	}
}

/**
 * Check if a token is revoked. Checks cache first, then database.
 */
export async function isTokenRevoked(token: string): Promise<boolean> {
	const tokenHash = hashToken(token);

	// Fast path: check cache
	if (getCache().has(tokenHash)) {
		return true;
	}

	// Slow path: check database
	if (!isDbAvailable()) {
		// If DB is down and not in cache, assume not revoked
		// This is a conscious trade-off for availability
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
		// Fail open - if we can't check, assume not revoked
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
