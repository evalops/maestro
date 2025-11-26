/**
 * Enterprise Audit Integration
 * Connects enterprise context events to the audit logger
 */

import { AUDIT_ACTIONS, logAudit, logToolExecution } from "../audit/logger.js";
import { isDatabaseConfigured } from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { enterpriseContext } from "./context.js";

const logger = createLogger("enterprise:audit");

let initialized = false;

/**
 * Initialize audit integration - connects context events to audit logger
 */
export function initializeAuditIntegration(): void {
	if (initialized) return;
	if (!isDatabaseConfigured()) {
		logger.debug("Audit integration skipped - database not configured");
		return;
	}

	enterpriseContext.on("sessionStarted", async (session) => {
		const ctx = enterpriseContext.getAuditContext();
		if (!ctx) return;

		try {
			await logAudit({
				...ctx,
				sessionId: session.sessionId,
				action: AUDIT_ACTIONS.SESSION_CREATE,
				resourceType: "session",
				resourceId: session.sessionId,
				status: "success",
				metadata: {
					model: session.modelId,
				},
			});
		} catch (error) {
			logger.error(
				"Failed to log session start",
				error instanceof Error ? error : undefined,
			);
		}
	});

	enterpriseContext.on("sessionEnded", async (sessionId) => {
		const ctx = enterpriseContext.getAuditContext();
		if (!ctx) return;

		try {
			await logAudit({
				...ctx,
				sessionId,
				action: AUDIT_ACTIONS.SESSION_UPDATE,
				resourceType: "session",
				resourceId: sessionId,
				status: "success",
			});
		} catch (error) {
			logger.error(
				"Failed to log session end",
				error instanceof Error ? error : undefined,
			);
		}
	});

	enterpriseContext.on("toolExecuted", async (toolName, status) => {
		const ctx = enterpriseContext.getAuditContext();
		if (!ctx) return;

		const auditStatus =
			status === "success"
				? "success"
				: status === "denied"
					? "denied"
					: "failure";

		try {
			await logToolExecution(ctx, toolName, undefined, auditStatus);
		} catch (error) {
			logger.error(
				"Failed to log tool execution",
				error instanceof Error ? error : undefined,
			);
		}
	});

	initialized = true;
	logger.debug("Audit integration initialized");
}

/**
 * Log a sensitive tool execution with full details
 */
export async function logSensitiveToolExecution(
	toolName: string,
	args: Record<string, unknown>,
	status: "success" | "failure" | "denied",
	durationMs?: number,
	error?: string,
): Promise<void> {
	if (!isDatabaseConfigured()) return;

	const ctx = enterpriseContext.getAuditContext();
	if (!ctx) return;

	const command =
		typeof args.command === "string"
			? args.command
			: typeof args.path === "string"
				? args.path
				: undefined;

	try {
		await logToolExecution(ctx, toolName, command, status, durationMs, error);
	} catch (err) {
		logger.error(
			"Failed to log sensitive tool execution",
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * Log model selection/change
 */
export async function logModelSelection(
	modelId: string,
	provider: string,
): Promise<void> {
	if (!isDatabaseConfigured()) return;

	const ctx = enterpriseContext.getAuditContext();
	if (!ctx) return;

	try {
		await logAudit({
			...ctx,
			action: AUDIT_ACTIONS.MODEL_SELECT,
			resourceType: "model",
			resourceId: modelId,
			status: "success",
			metadata: {
				model: modelId,
			},
		});
	} catch (error) {
		logger.error(
			"Failed to log model selection",
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * Log file access for sensitive paths
 */
export async function logSensitiveFileAccess(
	action: "read" | "write" | "delete",
	filePath: string,
	status: "success" | "failure" | "denied",
	hasPii = false,
): Promise<void> {
	if (!isDatabaseConfigured()) return;

	const ctx = enterpriseContext.getAuditContext();
	if (!ctx) return;

	const { logFileAccess } = await import("../audit/logger.js");

	try {
		await logFileAccess(ctx, action, filePath, status, hasPii);
	} catch (error) {
		logger.error(
			"Failed to log file access",
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * Log policy violation
 */
export async function logPolicyViolation(
	resource: string,
	action: string,
	reason: string,
): Promise<void> {
	if (!isDatabaseConfigured()) return;

	const ctx = enterpriseContext.getAuditContext();
	if (!ctx) return;

	const { logPermissionDenied } = await import("../audit/logger.js");

	try {
		await logPermissionDenied(ctx, resource, action, reason);
	} catch (error) {
		logger.error(
			"Failed to log policy violation",
			error instanceof Error ? error : undefined,
		);
	}
}
