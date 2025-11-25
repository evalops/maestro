/**
 * Token Usage and Credit Tracking System
 * Monitors usage, enforces limits, and triggers alerts
 */

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { logAudit } from "../audit/logger.js";
import { getDb } from "../db/client.js";
import {
	type OrganizationSettings,
	alerts,
	modelApprovals,
	orgMemberships,
	sessions,
} from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("token-tracker");

// ============================================================================
// TYPES
// ============================================================================

export interface TokenUsage {
	sessionId: string;
	modelId: string;
	provider: string;
	tokenCount: number;
	estimatedCost?: number; // in cents
}

export interface UsageQuota {
	userId: string;
	orgId: string;
	tokenQuota: number | null; // null = unlimited
	tokenUsed: number;
	tokenRemaining: number;
	spendLimit: number | null; // in cents, null = unlimited
	spendUsed: number;
	spendRemaining: number;
	quotaResetAt: Date | null;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

async function createUsageAlert(
	userId: string,
	orgId: string,
	alert: {
		severity: "critical" | "high" | "medium" | "low" | "info";
		type: string;
		message: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	const db = getDb();

	// Check if similar alert already exists (avoid spam)
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const existingAlert = await db.query.alerts.findFirst({
		where: and(
			eq(alerts.userId, userId),
			eq(alerts.type, alert.type),
			gte(alerts.createdAt, oneDayAgo),
			isNull(alerts.resolvedAt),
		),
	});

	if (existingAlert) {
		logger.debug("Skipping duplicate alert", {
			userId,
			type: alert.type,
		});
		return;
	}

	await db.insert(alerts).values({
		orgId,
		userId,
		severity: alert.severity,
		type: alert.type,
		message: alert.message,
		metadata: alert.metadata,
	});

	logger.warn("Usage alert created", {
		userId,
		orgId,
		type: alert.type,
		severity: alert.severity,
	});
}

// ============================================================================
// PUBLIC FUNCTIONS
// ============================================================================

/**
 * Record token usage for a session
 */
export async function recordTokenUsage(
	usage: TokenUsage,
	context: {
		orgId: string;
		userId: string;
		requestId?: string;
		traceId?: string;
	},
): Promise<void> {
	try {
		const db = getDb();

		// Update session token count
		await db
			.update(sessions)
			.set({
				tokenCount: sql`${sessions.tokenCount} + ${usage.tokenCount}`,
				updatedAt: new Date(),
			})
			.where(eq(sessions.id, usage.sessionId));

		// Update user's quota usage
		await db
			.update(orgMemberships)
			.set({
				tokenUsed: sql`${orgMemberships.tokenUsed} + ${usage.tokenCount}`,
			})
			.where(
				and(
					eq(orgMemberships.userId, context.userId),
					eq(orgMemberships.orgId, context.orgId),
				),
			);

		// Update model approval usage
		const modelApproval = await db.query.modelApprovals.findFirst({
			where: and(
				eq(modelApprovals.orgId, context.orgId),
				eq(modelApprovals.modelId, usage.modelId),
			),
		});

		if (modelApproval) {
			await db
				.update(modelApprovals)
				.set({
					tokenUsed: sql`${modelApprovals.tokenUsed} + ${usage.tokenCount}`,
					spendUsed: usage.estimatedCost
						? sql`${modelApprovals.spendUsed} + ${usage.estimatedCost}`
						: modelApprovals.spendUsed,
				})
				.where(eq(modelApprovals.id, modelApproval.id));
		}

		// Check quota limits and trigger alerts if needed
		await checkQuotaLimits(context.userId, context.orgId, context);
	} catch (error) {
		logger.error(
			"Failed to record token usage",
			error instanceof Error ? error : undefined,
			{
				sessionId: usage.sessionId,
				tokenCount: usage.tokenCount,
			},
		);
	}
}

/**
 * Get current usage quota for a user
 */
export async function getUsageQuota(
	userId: string,
	orgId: string,
): Promise<UsageQuota | null> {
	const db = getDb();

	const membership = await db.query.orgMemberships.findFirst({
		where: and(
			eq(orgMemberships.userId, userId),
			eq(orgMemberships.orgId, orgId),
		),
		with: {
			organization: true,
		},
	});

	if (!membership) {
		return null;
	}

	const orgSettings = membership.organization
		.settings as OrganizationSettings | null;
	const defaultQuota = orgSettings?.maxTokensPerUser || null;
	const tokenQuota = membership.tokenQuota || defaultQuota;
	const tokenUsed = membership.tokenUsed;

	return {
		userId,
		orgId,
		tokenQuota,
		tokenUsed,
		tokenRemaining: tokenQuota
			? Math.max(0, tokenQuota - tokenUsed)
			: Number.POSITIVE_INFINITY,
		spendLimit: null,
		spendUsed: 0,
		spendRemaining: Number.POSITIVE_INFINITY,
		quotaResetAt: membership.quotaResetAt,
	};
}

/**
 * Check if user can consume tokens
 */
export async function canConsumeTokens(
	userId: string,
	orgId: string,
	requestedTokens: number,
): Promise<{ allowed: boolean; reason?: string; quota?: UsageQuota }> {
	const quota = await getUsageQuota(userId, orgId);

	if (!quota) {
		return {
			allowed: false,
			reason: "User not found in organization",
		};
	}

	if (
		quota.tokenQuota &&
		quota.tokenUsed + requestedTokens > quota.tokenQuota
	) {
		return {
			allowed: false,
			reason: `Token quota exceeded (${quota.tokenUsed}/${quota.tokenQuota})`,
			quota,
		};
	}

	return { allowed: true, quota };
}

/**
 * Reset quota for a user (e.g., monthly reset)
 */
export async function resetUserQuota(
	userId: string,
	orgId: string,
): Promise<void> {
	const db = getDb();

	await db
		.update(orgMemberships)
		.set({
			tokenUsed: 0,
			quotaResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
		})
		.where(
			and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)),
		);

