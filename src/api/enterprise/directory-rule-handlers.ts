/**
 * Enterprise Directory Access Rule Handlers
 * Directory rule listing, creation, and deletion endpoints
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { directoryAccessRules } from "../../db/schema.js";
import {
	ACTIONS,
	PermissionChecker,
	RESOURCES,
} from "../../rbac/permissions.js";
import { readJsonBody, sendJson } from "../../server/server-utils.js";
import { authenticateJWT } from "./middleware.js";

export async function handleGetDirectoryRules(
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

export async function handleCreateDirectoryRule(
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

export async function handleDeleteDirectoryRule(
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
