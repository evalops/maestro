/**
 * Enterprise Audit Logging System
 * Tracks all user actions, tool executions, and security events
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { type AuditMetadata, alerts, auditLogs } from "../db/schema.js";
import { redactCommandLine, redactPii } from "../security/pii-detector.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("audit");

// ============================================================================
// AUDIT LOG TYPES
// ============================================================================

export type AuditStatus = "success" | "failure" | "error" | "denied";

export interface AuditLogEntry {
	orgId: string;
	userId: string;
	sessionId?: string;
	action: string;
	resourceType?: string;
	resourceId?: string;
	status: AuditStatus;
	ipAddress?: string;
	userAgent?: string;
	requestId?: string;
	traceId?: string;
	metadata?: AuditMetadata;
	durationMs?: number;
}

// ============================================================================
// AUDIT ACTIONS
// ============================================================================

export const AUDIT_ACTIONS = {
	// Authentication
	AUTH_LOGIN: "auth.login",
	AUTH_LOGOUT: "auth.logout",
	AUTH_FAILED: "auth.failed",
	AUTH_TOKEN_REFRESH: "auth.token_refresh",

	// Sessions
	SESSION_CREATE: "session.create",
	SESSION_READ: "session.read",
	SESSION_UPDATE: "session.update",
	SESSION_DELETE: "session.delete",
	SESSION_SHARE: "session.share",

	// Models
	MODEL_SELECT: "model.select",
	MODEL_EXECUTE: "model.execute",
	MODEL_APPROVAL_REQUEST: "model.approval_request",
	MODEL_APPROVAL_GRANT: "model.approval_grant",
	MODEL_APPROVAL_DENY: "model.approval_deny",

	// Tools
	TOOL_BASH_EXECUTE: "tool.bash.execute",
	TOOL_FILE_READ: "tool.file.read",
	TOOL_FILE_WRITE: "tool.file.write",
	TOOL_FILE_DELETE: "tool.file.delete",
	TOOL_GIT_COMMAND: "tool.git.command",
	TOOL_BACKGROUND_START: "tool.background.start",
	TOOL_BACKGROUND_STOP: "tool.background.stop",

	// Users
	USER_CREATE: "user.create",
	USER_UPDATE: "user.update",
	USER_DELETE: "user.delete",
	USER_INVITE: "user.invite",

	// Organizations
	ORG_CREATE: "org.create",
	ORG_UPDATE: "org.update",
	ORG_DELETE: "org.delete",
	ORG_MEMBER_ADD: "org.member.add",
	ORG_MEMBER_REMOVE: "org.member.remove",

	// Roles & Permissions
	ROLE_CREATE: "role.create",
	ROLE_UPDATE: "role.update",
	ROLE_DELETE: "role.delete",
	ROLE_ASSIGN: "role.assign",
	PERMISSION_DENIED: "permission.denied",

	// Configuration
	CONFIG_READ: "config.read",
	CONFIG_WRITE: "config.write",
	CONFIG_DELETE: "config.delete",

	// Directory Access
	DIRECTORY_ACCESS_ALLOWED: "directory.access.allowed",
	DIRECTORY_ACCESS_DENIED: "directory.access.denied",

	// PII
	PII_DETECTED: "pii.detected",
	PII_REDACTED: "pii.redacted",

	// Alerts
	ALERT_TRIGGERED: "alert.triggered",
	ALERT_RESOLVED: "alert.resolved",
} as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function redactMetadata(metadata?: AuditMetadata): AuditMetadata | undefined {
	if (!metadata) return undefined;

	const redacted = { ...metadata };

	if (redacted.command) {
		redacted.command = redactCommandLine(redacted.command);
	}

	if (redacted.error) {
		redacted.error = redactPii(redacted.error);
	}

	return redacted;
}

async function createAlert(alert: {
	orgId: string;
	userId: string | null;
	severity: "critical" | "high" | "medium" | "low" | "info";
	type: string;
	message: string;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	const db = getDb();

	await db.insert(alerts).values({
		orgId: alert.orgId,
		userId: alert.userId,
		severity: alert.severity,
		type: alert.type,
		message: alert.message,
		metadata: alert.metadata,
	});

	logger.warn("Alert created", {
		type: alert.type,
		severity: alert.severity,
		orgId: alert.orgId,
	});
}

async function checkAlertThresholds(entry: AuditLogEntry): Promise<void> {
	try {
		const db = getDb();

		// Check for repeated permission denials (potential attack)
		if (entry.action === AUDIT_ACTIONS.PERMISSION_DENIED) {
			const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
			const recentDenials = await db.query.auditLogs.findMany({
				where: and(
					eq(auditLogs.userId, entry.userId),
					eq(auditLogs.action, AUDIT_ACTIONS.PERMISSION_DENIED),
					gte(auditLogs.createdAt, fiveMinutesAgo),
				),
			});

			if (recentDenials.length >= 5) {
				await createAlert({
					orgId: entry.orgId,
					userId: entry.userId,
					severity: "high",
					type: "permission_denial_spike",
					message: `User has been denied permission ${recentDenials.length} times in the last 5 minutes`,
					metadata: {
						threshold: 5,
						currentValue: recentDenials.length,
					},
				});
			}
		}

		// Check for PII detection
		if (entry.action === AUDIT_ACTIONS.PII_DETECTED) {
			await createAlert({
				orgId: entry.orgId,
				userId: entry.userId,
				severity: "medium",
				type: "pii_detected",
				message: "Personally identifiable information detected in session",
				metadata: {
					sessionId: entry.sessionId,
				},
			});
		}

		// Check for failed auth attempts
		if (entry.action === AUDIT_ACTIONS.AUTH_FAILED) {
			const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
			const recentFailures = await db.query.auditLogs.findMany({
				where: and(
					eq(auditLogs.userId, entry.userId),
					eq(auditLogs.action, AUDIT_ACTIONS.AUTH_FAILED),
					gte(auditLogs.createdAt, tenMinutesAgo),
				),
			});

			if (recentFailures.length >= 3) {
				await createAlert({
					orgId: entry.orgId,
					userId: entry.userId,
					severity: "critical",
					type: "auth_failure_spike",
					message: `Multiple failed authentication attempts detected (${recentFailures.length} in 10 minutes)`,
					metadata: {
						threshold: 3,
						currentValue: recentFailures.length,
						actionRequired: true,
					},
				});
			}
		}
	} catch (error) {
		logger.error(
			"Failed to check alert thresholds",
			error instanceof Error ? error : undefined,
		);
	}
}

// ============================================================================
// PUBLIC AUDIT FUNCTIONS
// ============================================================================

/**
 * Log an audit event
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
	try {
		const db = getDb();

		const redactedMetadata = redactMetadata(entry.metadata);

		await db.insert(auditLogs).values({
			orgId: entry.orgId,
			userId: entry.userId,
			sessionId: entry.sessionId,
			action: entry.action,
			resourceType: entry.resourceType,
			resourceId: entry.resourceId,
			status: entry.status,
			ipAddress: entry.ipAddress,
			userAgent: entry.userAgent,
			requestId: entry.requestId,
			traceId: entry.traceId,
			metadata: redactedMetadata,
			durationMs: entry.durationMs,
		});

		await checkAlertThresholds(entry);
	} catch (error) {
		logger.error(
			"Failed to write audit log",
			error instanceof Error ? error : undefined,
			{
				action: entry.action,
				userId: entry.userId,
			},
		);
	}
}

/**
 * Log tool execution with command redaction
 */
