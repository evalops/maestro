const SUMMARY_LIMIT = 180;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
	[/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-secret]"],
	[/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted-token]"],
	[/\b(xox[a-zA-Z]?-[A-Za-z0-9-]{16,})\b/g, "[redacted-token]"],
	[/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted-access-key]"],
];

const ALWAYS_SENSITIVE_KEY_TOKENS = new Set([
	"arg",
	"args",
	"argument",
	"arguments",
	"body",
	"command",
	"commands",
	"content",
	"credential",
	"credentials",
	"env",
	"header",
	"headers",
	"input",
	"inputs",
	"output",
	"outputs",
	"password",
	"passwords",
	"prompt",
	"prompts",
	"secret",
	"secrets",
	"stderr",
	"stdout",
	"token",
	"tokens",
	"transcript",
	"transcripts",
]);

const SENSITIVE_EXACT_KEYS = new Set(["request", "response"]);

const REQUEST_RESPONSE_BODY_TOKENS = new Set([
	"body",
	"content",
	"data",
	"payload",
	"raw",
	"text",
]);

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

export function redactTimelineSecrets(value: string): string {
	let redacted = value;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

export function compactTimelineSummary(value: unknown): string | undefined {
	const text = stringValue(value);
	if (!text) return undefined;
	const singleLine = redactTimelineSecrets(text.replace(/\s+/g, " ").trim());
	if (!singleLine) return undefined;
	if (singleLine.length <= SUMMARY_LIMIT) return singleLine;
	return `${singleLine.slice(0, SUMMARY_LIMIT - 3)}...`;
}

export function compactTimelineMetadata(
	values: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const metadata = Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	);
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function keyTokens(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

function isSensitiveMetadataKey(key: string): boolean {
	const tokens = keyTokens(key);
	if (!tokens.length) {
		return false;
	}
	if (SENSITIVE_EXACT_KEYS.has(tokens.join("_"))) {
		return true;
	}
	if (tokens.some((token) => ALWAYS_SENSITIVE_KEY_TOKENS.has(token))) {
		return true;
	}
	const hasRequestOrResponse =
		tokens.includes("request") || tokens.includes("response");
	return (
		hasRequestOrResponse &&
		tokens.some((token) => REQUEST_RESPONSE_BODY_TOKENS.has(token))
	);
}

function redactMetadataValue(value: unknown): unknown {
	if (typeof value === "string") {
		return compactTimelineSummary(value);
	}
	if (Array.isArray(value)) {
		return value.map(redactMetadataValue).filter((item) => item !== undefined);
	}
	if (value && typeof value === "object") {
		return redactTimelineMetadata(value as Record<string, unknown>);
	}
	return value;
}

export function redactTimelineMetadata(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!metadata) {
		return undefined;
	}
	const redacted = Object.fromEntries(
		Object.entries(metadata)
			.filter(
				([key, value]) => value !== undefined && !isSensitiveMetadataKey(key),
			)
			.map(([key, value]) => [key, redactMetadataValue(value)]),
	);
	return Object.keys(redacted).length > 0 ? redacted : undefined;
}
