/**
 * Enterprise Authentication Handlers
 * Registration, login, and current user endpoints
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { AUDIT_ACTIONS, AuditLogger } from "../../audit/logger.js";
import { generateTokenPair } from "../../auth/jwt.js";
import {
	hashPassword,
	validatePasswordStrength,
	verifyPassword,
} from "../../auth/password.js";
import { getDb } from "../../db/client.js";
import {
	orgMemberships,
	organizations,
	roles,
	users,
} from "../../db/schema.js";
import { seedDefaultDirectoryRules } from "../../security/directory-access.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../../server/server-utils.js";
import { createLogger } from "../../utils/logger.js";
import { authenticateJWT } from "../enterprise-routes.js";

const logger = createLogger("enterprise-api");

export const getDummyPasswordHash = (() => {
	let cached: string | null = null;
	return async () => {
		if (cached) return cached;
		cached = await hashPassword("invalid-credentials-placeholder");
		return cached;
	};
})();

export async function handleRegister(
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

			if (!createdUser || !createdOrg) {
				throw new Error("Failed to create user or organization");
			}

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

export async function handleLogin(
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

export async function handleMe(
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
