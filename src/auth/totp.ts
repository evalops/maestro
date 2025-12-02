/**
 * TOTP 2FA Service
 *
 * Provides secure TOTP verification with:
 * - Rate limiting to prevent brute force
 * - Replay protection to prevent code reuse
 * - Database-backed used code storage
 *
 * Uses otplib for TOTP - a well-tested, audited library.
 */

import crypto from "node:crypto";
import { and, eq, isNull, lt, lte } from "drizzle-orm";
import { authenticator } from "otplib";
import { getDb, isDbAvailable } from "../db/client.js";
import { totpRateLimits, totpUsedCodes } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("auth:totp");

// Configure otplib
authenticator.options = {
	digits: 6,
	step: 30,
	window: 1, // Allow 1 step before/after for clock drift
};

// ============================================================================
// SECRET GENERATION
// ============================================================================

/**
 * Generate a new TOTP secret.
 */
export function generateTotpSecret(): string {
	return authenticator.generateSecret();
}

/**
 * Generate otpauth:// URI for QR code enrollment.
 */
export function generateTotpUri(
	secret: string,
	email: string,
	issuer = "Composer",
): string {
	return authenticator.keyuri(email, issuer, secret);
}

// ============================================================================
// BACKUP CODES
// ============================================================================

/**
 * Generate backup codes for 2FA recovery.
 */
