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
import { auditLogs } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("audit:integrity");

// Genesis hash for new chains (all zeros)
const GENESIS_HASH = "0".repeat(64);

// In-memory cache of last hash per org (for performance)
const lastHashCache = new Map<string, string>();

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

/**
 * Compute integrity hash for an audit entry.
 * Hash = SHA-256(JSON(entry data) + previousHash)
 */
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

/**
 * Get the last hash in the chain for an organization.
 * Uses cache with DB fallback.
 */
export async function getLastHash(orgId: string): Promise<string> {
	// Check cache first
	const cached = lastHashCache.get(orgId);
	if (cached) {
		return cached;
	}

	if (!isDbAvailable()) {
		return GENESIS_HASH;
	}

	try {
		const db = getDb();

		// Get most recent entry with integrity hash
		const [lastEntry] = await db
			.select({
				integrityHash: auditLogs.integrityHash,
			})
			.from(auditLogs)
			.where(eq(auditLogs.orgId, orgId))
			.orderBy(desc(auditLogs.createdAt))
			.limit(1);

		const hash = lastEntry?.integrityHash || GENESIS_HASH;
		lastHashCache.set(orgId, hash);
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

/**
 * Update the cached last hash for an organization.
 */
export function updateLastHash(orgId: string, hash: string): void {
	lastHashCache.set(orgId, hash);
}

/**
 * Clear cached hash (e.g., after verification failure).
 */
export function clearHashCache(orgId?: string): void {
	if (orgId) {
		lastHashCache.delete(orgId);
	} else {
		lastHashCache.clear();
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

/**
 * Verify the integrity of audit log chain for an organization.
 * Checks that each entry's hash matches the expected value.
 */
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
		cachedOrgs: lastHashCache.size,
	};
}