	logger.info("Reset user token quota", { userId, orgId });
}

/**
 * Check quota limits and create alerts if thresholds are exceeded
 */
async function checkQuotaLimits(
	userId: string,
	orgId: string,
	context: {
		requestId?: string;
		traceId?: string;
	},
): Promise<void> {
	const quota = await getUsageQuota(userId, orgId);

	if (!quota || !quota.tokenQuota) {
		return;
	}

	const usagePercent = (quota.tokenUsed / quota.tokenQuota) * 100;

	// Alert at 80% usage
	if (usagePercent >= 80 && usagePercent < 100) {
		await createUsageAlert(userId, orgId, {
			severity: "medium",
			type: "token_quota_warning",
			message: `Token usage at ${usagePercent.toFixed(1)}% (${quota.tokenUsed}/${quota.tokenQuota})`,
			metadata: {
				threshold: 80,
				currentValue: usagePercent,
			},
		});
	}

	// Alert at 100% usage
	if (usagePercent >= 100) {
		await createUsageAlert(userId, orgId, {
			severity: "high",
			type: "token_quota_exceeded",
			message: `Token quota exceeded: ${quota.tokenUsed}/${quota.tokenQuota}`,
			metadata: {
				threshold: 100,
				currentValue: usagePercent,
				actionRequired: true,
			},
		});

		// Log to audit
		await logAudit({
			orgId,
			userId,
			action: "quota.exceeded",
			resourceType: "user",
			status: "failure",
			requestId: context.requestId,
			traceId: context.traceId,
		});
	}
}

/**
 * Get usage summary for an organization
 */
export async function getOrgUsageSummary(orgId: string): Promise<{
	totalTokens: number;
	totalSessions: number;
	totalUsers: number;
	topUsers: Array<{ userId: string; tokenUsed: number }>;
	modelBreakdown: Array<{ modelId: string; tokenUsed: number }>;
}> {
	const db = getDb();

	// Total tokens across all sessions
	const totalTokensResult = await db
		.select({
			total: sql<number>`coalesce(sum(${sessions.tokenCount}), 0)`,
		})
		.from(sessions)
		.where(eq(sessions.orgId, orgId));

	const totalTokens = Number(totalTokensResult[0]?.total) || 0;

	// Total sessions
	const totalSessionsResult = await db
		.select({
			count: sql<number>`count(*)`,
		})
		.from(sessions)
		.where(eq(sessions.orgId, orgId));

	const totalSessions = Number(totalSessionsResult[0]?.count) || 0;

	// Total users
	const totalUsersResult = await db
		.select({
			count: sql<number>`count(*)`,
		})
		.from(orgMemberships)
		.where(eq(orgMemberships.orgId, orgId));

	const totalUsers = Number(totalUsersResult[0]?.count) || 0;

	// Top users by token usage
	const topUsers = await db
		.select({
			userId: orgMemberships.userId,
			tokenUsed: orgMemberships.tokenUsed,
		})
		.from(orgMemberships)
		.where(eq(orgMemberships.orgId, orgId))
		.orderBy(desc(orgMemberships.tokenUsed))
		.limit(10);

	// Model breakdown
	const modelBreakdown = await db
		.select({
			modelId: modelApprovals.modelId,
			tokenUsed: modelApprovals.tokenUsed,
		})
		.from(modelApprovals)
		.where(eq(modelApprovals.orgId, orgId))
		.orderBy(desc(modelApprovals.tokenUsed));

	return {
		totalTokens,
		totalSessions,
		totalUsers,
		topUsers: topUsers.map((u) => ({
			userId: u.userId,
			tokenUsed: u.tokenUsed,
		})),
		modelBreakdown: modelBreakdown.map((m) => ({
			modelId: m.modelId,
			tokenUsed: m.tokenUsed,
		})),
	};
}

/**
 * Estimate cost for a model and token count
 */
export function estimateCost(
	modelId: string,
	provider: string,
	inputTokens: number,
	outputTokens: number,
): number {
	// Cost in cents per 1M tokens
	const COSTS: Record<string, { input: number; output: number }> = {
		"anthropic/claude-sonnet-4-5": { input: 300, output: 1500 },
		"anthropic/claude-opus-4": { input: 1500, output: 7500 },
		"openai/gpt-4": { input: 3000, output: 6000 },
		"openai/gpt-4-turbo": { input: 1000, output: 3000 },
		"openai/gpt-3.5-turbo": { input: 50, output: 150 },
	};

	const key = `${provider}/${modelId}`;
	const cost = COSTS[key] || { input: 100, output: 300 };

	const inputCost = (inputTokens / 1_000_000) * cost.input;
	const outputCost = (outputTokens / 1_000_000) * cost.output;

	return Math.ceil(inputCost + outputCost);
}

// ============================================================================
// BACKWARD COMPATIBILITY
// ============================================================================

export const TokenTracker = {
	recordUsage: recordTokenUsage,
	getQuota: getUsageQuota,
	canConsumeTokens,
	resetQuota: resetUserQuota,
	getOrgUsageSummary,
	estimateCost,
};
