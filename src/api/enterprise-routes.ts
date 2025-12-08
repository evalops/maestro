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
	type OrganizationSettings,
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
	decryptOrgSettings,
	encryptOrgSettings,
} from "../db/settings-encryption.js";
import {
	ACTIONS,
	PermissionChecker,
	RESOURCES,
	seedPermissions,
} from "../rbac/permissions.js";
import { seedDefaultDirectoryRules } from "../security/directory-access.js";
import type { Route } from "../server/router.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server/server-utils.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("enterprise-api");

const getDummyPasswordHash = (() => {
	let cached: string | null = null;
	return async () => {
		if (cached) return cached;
		cached = await hashPassword("invalid-credentials-placeholder");
		return cached;
	};
})();

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

		const passwordHash = await hashPassword(password);
		const slug = (orgName || `${name}-org`)
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-");

		const { user, org, ownerRole } = await db.transaction(async (tx) => {
			const [createdUser] = await tx
				.insert(users)
				.values({
					email,
					name,
					passwordHash,
				})
				.returning();

			const [createdOrg] = await tx
				.insert(organizations)
				.values({
					name: orgName || `${name}'s Organization`,
					slug,
				})
				.returning();

			const systemOwnerRole = await tx.query.roles.findFirst({
				where: and(eq(roles.name, "org_owner"), eq(roles.isSystem, true)),
			});

			if (!systemOwnerRole) {
				throw new Error("System roles not initialized");
			}

			await tx.insert(orgMemberships).values({
				userId: createdUser.id,
				orgId: createdOrg.id,
				roleId: systemOwnerRole.id,
			});

			await tx
				.update(users)
				.set({ defaultOrgId: createdOrg.id })
				.where(eq(users.id, createdUser.id));

			await seedDefaultDirectoryRules(createdOrg.id, tx);

			return {
				user: createdUser,
				org: createdOrg,
				ownerRole: systemOwnerRole,
			};
		});

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

		// Always verify a password hash to prevent timing attacks
		// This ensures consistent response time whether user exists or not
		const dummyHash = await getDummyPasswordHash();
		const hashToVerify = user?.passwordHash || dummyHash;
		const valid = await verifyPassword(password, hashToVerify);

		if (!user || !user.passwordHash || !valid) {
			// Send response first, then log asynchronously to prevent timing leaks
			sendJson(res, 401, { error: "Invalid credentials" }, cors, req);

			// Only log if we have valid UUIDs for the audit record
			if (user?.defaultOrgId && user?.id) {
				AuditLogger.log({
					orgId: user.defaultOrgId,
					userId: user.id,
					action: AUDIT_ACTIONS.AUTH_FAILED,
					resourceType: "user",
					status: "failure",
					metadata: { error: "Invalid credentials" },
				}).catch((err) => {
					logger.warn("Failed to log auth failure audit event", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
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
// ORGANIZATION MEMBERS
// ============================================================================

async function handleGetOrgMembers(
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
	const members = await db.query.orgMemberships.findMany({
		where: eq(orgMemberships.orgId, auth.orgId),
		with: {
			user: true,
			role: true,
		},
	});

	const result = members.map((m) => ({
		id: m.id,
		userId: m.userId,
		roleId: m.roleId,
		user: {
			email: m.user.email,
			name: m.user.name,
		},
		role: { id: m.role.id, name: m.role.name },
		tokenQuota: m.tokenQuota,
		tokenUsed: m.tokenUsed,
		joinedAt: m.joinedAt,
	}));

	sendJson(res, 200, { members: result }, cors, req);
}

async function handleInviteUser(
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
		RESOURCES.USERS,
		ACTIONS.WRITE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<{ email: string; roleId: string }>(req);
	if (!body?.email || !body?.roleId) {
		sendJson(res, 400, { error: "email and roleId are required" }, cors, req);
		return;
	}

	const db = getDb();

	// Check if user exists
	let user = await db.query.users.findFirst({
		where: eq(users.email, body.email),
	});

	if (!user) {
		// Create placeholder user
		const [newUser] = await db
			.insert(users)
			.values({
				email: body.email,
				name: body.email.split("@")[0],
			})
			.returning();
		user = newUser;
	}

	// Check if already a member
	const existingMembership = await db.query.orgMemberships.findFirst({
		where: and(
			eq(orgMemberships.orgId, auth.orgId),
			eq(orgMemberships.userId, user.id),
		),
	});

	if (existingMembership) {
		sendJson(res, 409, { error: "User is already a member" }, cors, req);
		return;
	}

	// Create membership
	await db.insert(orgMemberships).values({
		userId: user.id,
		orgId: auth.orgId,
		roleId: body.roleId,
	});

	await AuditLogger.log({
		orgId: auth.orgId,
		userId: auth.userId,
		action: AUDIT_ACTIONS.USER_CREATE,
		resourceType: "org_membership",
		resourceId: user.id,
		status: "success",
	});

	sendJson(res, 201, { success: true, userId: user.id }, cors, req);
}

async function handleUpdateMemberRole(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	userId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.USERS,
		ACTIONS.WRITE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<{ roleId: string }>(req);
	if (!body?.roleId) {
		sendJson(res, 400, { error: "roleId is required" }, cors, req);
		return;
	}

	const db = getDb();
	await db
		.update(orgMemberships)
		.set({ roleId: body.roleId })
		.where(
			and(
				eq(orgMemberships.orgId, auth.orgId),
				eq(orgMemberships.userId, userId),
			),
		);

	sendJson(res, 200, { success: true }, cors, req);
}

async function handleUpdateMemberQuota(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	userId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.USERS,
		ACTIONS.WRITE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<{ tokenQuota: number }>(req);
	if (body?.tokenQuota === undefined) {
		sendJson(res, 400, { error: "tokenQuota is required" }, cors, req);
		return;
	}

	const db = getDb();
	await db
		.update(orgMemberships)
		.set({ tokenQuota: body.tokenQuota })
		.where(
			and(
				eq(orgMemberships.orgId, auth.orgId),
				eq(orgMemberships.userId, userId),
			),
		);

	sendJson(res, 200, { success: true }, cors, req);
}

async function handleRemoveMember(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	userId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.USERS,
		ACTIONS.DELETE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	// Prevent self-removal
	if (userId === auth.userId) {
		sendJson(
			res,
			400,
			{ error: "Cannot remove yourself from organization" },
			cors,
			req,
		);
		return;
	}

	const db = getDb();
	await db
		.delete(orgMemberships)
		.where(
			and(
				eq(orgMemberships.orgId, auth.orgId),
				eq(orgMemberships.userId, userId),
			),
		);

	await AuditLogger.log({
		orgId: auth.orgId,
		userId: auth.userId,
		action: AUDIT_ACTIONS.USER_DELETE,
		resourceType: "org_membership",
		resourceId: userId,
		status: "success",
	});

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
// MODEL APPROVALS
// ============================================================================

async function handleGetModelApprovals(
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
	const approvals = await db.query.modelApprovals.findMany({
		where: eq(modelApprovals.orgId, auth.orgId),
	});

	sendJson(res, 200, { approvals }, cors, req);
}

async function handleApproveModel(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	modelId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.MODELS,
		ACTIONS.ADMIN,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<{
		provider?: string;
		spendLimit?: number;
		tokenLimit?: number;
		restrictedToRoles?: string[];
	}>(req);

	const db = getDb();

	// Upsert approval
	const existing = await db.query.modelApprovals.findFirst({
		where: and(
			eq(modelApprovals.orgId, auth.orgId),
			eq(modelApprovals.modelId, modelId),
		),
	});

	if (existing) {
		await db
			.update(modelApprovals)
			.set({
				status: "approved",
				spendLimit: body?.spendLimit,
				tokenLimit: body?.tokenLimit,
				restrictedToRoles: body?.restrictedToRoles,
				approvedBy: auth.userId,
				approvedAt: new Date(),
			})
			.where(eq(modelApprovals.id, existing.id));
	} else {
		await db.insert(modelApprovals).values({
			orgId: auth.orgId,
			modelId,
			provider: body?.provider || "unknown",
			status: "approved",
			spendLimit: body?.spendLimit,
			tokenLimit: body?.tokenLimit,
			restrictedToRoles: body?.restrictedToRoles,
			approvedBy: auth.userId,
			approvedAt: new Date(),
		});
	}

	await AuditLogger.log({
		orgId: auth.orgId,
		userId: auth.userId,
		action: "model.approve",
		resourceType: "model_approval",
		resourceId: modelId,
		status: "success",
	});

	sendJson(res, 200, { success: true }, cors, req);
}

async function handleDenyModel(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	modelId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.MODELS,
		ACTIONS.ADMIN,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<{ provider?: string; reason?: string }>(req);

	const db = getDb();

	const existing = await db.query.modelApprovals.findFirst({
		where: and(
			eq(modelApprovals.orgId, auth.orgId),
			eq(modelApprovals.modelId, modelId),
		),
	});

	if (existing) {
		await db
			.update(modelApprovals)
			.set({
				status: "denied",
			})
			.where(eq(modelApprovals.id, existing.id));
	} else {
		await db.insert(modelApprovals).values({
			orgId: auth.orgId,
			modelId,
			provider: body?.provider || "unknown",
			status: "denied",
		});
	}

	sendJson(res, 200, { success: true }, cors, req);
}

// ============================================================================
// DIRECTORY ACCESS RULES
// ============================================================================

async function handleGetDirectoryRules(
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
	const rules = await db.query.directoryAccessRules.findMany({
		where: eq(directoryAccessRules.orgId, auth.orgId),
		orderBy: (rules, { desc }) => [desc(rules.priority)],
	});

	sendJson(res, 200, { rules }, cors, req);
}

async function handleCreateDirectoryRule(
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
		RESOURCES.DIRECTORIES,
		ACTIONS.WRITE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const body = await readJsonBody<{
		pattern: string;
		isAllowed: boolean;
		roleIds?: string[];
		description?: string;
		priority?: number;
	}>(req);

	if (!body?.pattern || body?.isAllowed === undefined) {
		sendJson(
			res,
			400,
			{ error: "pattern and isAllowed are required" },
			cors,
			req,
		);
		return;
	}

	const db = getDb();
	const [rule] = await db
		.insert(directoryAccessRules)
		.values({
			orgId: auth.orgId,
			pattern: body.pattern,
			isAllowed: body.isAllowed,
			roleIds: body.roleIds,
			description: body.description,
			priority: body.priority ?? 0,
		})
		.returning();

	sendJson(res, 201, rule, cors, req);
}

async function handleDeleteDirectoryRule(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	ruleId: string,
): Promise<void> {
	const auth = await authenticateJWT(req);
	if (!auth) {
		sendJson(res, 401, { error: "Unauthorized" }, cors, req);
		return;
	}

	const hasPermission = await PermissionChecker.check(
		{ userId: auth.userId, orgId: auth.orgId },
		RESOURCES.DIRECTORIES,
		ACTIONS.DELETE,
	);
	if (!hasPermission) {
		sendJson(res, 403, { error: "Permission denied" }, cors, req);
		return;
	}

	const db = getDb();
	await db
		.delete(directoryAccessRules)
		.where(
			and(
				eq(directoryAccessRules.id, ruleId),
				eq(directoryAccessRules.orgId, auth.orgId),
			),
		);

	sendJson(res, 200, { success: true }, cors, req);
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
