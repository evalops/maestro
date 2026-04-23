import type { IncomingMessage } from "node:http";
import { isDatabaseConfigured } from "../db/client.js";
import { SessionManager } from "../session/manager.js";
import {
	decodeScopedSessionId,
	encodeScopedSessionId,
	sanitizeSessionScope,
} from "../session/scope.js";
import { getArtifactAccessGrantFromRequest } from "./artifact-access.js";
import { getAuthSubject } from "./authz.js";
import { HostedSessionManager } from "./hosted-session-manager.js";
import { getRequestToken } from "./server-utils.js";

const SESSION_SCOPE_MODE = (
	process.env.MAESTRO_SESSION_SCOPE ||
	process.env.MAESTRO_MULTI_USER ||
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
	const artifactAccess = getArtifactAccessGrantFromRequest(req);
	if (artifactAccess) {
		return artifactAccess.scope ?? null;
	}
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

export type WebSessionManager = SessionManager | HostedSessionManager;

function getHostedSessionStorageMode(): string {
	return (
		process.env.MAESTRO_HOSTED_SESSION_STORAGE ??
		process.env.MAESTRO_SESSION_STORAGE ??
		""
	)
		.trim()
		.toLowerCase();
}

function shouldUseHostedDatabaseSessions(scope: string | null): boolean {
	if (!scope) return false;
	const mode = getHostedSessionStorageMode();
	if (mode === "file" || mode === "jsonl" || mode === "filesystem") {
		return false;
	}
	if (mode === "database" || mode === "db" || mode === "postgres") {
		if (!isDatabaseConfigured()) {
			throw new Error(
				"MAESTRO_HOSTED_SESSION_STORAGE=database requires MAESTRO_DATABASE_URL or DATABASE_URL",
			);
		}
		return true;
	}
	return isDatabaseConfigured();
}

export function createWebSessionManagerForRequest(
	req: IncomingMessage,
	continueSession = true,
	customSessionPath?: string,
): WebSessionManager {
	const scope = resolveSessionScope(req);
	if (!customSessionPath && shouldUseHostedDatabaseSessions(scope)) {
		return new HostedSessionManager({
			scope: scope!,
			subject: getAuthSubject(req) || undefined,
		});
	}
	return createSessionManagerForScope(
		scope,
		continueSession,
		customSessionPath,
	);
}

export function createWebSessionManagerForScope(
	scope: string | null,
	continueSession = true,
	customSessionPath?: string,
): WebSessionManager {
	if (!customSessionPath && shouldUseHostedDatabaseSessions(scope)) {
		return new HostedSessionManager({ scope: scope! });
	}
	return createSessionManagerForScope(
		scope,
		continueSession,
		customSessionPath,
	);
}
