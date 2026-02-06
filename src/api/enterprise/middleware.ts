/**
 * Enterprise middleware shared across route handlers.
 */

import type { IncomingMessage } from "node:http";
import { extractBearerToken, verifyToken } from "../../auth/jwt.js";

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
