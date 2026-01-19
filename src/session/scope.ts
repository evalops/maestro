export const SESSION_SCOPE_SEPARATOR = "::";

export function sanitizeSessionScope(scope: string): string {
	const trimmed = scope.trim();
	if (!trimmed) return "";
	const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
	return sanitized.slice(0, 64);
}

export function encodeScopedSessionId(
	scope: string | null | undefined,
	sessionId: string,
): string {
	const safeScope = scope ? sanitizeSessionScope(scope) : "";
	if (!safeScope) return sessionId;
	return `${safeScope}${SESSION_SCOPE_SEPARATOR}${sessionId}`;
}

export function decodeScopedSessionId(value: string): {
	scope: string | null;
	sessionId: string;
} {
	const separatorIndex = value.indexOf(SESSION_SCOPE_SEPARATOR);
	if (separatorIndex <= 0) {
		return { scope: null, sessionId: value };
	}
	const scope = value.slice(0, separatorIndex);
	const sessionId = value.slice(
		separatorIndex + SESSION_SCOPE_SEPARATOR.length,
	);
	if (!scope || !sessionId) {
		return { scope: null, sessionId: value };
	}
	return { scope, sessionId };
}
