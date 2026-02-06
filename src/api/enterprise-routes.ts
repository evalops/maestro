/**
 * Enterprise API Routes
 * Handles authentication, RBAC, organizations, and admin features
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { AuditLogger } from "../audit/logger.js";
import { TokenTracker } from "../billing/token-tracker.js";
import { getDb } from "../db/client.js";
import {
	type OrganizationSettings,
	alerts,
	organizations,
	roles,
} from "../db/schema.js";
import {
	decryptOrgSettings,
	encryptOrgSettings,
} from "../db/settings-encryption.js";
import {
	ACTIONS,
	PermissionChecker,
	RESOURCES,
	seedPermissions,
} from "../rbac/permissions.js";
import type { Route } from "../server/router.js";
import { readJsonBody, sendJson } from "../server/server-utils.js";
import { createLogger } from "../utils/logger.js";
import {
	handleLogin,
	handleMe,
	handleRegister,
} from "./enterprise/auth-handlers.js";
import {
	handleCreateDirectoryRule,
	handleDeleteDirectoryRule,
	handleGetDirectoryRules,
} from "./enterprise/directory-rule-handlers.js";
import {
	handleGetOrgMembers,
	handleInviteUser,
	handleRemoveMember,
	handleUpdateMemberQuota,
	handleUpdateMemberRole,
} from "./enterprise/member-handlers.js";
import { authenticateJWT } from "./enterprise/middleware.js";
import {
	handleApproveModel,
	handleDenyModel,
	handleGetModelApprovals,
} from "./enterprise/model-approval-handlers.js";

const logger = createLogger("enterprise-api");

// ============================================================================
// USAGE & QUOTA ENDPOINTS
// ============================================================================

async function handleUsageQuota(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const quota = await TokenTracker.getQuota(auth.userId, auth.orgId);
	sendJson(res, 200, quota, cors, req);
}

async function handleOrgUsage(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	// Check permission
	const allowed = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId, roleId: auth.roleId },
		RESOURCES.AUDIT,
		ACTIONS.READ,
	);

	if (!allowed) {
		sendJson(res, 403, { error: "Forbidden" }, cors, req);
		return;
	}

	const summary = await TokenTracker.getOrgUsageSummary(auth.orgId);
	sendJson(res, 200, summary, cors, req);
}

// ============================================================================
// AUDIT LOG ENDPOINTS
// ============================================================================

async function handleAuditLogs(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	// Check permission
	const allowed = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId, roleId: auth.roleId },
		RESOURCES.AUDIT,
		ACTIONS.READ,
	);

	if (!allowed) {
		sendJson(res, 403, { error: "Forbidden" }, cors, req);
		return;
	}

	const logs = await AuditLogger.query({
		orgId: auth.orgId,
		limit: 100,
	});

	sendJson(res, 200, { logs }, cors, req);
}

// ============================================================================
// ALERT ENDPOINTS
// ============================================================================

async function handleAlerts(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const db = getDb();
	const userAlerts = await db.query.alerts.findMany({
		where: and(eq(alerts.orgId, auth.orgId), eq(alerts.userId, auth.userId)),
		orderBy: (alerts, { desc }) => [desc(alerts.createdAt)],
		limit: 50,
	});

	sendJson(res, 200, { alerts: userAlerts }, cors, req);
}

// ============================================================================
// ALERT ACTIONS
// ============================================================================

async function handleMarkAlertRead(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	alertId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const db = getDb();
	await db
		.update(alerts)
		.set({ isRead: true })
		.where(and(eq(alerts.id, alertId), eq(alerts.orgId, auth.orgId)));

	sendJson(res, 200, { success: true }, cors, req);
}

async function handleResolveAlert(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	alertId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const db = getDb();
	await db
		.update(alerts)
		.set({ resolvedAt: new Date() })
		.where(and(eq(alerts.id, alertId), eq(alerts.orgId, auth.orgId)));

	sendJson(res, 200, { success: true }, cors, req);
}

// ============================================================================
// ORGANIZATION SETTINGS
// ============================================================================

async function handleGetOrgSettings(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const db = getDb();
	const org = await db.query.organizations.findFirst({
		where: eq(organizations.id, auth.orgId),
	});

	if (!org) {
		sendJson(res, 404, { error: "Organization not found" }, cors, req);
		return;
	}

	// Decrypt sensitive fields (webhookSigningSecret) before returning
	const decryptedSettings = decryptOrgSettings(org.settings) || {};
	sendJson(res, 200, decryptedSettings, cors, req);
}

async function handleUpdateOrgSettings(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.ORGS,
		ACTIONS.WRITE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<OrganizationSettings>(req);
	if (!body) {
		sendJson(res, 400, { error: "Settings body required" }, cors, req);
		return;
	}

	// Encrypt sensitive fields (webhookSigningSecret) before storing
	const encryptedSettings = encryptOrgSettings(body);

	const db = getDb();
	await db
		.update(organizations)
		.set({ settings: encryptedSettings })
		.where(eq(organizations.id, auth.orgId));

	sendJson(res, 200, { success: true }, cors, req);
}

// ============================================================================
// ROLES
// ============================================================================

async function handleGetRoles(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const db = getDb();
	const orgRoles = await db.query.roles.findMany({
		where: eq(roles.isSystem, true),
	});

	sendJson(res, 200, { roles: orgRoles }, cors, req);
}

// ============================================================================
// INITIALIZE ENTERPRISE FEATURES
// ============================================================================

export async function initializeEnterpriseFeatures(): Promise<void> {
	try {
		logger.info("Initializing enterprise features...");

		// Seed default permissions and roles
		await seedPermissions();

		logger.info("Enterprise features initialized successfully");
	} catch (error) {
		logger.error(
			"Failed to initialize enterprise features",
			error instanceof Error ? error : undefined,
		);
		throw error;
	}
}

// ============================================================================
// ROUTE EXPORTS
// ============================================================================

export function createEnterpriseRoutes(cors: Record<string, string>): Route[] {
	return [
		// Authentication
		{
			method: "POST",
			path: "/api/auth/register",
			handler: (req, res) => handleRegister(req, res, cors),
		},
		{
			method: "POST",
			path: "/api/auth/login",
			handler: (req, res) => handleLogin(req, res, cors),
		},
		{
			method: "GET",
			path: "/api/auth/me",
			handler: (req, res) => handleMe(req, res, cors),
		},

		// Usage & Quotas
		{
			method: "GET",
			path: "/api/usage/quota",
			handler: (req, res) => handleUsageQuota(req, res, cors),
		},
		{
			method: "GET",
			path: "/api/usage/org",
			handler: (req, res) => handleOrgUsage(req, res, cors),
		},

		// Audit Logs
		{
			method: "GET",
			path: "/api/audit/logs",
			handler: (req, res) => handleAuditLogs(req, res, cors),
		},

		// Alerts
		{
			method: "GET",
			path: "/api/alerts",
			handler: (req, res) => handleAlerts(req, res, cors),
		},
		{
			method: "POST",
			path: "/api/alerts/:alertId/read",
			handler: (req, res, params) =>
				handleMarkAlertRead(req, res, cors, params?.alertId || ""),
		},
		{
			method: "POST",
			path: "/api/alerts/:alertId/resolve",
			handler: (req, res, params) =>
				handleResolveAlert(req, res, cors, params?.alertId || ""),
		},

		// Organization Members
		{
			method: "GET",
			path: "/api/org/members",
			handler: (req, res) => handleGetOrgMembers(req, res, cors),
		},
		{
			method: "POST",
			path: "/api/org/members/invite",
			handler: (req, res) => handleInviteUser(req, res, cors),
		},
		{
			method: "PUT",
			path: "/api/org/members/:userId/role",
			handler: (req, res, params) =>
				handleUpdateMemberRole(req, res, cors, params?.userId || ""),
		},
		{
			method: "PUT",
			path: "/api/org/members/:userId/quota",
			handler: (req, res, params) =>
				handleUpdateMemberQuota(req, res, cors, params?.userId || ""),
		},
		{
			method: "DELETE",
			path: "/api/org/members/:userId",
			handler: (req, res, params) =>
				handleRemoveMember(req, res, cors, params?.userId || ""),
		},

		// Organization Settings
		{
			method: "GET",
			path: "/api/org/settings",
			handler: (req, res) => handleGetOrgSettings(req, res, cors),
		},
		{
			method: "PUT",
			path: "/api/org/settings",
			handler: (req, res) => handleUpdateOrgSettings(req, res, cors),
		},

		// Roles
		{
			method: "GET",
			path: "/api/roles",
			handler: (req, res) => handleGetRoles(req, res, cors),
		},

		// Model Approvals
		{
			method: "GET",
			path: "/api/models/approvals",
			handler: (req, res) => handleGetModelApprovals(req, res, cors),
		},
		{
			method: "POST",
			path: "/api/models/approvals/:modelId/approve",
			handler: (req, res, params) =>
				handleApproveModel(req, res, cors, params?.modelId || ""),
		},
		{
			method: "POST",
			path: "/api/models/approvals/:modelId/deny",
			handler: (req, res, params) =>
				handleDenyModel(req, res, cors, params?.modelId || ""),
		},

		// Directory Access Rules
		{
			method: "GET",
			path: "/api/directory-rules",
			handler: (req, res) => handleGetDirectoryRules(req, res, cors),
		},
		{
			method: "POST",
			path: "/api/directory-rules",
			handler: (req, res) => handleCreateDirectoryRule(req, res, cors),
		},
		{
			method: "DELETE",
			path: "/api/directory-rules/:ruleId",
			handler: (req, res, params) =>
				handleDeleteDirectoryRule(req, res, cors, params?.ruleId || ""),
		},
	];
}