export function generateBackupCodes(count = 10): string[] {
	const codes: string[] = [];
	for (let i = 0; i < count; i++) {
		// 8-character alphanumeric codes, grouped as XXXX-XXXX
		const code = crypto.randomBytes(4).toString("hex").toUpperCase();
		codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}`);
	}
	return codes;
}

/**
 * Hash a backup code for storage.
 */
export function hashBackupCode(code: string): string {
	// Normalize: remove dashes, uppercase
	const normalized = code.replace(/-/g, "").toUpperCase();
	return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Verify a backup code against stored hashes.
 */
export function verifyBackupCode(
	code: string,
	hashedCodes: string[],
): { valid: boolean; usedIndex: number } {
	const codeHash = hashBackupCode(code);

	for (let i = 0; i < hashedCodes.length; i++) {
		const storedHash = hashedCodes[i];
		if (!storedHash) continue;

		// Timing-safe comparison
		if (
			codeHash.length === storedHash.length &&
			crypto.timingSafeEqual(Buffer.from(codeHash), Buffer.from(storedHash))
		) {
			return { valid: true, usedIndex: i };
		}
	}

	return { valid: false, usedIndex: -1 };
}

// ============================================================================
// RATE LIMITING (database-backed for multi-instance support)
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// In-memory fallback when DB is unavailable
const fallbackRateLimits = new Map<
	string,
	{ attempts: number; windowStart: number; lockedUntil?: number }
>();

/**
 * Check if user is rate limited.
 * Uses database for distributed rate limiting across instances.
 */
export async function isRateLimitedAsync(userId: string): Promise<{
	limited: boolean;
	retryAfterMs?: number;
}> {
	if (!isDbAvailable()) {
		return isRateLimitedFallback(userId);
	}

	try {
		const db = getDb();
		const now = new Date();

		const [entry] = await db
			.select()
			.from(totpRateLimits)
			.where(eq(totpRateLimits.userId, userId))
			.limit(1);

		if (!entry) {
			return { limited: false };
		}

		// Check lockout
		if (entry.lockedUntil && now < entry.lockedUntil) {
			return {
				limited: true,
				retryAfterMs: entry.lockedUntil.getTime() - now.getTime(),
			};
		}

		// Check window expiry
		if (now.getTime() - entry.windowStart.getTime() > RATE_LIMIT_WINDOW_MS) {
			// Window expired, clean up
			await db.delete(totpRateLimits).where(eq(totpRateLimits.userId, userId));
			return { limited: false };
		}

		// Check attempts
		if (entry.attempts >= MAX_ATTEMPTS_PER_WINDOW) {
			return {
				limited: true,
				retryAfterMs:
					RATE_LIMIT_WINDOW_MS - (now.getTime() - entry.windowStart.getTime()),
			};
		}

		return { limited: false };
	} catch (error) {
		logger.error(
			"Failed to check rate limit",
			error instanceof Error ? error : undefined,
		);
		return isRateLimitedFallback(userId);
	}
}

/**
 * Synchronous rate limit check (in-memory fallback only).
 * Use isRateLimitedAsync for accurate distributed checks.
 */
export function isRateLimited(userId: string): {
	limited: boolean;
	retryAfterMs?: number;
} {
	return isRateLimitedFallback(userId);
}

function isRateLimitedFallback(userId: string): {
	limited: boolean;
	retryAfterMs?: number;
} {
	const entry = fallbackRateLimits.get(userId);
	if (!entry) return { limited: false };

	const now = Date.now();

	if (entry.lockedUntil && now < entry.lockedUntil) {
		return { limited: true, retryAfterMs: entry.lockedUntil - now };
	}

	if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		fallbackRateLimits.delete(userId);
		return { limited: false };
	}

	if (entry.attempts >= MAX_ATTEMPTS_PER_WINDOW) {
		return {
			limited: true,
			retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - entry.windowStart),
		};
	}

	return { limited: false };
}

async function recordAttempt(userId: string, success: boolean): Promise<void> {
	// Always update fallback cache
	recordAttemptFallback(userId, success);

	if (!isDbAvailable()) {
		return;
	}

	try {
		const db = getDb();
		const now = new Date();

		if (success) {
			// Clear rate limit on success
			await db.delete(totpRateLimits).where(eq(totpRateLimits.userId, userId));
			return;
		}

		// Get current entry
		const [entry] = await db
			.select()
			.from(totpRateLimits)
			.where(eq(totpRateLimits.userId, userId))
			.limit(1);

		if (
			!entry ||
			now.getTime() - entry.windowStart.getTime() > RATE_LIMIT_WINDOW_MS
		) {
			// New window - insert fresh entry
			await db
				.insert(totpRateLimits)
				.values({
					userId,
					attempts: 1,
					windowStart: now,
					lockedUntil: null,
				})
				.onConflictDoUpdate({
					target: totpRateLimits.userId,
					set: {
						attempts: 1,
						windowStart: now,
						lockedUntil: null,
						updatedAt: now,
					},
				});
		} else {
			// Increment attempts
			const newAttempts = entry.attempts + 1;
			const lockedUntil =
				newAttempts >= MAX_ATTEMPTS_PER_WINDOW
					? new Date(now.getTime() + LOCKOUT_DURATION_MS)
					: null;

			if (lockedUntil) {
				logger.warn("User locked out from TOTP", { userId });
			}

			await db
				.update(totpRateLimits)
				.set({
					attempts: newAttempts,
					lockedUntil,
					updatedAt: now,
				})
				.where(eq(totpRateLimits.userId, userId));
		}
	} catch (error) {
		logger.error(
			"Failed to record rate limit attempt",
			error instanceof Error ? error : undefined,
		);
	}
}

function recordAttemptFallback(userId: string, success: boolean): void {
	if (success) {
		fallbackRateLimits.delete(userId);
		return;
	}

	const now = Date.now();
	let entry = fallbackRateLimits.get(userId);

	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		entry = { attempts: 0, windowStart: now };
	}

	entry.attempts++;

	if (entry.attempts >= MAX_ATTEMPTS_PER_WINDOW) {
		entry.lockedUntil = now + LOCKOUT_DURATION_MS;
	}

	fallbackRateLimits.set(userId, entry);
}

// ============================================================================
// REPLAY PROTECTION
// ============================================================================

function getWindowStart(drift: number): Date {
	const now = Math.floor(Date.now() / 1000);
	const step = authenticator.options.step ?? 30;
	const windowCounter = Math.floor(now / step) + drift;
	return new Date(windowCounter * step * 1000);
}

function hashCode(code: string): string {
	return crypto.createHash("sha256").update(code).digest("hex");
}

async function isCodeUsed(
	userId: string,
	code: string,
	drift: number,
): Promise<boolean> {
	if (!isDbAvailable()) {
		logger.warn("Database unavailable, replay protection disabled");
		return false;
	}

	try {
		const db = getDb();
		const codeHash = hashCode(code);
		const windowStart = getWindowStart(drift);

		const [existing] = await db
			.select({ id: totpUsedCodes.id })
			.from(totpUsedCodes)
			.where(
				and(
					eq(totpUsedCodes.userId, userId),
					eq(totpUsedCodes.codeHash, codeHash),
					eq(totpUsedCodes.windowStart, windowStart),
				),
			)
			.limit(1);

		return !!existing;
	} catch (error) {
		logger.error(
			"Failed to check used code",
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

async function markCodeUsed(
	userId: string,
	code: string,
	drift: number,
): Promise<void> {
	if (!isDbAvailable()) return;

	try {
		const db = getDb();
		await db
			.insert(totpUsedCodes)
			.values({
				userId,
				codeHash: hashCode(code),
				windowStart: getWindowStart(drift),
			})
			.onConflictDoNothing();
	} catch (error) {
		logger.error(
			"Failed to mark code used",
			error instanceof Error ? error : undefined,
		);
	}
}

// ============================================================================
// VERIFICATION
// ============================================================================

export interface TotpVerifyResult {
	valid: boolean;
	error?: "invalid_code" | "rate_limited" | "code_reused";
	retryAfterMs?: number;
}

/**
 * Verify a TOTP code with rate limiting and replay protection.
 * Uses database for distributed rate limiting across instances.
 */
export async function verifyTotpCode(
	userId: string,
	secret: string,
	code: string,
): Promise<TotpVerifyResult> {
	// Check rate limit (async for distributed check)
	const rateStatus = await isRateLimitedAsync(userId);
	if (rateStatus.limited) {
		return {
			valid: false,
			error: "rate_limited",
			retryAfterMs: rateStatus.retryAfterMs,
		};
	}

	// Verify with otplib
	const isValid = authenticator.check(code, secret);

	if (!isValid) {
		await recordAttempt(userId, false);
		return { valid: false, error: "invalid_code" };
	}

	// Calculate drift for replay protection
	const delta = authenticator.checkDelta(code, secret) ?? 0;

	// Check replay
	const wasUsed = await isCodeUsed(userId, code, delta);
	if (wasUsed) {
		logger.warn("TOTP code reuse detected", { userId });
		await recordAttempt(userId, false);
		return { valid: false, error: "code_reused" };
	}

	// Mark as used and clear rate limit
	await markCodeUsed(userId, code, delta);
	await recordAttempt(userId, true);

	return { valid: true };
}

/**
 * Generate a TOTP code (for testing only).
 */
export function generateTotpCode(secret: string): string {
	return authenticator.generate(secret);
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up old used codes.
 */
export async function cleanupUsedCodes(retentionMinutes = 10): Promise<number> {
	if (!isDbAvailable()) return 0;

	try {
		const db = getDb();
		const cutoff = new Date(Date.now() - retentionMinutes * 60 * 1000);

		const result = await db
			.delete(totpUsedCodes)
			.where(lte(totpUsedCodes.windowStart, cutoff))
			.returning({ id: totpUsedCodes.id });

		return result.length;
	} catch (error) {
		logger.error(
			"Failed to cleanup codes",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

/**
 * Clean up expired rate limit entries.
 * Call this periodically to prevent table bloat.
 */
export async function cleanupRateLimits(): Promise<number> {
	if (!isDbAvailable()) return 0;

	try {
		const db = getDb();
		const now = new Date();
		const windowCutoff = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

		// Delete entries where:
		// - lockout has expired, OR
		// - window has expired and not locked out
		const result = await db
			.delete(totpRateLimits)
			.where(
				and(
					// Lockout expired
					lt(totpRateLimits.lockedUntil, now),
				),
			)
			.returning({ id: totpRateLimits.id });

		// Also delete old windows without lockout
		const result2 = await db
			.delete(totpRateLimits)
			.where(
				and(
					lt(totpRateLimits.windowStart, windowCutoff),
					isNull(totpRateLimits.lockedUntil),
				),
			)
			.returning({ id: totpRateLimits.id });

		const total = result.length + result2.length;
		if (total > 0) {
			logger.debug("Cleaned up rate limit entries", { count: total });
		}

		return total;
	} catch (error) {
		logger.error(
			"Failed to cleanup rate limits",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

// ============================================================================
// METRICS
// ============================================================================

/**
 * Get TOTP metrics (from in-memory fallback cache).
 * For accurate distributed metrics, query the database directly.
 */
export function getTotpMetrics(): {
	rateLimitedUsers: number;
	lockedOutUsers: number;
} {
	const now = Date.now();
	let rateLimitedUsers = 0;
	let lockedOutUsers = 0;

	for (const entry of fallbackRateLimits.values()) {
		if (entry.lockedUntil && now < entry.lockedUntil) {
			lockedOutUsers++;
		} else if (
			now - entry.windowStart <= RATE_LIMIT_WINDOW_MS &&
			entry.attempts >= MAX_ATTEMPTS_PER_WINDOW
		) {
			rateLimitedUsers++;
		}
	}

	return { rateLimitedUsers, lockedOutUsers };
}

/** Reset rate limits - for testing only */
export function _resetRateLimitsForTesting(): void {
	fallbackRateLimits.clear();
}
