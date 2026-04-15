/**
 * Enterprise Model Approval Handlers
 * Model approval listing, approve, and deny endpoints
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { AuditLogger } from "../../audit/logger.js";
import { getDb } from "../../db/client.js";
import { modelApprovals } from "../../db/schema.js";
import {
	ACTIONS,
	PermissionChecker,
	RESOURCES,
} from "../../rbac/permissions.js";
import { readJsonBody, sendJson } from "../../server/server-utils.js";
import { authenticateJWT } from "./middleware.js";

export async function handleGetModelApprovals(
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

export async function handleApproveModel(
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

export async function handleDenyModel(
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