export async function logToolExecution(
	context: {
		orgId: string;
		userId: string;
		sessionId?: string;
		requestId?: string;
		traceId?: string;
	},
	toolName: string,
	command: string | undefined,
	status: AuditStatus,
	durationMs?: number,
	error?: string,
): Promise<void> {
	const redactedCommand = command ? redactCommandLine(command) : undefined;

	await logAudit({
		...context,
		action: `tool.${toolName}.execute`,
		resourceType: "tool",
		status,
		metadata: {
			toolName,
			command: redactedCommand,
			error,
		},
		durationMs,
	});
}

/**
 * Log file access with PII detection
 */
export async function logFileAccess(
	context: {
		orgId: string;
		userId: string;
		sessionId?: string;
		requestId?: string;
		traceId?: string;
	},
	action: "read" | "write" | "delete",
	filePath: string,
	status: AuditStatus,
	hasPii = false,
): Promise<void> {
	await logAudit({
		...context,
		action: `tool.file.${action}`,
		resourceType: "file",
		status,
		metadata: {
			filePath,
		},
	});

	if (hasPii) {
		await logAudit({
			...context,
			action: AUDIT_ACTIONS.PII_DETECTED,
			resourceType: "file",
			status: "success",
			metadata: {
				filePath,
			},
		});
	}
}

