const SUMMARY_LIMIT = 180;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
	[/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-secret]"],
	[/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted-token]"],
	[/\b(xox[a-zA-Z]?-[A-Za-z0-9-]{16,})\b/g, "[redacted-token]"],
	[/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted-access-key]"],
];

const SENSITIVE_METADATA_KEY_PATTERN =
	/(?:arg|body|command|content|credential|env|header|input|output|password|prompt|request|response|secret|stderr|stdout|token|transcript)/i;

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
				([key, value]) =>
					value !== undefined && !SENSITIVE_METADATA_KEY_PATTERN.test(key),
			)
			.map(([key, value]) => [key, redactMetadataValue(value)]),
	);
	return Object.keys(redacted).length > 0 ? redacted : undefined;
}
