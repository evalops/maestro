const SECRET_TOKEN_REGEX = /sk-[A-Za-z0-9-_]{16,}/gi;
const KEYWORD_SECRET_REGEX =
	/\b(?:token|secret|password|key)[^\S\r\n]*[:=][^\S\r\n]*([^\s"']{8,})/gi;
const AWS_ACCESS_KEY_REGEX =
	/\b(?:A3T[A-Z]|AKIA|ASIA|AGPA|AIDA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN_REGEX = /\bgh[opsr]_[A-Za-z0-9]{36,255}\b/g;
const JWT_REGEX =
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const LONG_RANDOM_REGEX = /\b[A-Fa-f0-9]{64,}\b/g;
const BEARER_TOKEN_REGEX = /\bBearer\s+([A-Za-z0-9._\-]+)/gi;
const BASIC_AUTH_REGEX = /\bBasic\s+([A-Za-z0-9+/=]+)\b/gi;
const DYNAMIC_PLACEHOLDER_REGEX = /\[secret:[^\]]+\]/g;

export type SecretMasker = (secret: string) => string;

export function redactSecrets(value: string, maskSecret: SecretMasker): string {
	if (!value) {
		return value;
	}
	let sanitized = value;
	sanitized = sanitized.replace(SECRET_TOKEN_REGEX, (match) =>
		maskSecret(match),
	);
	sanitized = sanitized.replace(KEYWORD_SECRET_REGEX, (full, secret: string) =>
		full.replace(secret, maskSecret(secret)),
	);
	sanitized = sanitized.replace(AWS_ACCESS_KEY_REGEX, (match) =>
		maskSecret(match),
	);
	sanitized = sanitized.replace(GITHUB_TOKEN_REGEX, (match) =>
		maskSecret(match),
	);
	sanitized = sanitized.replace(JWT_REGEX, (match) => maskSecret(match));
	sanitized = sanitized.replace(LONG_RANDOM_REGEX, (match) =>
		maskSecret(match),
	);
	sanitized = sanitized.replace(BEARER_TOKEN_REGEX, (full, token: string) =>
		full.replace(token, maskSecret(token)),
	);
	sanitized = sanitized.replace(BASIC_AUTH_REGEX, (full, token: string) =>
		full.replace(token, maskSecret(token)),
	);
	return sanitized;
}

function normalizeDynamicPlaceholders(value: string): string {
	if (!value) {
		return value;
	}
	return value.replace(DYNAMIC_PLACEHOLDER_REGEX, "[secret]");
}

export function sanitizeWithStaticMask(value: string): string {
	const normalized = normalizeDynamicPlaceholders(value);
	return redactSecrets(normalized, () => "[secret]");
}

export function sanitizeOptionalWithStaticMask(
	value?: string | null,
): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	return sanitizeWithStaticMask(value);
}
