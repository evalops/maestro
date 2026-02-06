/**
 * Enterprise Member Management Handlers
 * Organization member listing, invitations, role/quota updates, and removal
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { AUDIT_ACTIONS, AuditLogger } from "../../audit/logger.js";
import { getDb } from "../../db/client.js";
import { orgMemberships, users } from "../../db/schema.js";
import {
	ACTIONS,
	PermissionChecker,
	RESOURCES,
} from "../../rbac/permissions.js";
import { readJsonBody, sendJson } from "../../server/server-utils.js";
import { authenticateJWT } from "./middleware.js";

export async function handleGetOrgMembers(
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

export async function handleInviteUser(
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
				name: body.email.split("@")[0] ?? body.email,
			})
			.returning();
		if (!newUser) {
			sendJson(res, 500, { error: "Failed to create user" }, cors, req);
			return;
		}
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

export async function handleUpdateMemberRole(
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

	// Clear permission cache for the updated user to ensure new role takes effect immediately
	PermissionChecker.clearCache(userId, auth.orgId);

	sendJson(res, 200, { success: true }, cors, req);
}

export async function handleUpdateMemberQuota(
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

export async function handleRemoveMember(
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
