/**
 * Enterprise API Routes
 * Handles authentication, RBAC, organizations, and admin features
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { AUDIT_ACTIONS, AuditLogger } from "../audit/logger.js";
import {
	extractBearerToken,
	generateTokenPair,
	verifyToken,
} from "../auth/jwt.js";
import {
	hashPassword,
	validatePasswordStrength,
	verifyPassword,
} from "../auth/password.js";
import { TokenTracker } from "../billing/token-tracker.js";
import { getDb } from "../db/client.js";
import {
	alerts,
	apiKeys,
	auditLogs,
	directoryAccessRules,
	modelApprovals,
	orgMemberships,
	organizations,
	roles,
	sessions as sessionsTable,
	users,
} from "../db/schema.js";
import {
	ACTIONS,
	PermissionChecker,
	RESOURCES,
	seedPermissions,
} from "../rbac/permissions.js";
import { createLogger } from "../utils/logger.js";
import type { Route } from "../web/router.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../web/server-utils.js";

const logger = createLogger("enterprise-api");

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

export async function authenticateJWT(req: IncomingMessage): Promise<{
	userId: string;
	email: string;
	orgId: string;
	roleId: string;
} | null> {
	const token = extractBearerToken(req.headers.authorization);
	if (!token) {
		return null;
	}

	const payload = verifyToken(token);
	if (!payload || payload.type !== "access") {
		return null;
	}

	return {
		userId: payload.userId,
		email: payload.email,
		orgId: payload.orgId,
		roleId: payload.roleId,
	};
}

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

async function handleRegister(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	try {
		const { email, name, password, orgName } = await readJsonBody<{
			email: string;
			name: string;
			password: string;
			orgName?: string;
		}>(req);

		// Validate input
		if (!email || !name || !password) {
			sendJson(res, 400, { error: "Missing required fields" }, cors, req);
			return;
		}

		// Validate password strength
		const passwordValidation = validatePasswordStrength(password);
		if (!passwordValidation.valid) {
			sendJson(
				res,
				400,
				{ error: "Weak password", details: passwordValidation.errors },
				cors,
				req,
			);
			return;
		}

		const db = getDb();

		// Check if user already exists
		const existingUser = await db.query.users.findFirst({
			where: eq(users.email, email),
		});

		if (existingUser) {
			sendJson(res, 409, { error: "User already exists" }, cors, req);
			return;
		}

		// Create user
		const passwordHash = await hashPassword(password);
		const [user] = await db
			.insert(users)
			.values({
				email,
				name,
				passwordHash,
			})
			.returning();

		// Create organization
		const slug = (orgName || `${name}-org`)
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-");

		const [org] = await db
			.insert(organizations)
			.values({
				name: orgName || `${name}'s Organization`,
				slug,
			})
			.returning();

		// Get owner role
		const ownerRole = await db.query.roles.findFirst({
			where: and(eq(roles.name, "org_owner"), eq(roles.isSystem, true)),
		});

		if (!ownerRole) {
			throw new Error("System roles not initialized");
		}

		// Create membership
		await db.insert(orgMemberships).values({
			userId: user.id,
			orgId: org.id,
			roleId: ownerRole.id,
		});

		// Update user's default org
		await db
			.update(users)
			.set({ defaultOrgId: org.id })
			.where(eq(users.id, user.id));

		// Generate tokens
		const tokens = generateTokenPair({
			userId: user.id,
			email: user.email,
			orgId: org.id,
			roleId: ownerRole.id,
		});

		// Log registration
		await AuditLogger.log({
			orgId: org.id,
			userId: user.id,
			action: AUDIT_ACTIONS.USER_CREATE,
			resourceType: "user",
			status: "success",
		});

		sendJson(
			res,
			201,
			{
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
				},
				organization: {
					id: org.id,
					name: org.name,
					slug: org.slug,
				},
				...tokens,
			},
			cors,
			req,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

async function handleLogin(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	try {
		const { email, password } = await readJsonBody<{
			email: string;
			password: string;
		}>(req);

		if (!email || !password) {
			sendJson(res, 400, { error: "Missing email or password" }, cors, req);
			return;
		}

		const db = getDb();

		// Find user
		const user = await db.query.users.findFirst({
			where: eq(users.email, email),
		});

		if (!user || !user.passwordHash) {
			await AuditLogger.log({
				orgId: user?.defaultOrgId || "",
				userId: user?.id || "",
				action: AUDIT_ACTIONS.AUTH_FAILED,
				resourceType: "user",
				status: "failure",
				metadata: { error: "Invalid credentials" },
			});

			sendJson(res, 401, { error: "Invalid credentials" }, cors, req);
			return;
		}

		// Verify password
		const valid = await verifyPassword(password, user.passwordHash);
		if (!valid) {
			await AuditLogger.log({
				orgId: user.defaultOrgId || "",
				userId: user.id,
				action: AUDIT_ACTIONS.AUTH_FAILED,
				resourceType: "user",
				status: "failure",
				metadata: { error: "Invalid credentials" },
			});

			sendJson(res, 401, { error: "Invalid credentials" }, cors, req);
			return;
		}

		// Get user's default org membership
		const membership = await db.query.orgMemberships.findFirst({
			where: and(
				eq(orgMemberships.userId, user.id),
				eq(orgMemberships.orgId, user.defaultOrgId || ""),
			),
			with: {
				organization: true,
				role: true,
			},
		});

		if (!membership) {
			sendJson(res, 401, { error: "No organization membership" }, cors, req);
			return;
		}

		// Generate tokens
		const tokens = generateTokenPair({
			userId: user.id,
			email: user.email,
			orgId: membership.orgId,
			roleId: membership.roleId,
		});

		// Update last login
		await db
			.update(users)
			.set({ lastLoginAt: new Date() })
			.where(eq(users.id, user.id));

		// Log successful login
		await AuditLogger.log({
			orgId: membership.orgId,
			userId: user.id,
			action: AUDIT_ACTIONS.AUTH_LOGIN,
			resourceType: "user",
			status: "success",
		});

		sendJson(
			res,
			200,
			{
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
				},
				organization: {
					id: membership.organization.id,
					name: membership.organization.name,
					slug: membership.organization.slug,
				},
				...tokens,
			},
			cors,
			req,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

async function handleMe(
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
	const user = await db.query.users.findFirst({
		where: eq(users.id, auth.userId),
		with: {
			defaultOrg: true,
		},
	});

	if (!user) {
		sendJson(res, 404, { error: "User not found" }, cors, req);
		return;
	}

	sendJson(
		res,
		200,
		{
			id: user.id,
			email: user.email,
			name: user.name,
			organization: user.defaultOrg
				? {
						id: user.defaultOrg.id,
						name: user.defaultOrg.name,
						slug: user.defaultOrg.slug,
					}
				: null,
		},
		cors,
		req,
	);
}

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
	];
}
