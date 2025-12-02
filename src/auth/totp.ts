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
import { and, eq, lte } from "drizzle-orm";
import { authenticator } from "otplib";
import { getDb, isDbAvailable } from "../db/client.js";
import { totpUsedCodes } from "../db/schema.js";
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
// RATE LIMITING
// ============================================================================

interface RateLimitEntry {
	attempts: number;
	windowStart: number;
	lockedUntil?: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if user is rate limited.
 */
export function isRateLimited(userId: string): {
	limited: boolean;
	retryAfterMs?: number;
} {
	const entry = rateLimits.get(userId);
	if (!entry) return { limited: false };

	const now = Date.now();

	// Check lockout
	if (entry.lockedUntil && now < entry.lockedUntil) {
		return { limited: true, retryAfterMs: entry.lockedUntil - now };
	}

	// Check window expiry
	if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimits.delete(userId);
		return { limited: false };
	}

	// Check attempts
	if (entry.attempts >= MAX_ATTEMPTS_PER_WINDOW) {
		return {
			limited: true,
			retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - entry.windowStart),
		};
	}

	return { limited: false };
}

function recordAttempt(userId: string, success: boolean): void {
	if (success) {
		rateLimits.delete(userId);
		return;
	}

	const now = Date.now();
	let entry = rateLimits.get(userId);

	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		entry = { attempts: 0, windowStart: now };
	}

	entry.attempts++;

	if (entry.attempts >= MAX_ATTEMPTS_PER_WINDOW) {
		entry.lockedUntil = now + LOCKOUT_DURATION_MS;
		logger.warn("User locked out from TOTP", { userId });
	}

	rateLimits.set(userId, entry);
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
 */
export async function verifyTotpCode(
	userId: string,
	secret: string,
	code: string,
): Promise<TotpVerifyResult> {
	// Check rate limit
	const rateStatus = isRateLimited(userId);
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
		recordAttempt(userId, false);
		return { valid: false, error: "invalid_code" };
	}

	// Calculate drift for replay protection
	const delta = authenticator.checkDelta(code, secret) ?? 0;

	// Check replay
	const wasUsed = await isCodeUsed(userId, code, delta);
	if (wasUsed) {
		logger.warn("TOTP code reuse detected", { userId });
		recordAttempt(userId, false);
		return { valid: false, error: "code_reused" };
	}

	// Mark as used and clear rate limit
	await markCodeUsed(userId, code, delta);
	recordAttempt(userId, true);

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

// ============================================================================
// METRICS
// ============================================================================

export function getTotpMetrics(): {
	rateLimitedUsers: number;
	lockedOutUsers: number;
} {
	const now = Date.now();
	let rateLimitedUsers = 0;
	let lockedOutUsers = 0;

	for (const entry of rateLimits.values()) {
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
	rateLimits.clear();
}
