/**
 * PII Detection and Redaction System
 * Uses regex patterns to detect and redact sensitive information
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("pii-detector");

// ============================================================================
// BUILT-IN PII PATTERNS
// ============================================================================

export interface PiiPattern {
	name: string;
	pattern: RegExp;
	replacement: string;
	description: string;
}

export const BUILT_IN_PII_PATTERNS: PiiPattern[] = [
	// Email addresses
	{
		name: "email",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
		replacement: "[EMAIL_REDACTED]",
		description: "Email addresses",
	},
	// Phone numbers (various formats)
	{
		name: "phone_us",
		pattern:
			/\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
		replacement: "[PHONE_REDACTED]",
		description: "US phone numbers",
	},
	// Social Security Numbers
	{
		name: "ssn",
		pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
		replacement: "[SSN_REDACTED]",
		description: "Social Security Numbers",
	},
	// Credit card numbers (Visa, Mastercard, Amex, Discover)
	{
		name: "credit_card",
		pattern:
			/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
		replacement: "[CREDIT_CARD_REDACTED]",
		description: "Credit card numbers",
	},
	// API keys (common patterns)
	{
		name: "api_key_generic",
		pattern:
			/\b(?:api[_-]?key|apikey|api[_-]?token)[\s:=]+['\"]?([a-zA-Z0-9_\-]{20,})['\"]?/gi,
		replacement: "api_key=[API_KEY_REDACTED]",
		description: "Generic API keys",
	},
	// AWS Access Keys
	{
		name: "aws_access_key",
		pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
		replacement: "[AWS_KEY_REDACTED]",
		description: "AWS access keys",
	},
	// AWS Secret Keys - require context keywords to reduce false positives
	{
		name: "aws_secret_key",
		pattern:
			/(?:aws_secret|secret_key|secret_access_key|aws_secret_access_key)['":\s=]*([a-zA-Z0-9/+=]{40})/gi,
		replacement: "[AWS_SECRET_REDACTED]",
		description: "AWS secret keys with context keywords",
	},
	// GitHub tokens
	{
		name: "github_token",
		pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g,
		replacement: "[GITHUB_TOKEN_REDACTED]",
		description: "GitHub personal access tokens",
	},
	// JWT tokens
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g,
		replacement: "[JWT_REDACTED]",
		description: "JWT tokens",
	},
	// IP addresses (IPv4)
	{
		name: "ipv4",
		pattern:
			/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
		replacement: "[IP_REDACTED]",
		description: "IPv4 addresses",
	},
	// Private keys (PEM format)
	{
		name: "private_key",
		pattern:
			/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
		replacement: "[PRIVATE_KEY_REDACTED]",
		description: "Private keys in PEM format",
	},
	// OAuth tokens
	{
		name: "oauth_token",
		pattern:
			/\b(oauth[_-]?token|access[_-]?token)[\s:=]+['\"]?([a-zA-Z0-9_\-\.]{20,})['\"]?/gi,
		replacement: "oauth_token=[OAUTH_TOKEN_REDACTED]",
		description: "OAuth tokens",
	},
	// Database connection strings
	{
		name: "db_connection",
		pattern: /\b(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s]+/gi,
		replacement: "[DB_CONNECTION_REDACTED]",
		description: "Database connection strings with credentials",
	},
	// Passwords in URLs or config
	{
		name: "password",
		pattern: /\b(password|passwd|pwd)[\s:=]+['\"]?([^\s'\"]{8,})['\"]?/gi,
		replacement: "password=[PASSWORD_REDACTED]",
		description: "Passwords in configuration",
	},
];

// ============================================================================
// PII DETECTOR CLASS
// ============================================================================

export interface PiiDetectionResult {
	hasPii: boolean;
	detectedPatterns: string[];
	redactedContent: string;
	originalLength: number;
	redactedLength: number;
}

export class PiiDetector {
	private patterns: PiiPattern[];

	constructor(customPatterns: PiiPattern[] = []) {
		this.patterns = [...BUILT_IN_PII_PATTERNS, ...customPatterns];
	}

	/**
	 * Detect PII in content without redacting
	 */
	detect(content: string): { hasPii: boolean; patterns: string[] } {
		const detectedPatterns = new Set<string>();

		for (const pattern of this.patterns) {
			if (pattern.pattern.test(content)) {
				detectedPatterns.add(pattern.name);
			}
		}

		return {
			hasPii: detectedPatterns.size > 0,
			patterns: Array.from(detectedPatterns),
		};
	}

	/**
	 * Detect and redact PII from content
	 */
	redact(content: string): PiiDetectionResult {
		let redactedContent = content;
		const detectedPatterns = new Set<string>();

		for (const pattern of this.patterns) {
			// Reset regex lastIndex to avoid issues with global flags
			pattern.pattern.lastIndex = 0;

			if (pattern.pattern.test(content)) {
				detectedPatterns.add(pattern.name);
				// Reset again before replace
				pattern.pattern.lastIndex = 0;
				redactedContent = redactedContent.replace(
					pattern.pattern,
					pattern.replacement,
				);
			}
		}

		return {
			hasPii: detectedPatterns.size > 0,
			detectedPatterns: Array.from(detectedPatterns),
			redactedContent,
			originalLength: content.length,
			redactedLength: redactedContent.length,
		};
	}

	/**
	 * Redact PII from structured data (objects)
	 */
	redactObject<T extends Record<string, unknown>>(obj: T): T {
		const redacted: Record<string, unknown> = { ...obj };

		for (const [key, value] of Object.entries(redacted)) {
			if (typeof value === "string") {
				const result = this.redact(value);
				if (result.hasPii) {
					redacted[key] = result.redactedContent;
				}
			} else if (typeof value === "object" && value !== null) {
				redacted[key] = this.redactObject(value as Record<string, unknown>);
			}
		}

		return redacted as T;
	}

	/**
	 * Add custom PII patterns
	 */
	addPattern(pattern: PiiPattern): void {
		this.patterns.push(pattern);
		logger.info("Added custom PII pattern", { name: pattern.name });
	}

	/**
	 * Add patterns from regex strings (for user-defined patterns)
	 */
	addPatternFromString(
		name: string,
		patternStr: string,
		replacement: string,
		description: string,
	): void {
		try {
			const pattern = buildPatternFromString(patternStr);

			this.addPattern({
				name,
				pattern,
				replacement,
				description,
			});
		} catch (error) {
			logger.error(
				"Invalid regex pattern",
				error instanceof Error ? error : undefined,
				{
					name,
					pattern: patternStr,
				},
			);
			throw new Error(`Invalid regex pattern: ${patternStr}`);
		}
	}

	/**
	 * Get all registered patterns
	 */
	getPatterns(): Array<Omit<PiiPattern, "pattern"> & { pattern: string }> {
		return this.patterns.map((p) => ({
			name: p.name,
			pattern: p.pattern.source,
			replacement: p.replacement,
			description: p.description,
		}));
	}
}

