import type { IncomingMessage } from "node:http";
import { SessionManager } from "../session/manager.js";
import {
	decodeScopedSessionId,
	encodeScopedSessionId,
	sanitizeSessionScope,
} from "../session/scope.js";
import { getAuthSubject } from "./authz.js";
import { getRequestToken } from "./server-utils.js";

const SESSION_SCOPE_MODE = (
	process.env.COMPOSER_SESSION_SCOPE ||
	process.env.COMPOSER_MULTI_USER ||
	""
)
	.trim()
	.toLowerCase();

const SESSION_SCOPE_ENABLED =
	SESSION_SCOPE_MODE === "auth" ||
	SESSION_SCOPE_MODE === "true" ||
	SESSION_SCOPE_MODE === "1";

export function resolveSessionScope(req: IncomingMessage): string | null {
	if (!SESSION_SCOPE_ENABLED) return null;
	if (!getRequestToken(req)) return null;
	const subject = getAuthSubject(req);
	if (!subject) return null;
	return sanitizeSessionScope(subject) || null;
}

export function createSessionManagerForRequest(
	req: IncomingMessage,
	continueSession = true,
	customSessionPath?: string,
): SessionManager {
	return createSessionManagerForScope(
		resolveSessionScope(req),
		continueSession,
		customSessionPath,
	);
}

export { decodeScopedSessionId, encodeScopedSessionId };

export function createSessionManagerForScope(
	scope: string | null,
	continueSession = true,
	customSessionPath?: string,
): SessionManager {
	if (scope) {
		return new SessionManager(continueSession, customSessionPath, {
			sessionScope: scope,
		});
	}
	return new SessionManager(continueSession, customSessionPath);
}