/**
 * Log permission denial
 */
export async function logPermissionDenied(
	context: {
		orgId: string;
		userId: string;
		sessionId?: string;
		requestId?: string;
		traceId?: string;
	},
	resource: string,
	action: string,
	reason?: string,
): Promise<void> {
	await logAudit({
		...context,
		action: AUDIT_ACTIONS.PERMISSION_DENIED,
		resourceType: resource,
		status: "denied",
		metadata: {
			deniedReason: reason,
		},
	});
}

/**
 * Log directory access check
 */
export async function logDirectoryAccess(
	context: {
		orgId: string;
		userId: string;
		sessionId?: string;
		requestId?: string;
		traceId?: string;
	},
	filePath: string,
	allowed: boolean,
	matchedRule?: string,
): Promise<void> {
	await logAudit({
		...context,
		action: allowed
			? AUDIT_ACTIONS.DIRECTORY_ACCESS_ALLOWED
			: AUDIT_ACTIONS.DIRECTORY_ACCESS_DENIED,
		resourceType: "directory",
		status: allowed ? "success" : "denied",
		metadata: {
			filePath,
			deniedReason: matchedRule,
		},
	});
}

/**
 * Query audit logs with filters
 */
export async function queryAuditLogs(filters: {
	orgId: string;
	userId?: string;
	sessionId?: string;
	action?: string;
	resourceType?: string;
	status?: AuditStatus;
	startDate?: Date;
	endDate?: Date;
	limit?: number;
	offset?: number;
}) {
	const db = getDb();

	const conditions = [eq(auditLogs.orgId, filters.orgId)];

	if (filters.userId) {
		conditions.push(eq(auditLogs.userId, filters.userId));
	}
	if (filters.sessionId) {
		conditions.push(eq(auditLogs.sessionId, filters.sessionId));
	}
	if (filters.action) {
		conditions.push(eq(auditLogs.action, filters.action));
	}
	if (filters.resourceType) {
		conditions.push(eq(auditLogs.resourceType, filters.resourceType));
	}
	if (filters.status) {
		conditions.push(eq(auditLogs.status, filters.status));
	}
	if (filters.startDate) {
		conditions.push(gte(auditLogs.createdAt, filters.startDate));
	}
	if (filters.endDate) {
		conditions.push(lte(auditLogs.createdAt, filters.endDate));
	}

	return await db.query.auditLogs.findMany({
		where: and(...conditions),
		limit: filters.limit || 100,
		offset: filters.offset || 0,
		orderBy: [desc(auditLogs.createdAt)],
	});
}

/**
 * Export audit logs to CSV
 */
export async function exportAuditLogsToCsv(
	filters: Parameters<typeof queryAuditLogs>[0],
): Promise<string> {
	const logs = await queryAuditLogs(filters);

	const headers = [
		"timestamp",
		"user_id",
		"action",
		"resource_type",
		"resource_id",
		"status",
		"ip_address",
		"duration_ms",
		"metadata",
	];

	const rows = logs.map((log) => [
		log.createdAt.toISOString(),
		log.userId || "",
		log.action,
		log.resourceType || "",
		log.resourceId || "",
		log.status,
		log.ipAddress || "",
		log.durationMs?.toString() || "",
		JSON.stringify(log.metadata || {}),
	]);

	return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

/**
 * Clean up old audit logs based on retention policy
 */
export async function cleanupAuditLogs(
	orgId: string,
	retentionDays = 90,
): Promise<number> {
	const db = getDb();
	const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

	const result = await db
		.delete(auditLogs)
		.where(
			and(eq(auditLogs.orgId, orgId), lte(auditLogs.createdAt, cutoffDate)),
		)
		.returning();

	logger.info("Cleaned up old audit logs", {
		orgId,
		deletedCount: result.length,
		retentionDays,
	});

	return result.length;
}

// ============================================================================
// BACKWARD COMPATIBILITY - Export as class-like object
// ============================================================================

export const AuditLogger = {
	log: logAudit,
	logToolExecution,
	logFileAccess,
	logPermissionDenied,
	logDirectoryAccess,
	query: queryAuditLogs,
	exportToCsv: exportAuditLogsToCsv,
	cleanup: cleanupAuditLogs,
};