function buildPatternFromString(patternStr: string): RegExp {
	const normalized = patternStr.trim();
	if (!normalized) {
		throw new Error("Empty regex pattern");
	}

	// Add global flag if not present, and whitelist common safe flags
	const flagMatch = normalized.match(/\/([gimuy]*)$/);
	const flagsFromInput = flagMatch ? flagMatch[1] : "";
	const flags = (
		flagsFromInput.includes("g") ? flagsFromInput : `${flagsFromInput}g`
	)
		.split("")
		.filter(
			(char, idx, arr) => "gimuy".includes(char) && arr.indexOf(char) === idx,
		)
		.join("");

	const source = normalized.replace(/^\/|\/[gimuy]*$/g, "");
	if (source.length > 500) {
		throw new Error("Regex pattern too long");
	}

	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return new RegExp(source, flags || "g");
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let globalDetector: PiiDetector | null = null;

export function getGlobalPiiDetector(): PiiDetector {
	if (!globalDetector) {
		globalDetector = new PiiDetector();
	}
	return globalDetector;
}

export function initializePiiDetector(customPatterns: PiiPattern[] = []): void {
	globalDetector = new PiiDetector(customPatterns);
	logger.info("PII detector initialized", {
		totalPatterns: globalDetector.getPatterns().length,
		customPatterns: customPatterns.length,
	});
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Quick check if content contains PII
 */
export function hasPii(content: string): boolean {
	return getGlobalPiiDetector().detect(content).hasPii;
}

/**
 * Quick redact of content
 */
export function redactPii(content: string): string {
	return getGlobalPiiDetector().redact(content).redactedContent;
}

/**
 * Redact PII from command-line arguments
 * Special handling for common CLI patterns like --api-key=value
 */
export function redactCommandLine(command: string): string {
	let redacted = command;

	// Redact common flag patterns
	const flagPatterns = [
		/--api[_-]?key[\s=]+[^\s]+/gi,
		/--token[\s=]+[^\s]+/gi,
		/--password[\s=]+[^\s]+/gi,
		/--secret[\s=]+[^\s]+/gi,
		/-k[\s=]+[^\s]+/g, // Short form API key
		/-p[\s=]+[^\s]+/g, // Short form password
	];

	for (const pattern of flagPatterns) {
		redacted = redacted.replace(pattern, (match) => {
			const [flag] = match.split(/[\s=]/);
			return `${flag}=[REDACTED]`;
		});
	}

	// Apply general PII redaction
	return redactPii(redacted);
}

/**
 * Redact environment variables from object
 */
export function redactEnvVars(
	env: Record<string, string>,
): Record<string, string> {
	const redacted: Record<string, string> = {};
	const sensitiveKeys = [
		"API_KEY",
		"TOKEN",
		"SECRET",
		"PASSWORD",
		"PASSWD",
		"PWD",
		"AUTH",
		"CREDENTIAL",
		"PRIVATE_KEY",
	];

	for (const [key, value] of Object.entries(env)) {
		const shouldRedact = sensitiveKeys.some((sensitive) =>
			key.toUpperCase().includes(sensitive),
		);

		if (shouldRedact) {
			redacted[key] = "[REDACTED]";
		} else {
			redacted[key] = value;
		}
	}

	return redacted;
}
