/**
 * Audit Log Integrity Service
 *
 * Provides tamper detection via hash chain:
 * - Each entry includes hash of (entry data + previous hash)
 * - Chain can be verified to detect modifications
 * - Per-org hash chains for isolation
 */

import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb, isDbAvailable } from "../db/client.js";
import { auditHashCache, auditLogs } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("audit:integrity");

// Genesis hash for new chains (all zeros)
const GENESIS_HASH = "0".repeat(64);

// In-memory cache of last hash per org (for hot path performance)
// This is synchronized with the database table for multi-instance consistency
const lastHashMemoryCache = new Map<string, string>();

// ============================================================================
// HASH COMPUTATION
// ============================================================================

export interface AuditEntryData {
	id: string;
	orgId: string;
	userId: string | null;
	action: string;
	timestamp: Date;
	resourceType?: string | null;
	resourceId?: string | null;
	status: string;
	metadata?: unknown;
}

export function computeEntryHash(
	entry: AuditEntryData,
	previousHash: string,
): string {
	const data = JSON.stringify({
		id: entry.id,
		orgId: entry.orgId,
		userId: entry.userId,
		action: entry.action,
		timestamp: entry.timestamp.toISOString(),
		resourceType: entry.resourceType,
		resourceId: entry.resourceId,
		status: entry.status,
		metadata: entry.metadata,
		previousHash,
	});

	return crypto.createHash("sha256").update(data).digest("hex");
}

// ============================================================================
// CHAIN OPERATIONS
// ============================================================================

export async function getLastHash(orgId: string): Promise<string> {
	// Check memory cache first (hot path)
	const memoryCached = lastHashMemoryCache.get(orgId);
	if (memoryCached) {
		return memoryCached;
	}

	if (!isDbAvailable()) {
		return GENESIS_HASH;
	}

	try {
		const db = getDb();

		// Check the persistent hash cache table first
		const [cacheEntry] = await db
			.select({ lastHash: auditHashCache.lastHash })
			.from(auditHashCache)
			.where(eq(auditHashCache.orgId, orgId))
			.limit(1);

		if (cacheEntry?.lastHash) {
			lastHashMemoryCache.set(orgId, cacheEntry.lastHash);
			return cacheEntry.lastHash;
		}

		// Fall back to scanning audit logs (slow, but only happens on first access)
		const [lastEntry] = await db
			.select({
				integrityHash: auditLogs.integrityHash,
			})
			.from(auditLogs)
			.where(eq(auditLogs.orgId, orgId))
			.orderBy(desc(auditLogs.createdAt))
			.limit(1);

		const hash = lastEntry?.integrityHash || GENESIS_HASH;

		// Persist to cache table and memory
		await updateLastHash(orgId, hash);

		return hash;
	} catch (error) {
		logger.error(
			"Failed to get last hash",
			error instanceof Error ? error : undefined,
			{ orgId },
		);
		return GENESIS_HASH;
	}
}

export async function updateLastHash(
	orgId: string,
	hash: string,
): Promise<void> {
	// Always update memory cache
	lastHashMemoryCache.set(orgId, hash);

	if (!isDbAvailable()) {
		return;
	}

	try {
		const db = getDb();

		// Upsert to persistent cache
		await db
			.insert(auditHashCache)
			.values({
				orgId,
				lastHash: hash,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: auditHashCache.orgId,
				set: {
					lastHash: hash,
					updatedAt: new Date(),
				},
			});
	} catch (error) {
		logger.error(
			"Failed to update last hash in DB",
			error instanceof Error ? error : undefined,
			{ orgId },
		);
	}
}

export async function clearHashCache(orgId?: string): Promise<void> {
	if (orgId) {
		lastHashMemoryCache.delete(orgId);

		if (isDbAvailable()) {
			try {
				const db = getDb();
				await db.delete(auditHashCache).where(eq(auditHashCache.orgId, orgId));
			} catch (error) {
				logger.error(
					"Failed to clear hash cache in DB",
					error instanceof Error ? error : undefined,
					{ orgId },
				);
			}
		}
	} else {
		lastHashMemoryCache.clear();

		if (isDbAvailable()) {
			try {
				const db = getDb();
				await db.delete(auditHashCache);
			} catch (error) {
				logger.error(
					"Failed to clear all hash caches in DB",
					error instanceof Error ? error : undefined,
				);
			}
		}
	}
}

/** Warm the memory cache from the database. Call on startup. */
export async function warmHashCache(): Promise<number> {
	if (!isDbAvailable()) {
		return 0;
	}

	try {
		const db = getDb();
		const entries = await db.select().from(auditHashCache);

		for (const entry of entries) {
			lastHashMemoryCache.set(entry.orgId, entry.lastHash);
		}

		logger.info("Audit hash cache warmed", { count: entries.length });
		return entries.length;
	} catch (error) {
		logger.error(
			"Failed to warm hash cache",
			error instanceof Error ? error : undefined,
		);
		return 0;
	}
}

// ============================================================================
// VERIFICATION
// ============================================================================

export interface VerificationResult {
	valid: boolean;
	entriesChecked: number;
	brokenAt?: {
		id: string;
		index: number;
		expectedHash: string;
		actualHash: string;
	};
	error?: string;
}

export async function verifyAuditChain(
	orgId: string,
	options?: {
		limit?: number;
		startDate?: Date;
		endDate?: Date;
	},
): Promise<VerificationResult> {
	if (!isDbAvailable()) {
		return {
			valid: false,
			entriesChecked: 0,
			error: "Database not available",
		};
	}

	try {
		const db = getDb();
		const limit = options?.limit ?? 1000;

		// Fetch entries in chronological order
		const entries = await db.query.auditLogs.findMany({
			where: eq(auditLogs.orgId, orgId),
			orderBy: [auditLogs.createdAt],
			limit,
		});

		if (entries.length === 0) {
			return { valid: true, entriesChecked: 0 };
		}

		let previousHash = GENESIS_HASH;

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry) continue;

			// Skip entries without integrity hash (legacy or disabled)
			if (!entry.integrityHash) {
				continue;
			}

			const expectedHash = computeEntryHash(
				{
					id: entry.id,
					orgId: entry.orgId,
					userId: entry.userId,
					action: entry.action,
					timestamp: entry.createdAt,
					resourceType: entry.resourceType ?? undefined,
					resourceId: entry.resourceId ?? undefined,
					status: entry.status,
					metadata: entry.metadata,
				},
				entry.previousHash || previousHash,
			);

			if (entry.integrityHash !== expectedHash) {
				logger.error("Audit chain integrity violation detected", undefined, {
					orgId,
					entryId: entry.id,
					index: i,
				});

				return {
					valid: false,
					entriesChecked: i + 1,
					brokenAt: {
						id: entry.id,
						index: i,
						expectedHash,
						actualHash: entry.integrityHash,
					},
				};
			}

			previousHash = entry.integrityHash;
		}

		logger.debug("Audit chain verified", {
			orgId,
			entriesChecked: entries.length,
		});

		return {
			valid: true,
			entriesChecked: entries.length,
		};
	} catch (error) {
		logger.error(
			"Failed to verify audit chain",
			error instanceof Error ? error : undefined,
			{ orgId },
		);

		return {
			valid: false,
			entriesChecked: 0,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

// ============================================================================
// METRICS
// ============================================================================

export function getIntegrityMetrics(): {
	cachedOrgs: number;
} {
	return {
		cachedOrgs: lastHashMemoryCache.size,
	};
}
