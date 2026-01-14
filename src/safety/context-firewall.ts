/**
 * Context Firewall - Deep payload sanitization for tool arguments
 *
 * This module provides sanitization of tool arguments before they are logged,
 * stored, or transmitted. It protects against:
 *
 * 1. **Credential Leakage**: Detects and redacts API keys, secrets, tokens
 * 2. **Control Character Injection**: Removes dangerous control characters
 * 3. **Large Payload Attacks**: Truncates oversized strings with hash suffix
 * 4. **PEM/Certificate Leakage**: Detects and redacts private keys
 *
 * ## Usage
 *
 * ```typescript
 * import { sanitizePayload, detectSensitiveContent } from "./context-firewall.js";
 *
 * // Sanitize before logging
 * const sanitized = sanitizePayload(toolArgs);
 * logger.info("Tool call", { args: sanitized });
 *
 * // Check for sensitive content before transmission
 * const findings = detectSensitiveContent(payload);
 * if (findings.length > 0) {
 *   // Handle sensitive content detection
 * }
 * ```
 *
 * @module safety/context-firewall
 */

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:context-firewall");

/** Maximum string length before truncation */
const MAX_STRING_LENGTH = 4096;

/** Maximum depth for recursive sanitization */
const MAX_RECURSION_DEPTH = 20;

/** Maximum array length before truncation */
const MAX_ARRAY_LENGTH = 100;

/**
 * Sensitive content finding from detection
 */
export interface SensitiveContentFinding {
	type:
		| "api_key"
		| "aws_secret"
		| "private_key"
		| "jwt_token"
		| "password"
		| "control_char"
		| "base64_blob"
		| "generic_secret";
	path: string;
	description: string;
	severity: "high" | "medium" | "low";
}

/**
 * Sanitization options
 */
export interface SanitizeOptions {
	/** Maximum string length (default: 4096) */
	maxStringLength?: number;
	/** Maximum recursion depth (default: 20) */
	maxDepth?: number;
	/** Maximum array length (default: 100) */
	maxArrayLength?: number;
	/** Remove control characters (default: true) */
	removeControlChars?: boolean;
	/** Redact detected secrets (default: true) */
	redactSecrets?: boolean;
	/** Truncate large base64 blobs (default: true) */
	truncateLargeBlobs?: boolean;
}

/**
 * Credential patterns for detection
 *
 * Each pattern is designed to minimize false positives while catching
 * common credential formats.
 */
const CREDENTIAL_PATTERNS: Array<{
	name: string;
	type: SensitiveContentFinding["type"];
	pattern: RegExp;
	severity: SensitiveContentFinding["severity"];
}> = [
	// API Keys - various formats
	{
		name: "Generic API Key",
		type: "api_key",
		pattern:
			/(?:api[_-]?key|apikey|api[_-]?token)['":\s=]+['"]?([a-zA-Z0-9_\-]{20,})/gi,
		severity: "high",
	},
	{
		name: "OpenAI API Key",
		type: "api_key",
		pattern: /sk-[a-zA-Z0-9]{20,}/g,
		severity: "high",
	},
	{
		name: "Anthropic API Key",
		type: "api_key",
		pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
		severity: "high",
	},
	{
		name: "GitHub Token",
		type: "api_key",
		pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g,
		severity: "high",
	},
	{
		name: "Slack Token",
		type: "api_key",
		pattern: /xox[baprs]-[a-zA-Z0-9\-]{10,}/g,
		severity: "high",
	},
	{
		name: "Stripe Key",
		type: "api_key",
		pattern: /(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}/g,
		severity: "high",
	},

	// AWS Credentials
	{
		name: "AWS Access Key ID",
		type: "aws_secret",
		pattern: /AKIA[A-Z0-9]{16}/g,
		severity: "high",
	},
	{
		name: "AWS Secret Access Key",
		type: "aws_secret",
		pattern:
			/(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?key)['":\s=]+['"]?([a-zA-Z0-9/+=]{40})/gi,
		severity: "high",
	},

	// Private Keys
	{
		name: "RSA Private Key",
		type: "private_key",
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
		severity: "high",
	},
	{
		name: "PGP Private Key",
		type: "private_key",
		pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
		severity: "high",
	},

	// JWT Tokens
	{
		name: "JWT Token",
		type: "jwt_token",
		pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
		severity: "medium",
	},

	// Password patterns
	{
		name: "Password in URL",
		type: "password",
		pattern: /:\/\/[^:]+:([^@]+)@/g,
		severity: "high",
	},
	{
		name: "Password Assignment",
		type: "password",
		pattern:
			/(?:password|passwd|pwd|secret)['":\s=]+['"]?([^'"\s]{8,})/gi,
		severity: "medium",
	},

	// Generic secrets
	{
		name: "Bearer Token",
		type: "generic_secret",
		pattern: /Bearer\s+[a-zA-Z0-9_\-\.]+/gi,
		severity: "medium",
	},
	{
		name: "Authorization Header",
		type: "generic_secret",
		pattern: /Authorization['":\s]+['"]?(?:Basic|Bearer|Token)\s+[a-zA-Z0-9_\-\./+=]+/gi,
		severity: "medium",
	},
];

/**
 * Control characters that should be removed (0x00-0x1f except common whitespace, and 0x7f)
 */
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Pattern to detect large base64-like blobs
 */
const BASE64_BLOB_PATTERN = /^[A-Za-z0-9+/=]{1000,}$/;

/**
 * Check if a string looks like a large base64 blob
 */
function isLargeBase64Blob(value: string): boolean {
	return value.length > 1000 && BASE64_BLOB_PATTERN.test(value);
}

/**
 * Generate a truncation hash for a string
 */
function truncationHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Remove control characters from a string
 */
function removeControlChars(value: string): string {
	return value.replace(CONTROL_CHAR_PATTERN, "");
}

/**
 * Truncate a string with hash suffix
 */
function truncateWithHash(
	value: string,
	maxLength: number,
	reason: string,
): string {
	const hash = truncationHash(value);
	const suffix = `...[${reason}:${hash}]`;
	const truncatedLength = maxLength - suffix.length;
	if (truncatedLength <= 0) {
		return `[${reason}:${hash}]`;
	}
	return value.slice(0, truncatedLength) + suffix;
}

/**
 * Redact a sensitive value while preserving some context
 */
function redactSensitiveValue(value: string, type: string): string {
	// Keep first/last few chars for debugging
	if (value.length > 8) {
		const prefix = value.slice(0, 4);
		const suffix = value.slice(-4);
		return `${prefix}...[REDACTED:${type}]...${suffix}`;
	}
	return `[REDACTED:${type}]`;
}

/**
 * Detect sensitive content in a string value
 */
function detectInString(
	value: string,
	path: string,
): SensitiveContentFinding[] {
	const findings: SensitiveContentFinding[] = [];

	// Check for control characters
	if (CONTROL_CHAR_PATTERN.test(value)) {
		findings.push({
			type: "control_char",
			path,
			description: "Contains control characters that may indicate injection",
			severity: "low",
		});
	}

	// Check for base64 blobs
	if (isLargeBase64Blob(value)) {
		findings.push({
			type: "base64_blob",
			path,
			description: `Large base64-like blob detected (${value.length} chars)`,
			severity: "low",
		});
	}

	// Check credential patterns
	for (const { name, type, pattern, severity } of CREDENTIAL_PATTERNS) {
		// Reset lastIndex for global patterns
		pattern.lastIndex = 0;
		if (pattern.test(value)) {
			findings.push({
				type,
				path,
				description: `Possible ${name} detected`,
				severity,
			});
		}
	}

	return findings;
}

/**
 * Detect sensitive content in a payload (recursive)
 */
export function detectSensitiveContent(
	payload: unknown,
	path = "$",
	depth = 0,
): SensitiveContentFinding[] {
	if (depth > MAX_RECURSION_DEPTH) {
		return [];
	}

	const findings: SensitiveContentFinding[] = [];

	if (typeof payload === "string") {
		findings.push(...detectInString(payload, path));
	} else if (Array.isArray(payload)) {
		for (let i = 0; i < Math.min(payload.length, MAX_ARRAY_LENGTH); i++) {
			findings.push(
				...detectSensitiveContent(payload[i], `${path}[${i}]`, depth + 1),
			);
		}
	} else if (payload !== null && typeof payload === "object") {
		for (const [key, value] of Object.entries(payload)) {
			// Check if key name suggests sensitive content
			const sensitiveKeyPattern =
				/(?:password|secret|token|key|credential|auth|api[_-]?key)/i;
			if (sensitiveKeyPattern.test(key) && typeof value === "string") {
				findings.push({
					type: "generic_secret",
					path: `${path}.${key}`,
					description: `Sensitive key name "${key}" with string value`,
					severity: "medium",
				});
			}
			findings.push(
				...detectSensitiveContent(value, `${path}.${key}`, depth + 1),
			);
		}
	}

	return findings;
}

/**
 * Sanitize a string value
 */
function sanitizeString(
	value: string,
	options: Required<SanitizeOptions>,
): string {
	let result = value;

	// Remove control characters
	if (options.removeControlChars) {
		result = removeControlChars(result);
	}

	// Redact secrets
	if (options.redactSecrets) {
		for (const { pattern, type } of CREDENTIAL_PATTERNS) {
			pattern.lastIndex = 0;
			result = result.replace(pattern, (match) =>
				redactSensitiveValue(match, type),
			);
		}
	}

	// Handle large base64 blobs
	if (options.truncateLargeBlobs && isLargeBase64Blob(result)) {
		result = truncateWithHash(result, 200, "base64");
	}

	// Truncate if still too long
	if (result.length > options.maxStringLength) {
		result = truncateWithHash(result, options.maxStringLength, "truncated");
	}

	return result;
}

/**
 * Sanitize a payload recursively
 */
function sanitizeValue(
	value: unknown,
	options: Required<SanitizeOptions>,
	depth: number,
): unknown {
	if (depth > options.maxDepth) {
		return "[MAX_DEPTH_EXCEEDED]";
	}

	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === "string") {
		return sanitizeString(value, options);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (Array.isArray(value)) {
		const sanitized = value
			.slice(0, options.maxArrayLength)
			.map((item) => sanitizeValue(item, options, depth + 1));
		if (value.length > options.maxArrayLength) {
			sanitized.push(`[...${value.length - options.maxArrayLength} more items]`);
		}
		return sanitized;
	}

	if (typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			sanitized[key] = sanitizeValue(val, options, depth + 1);
		}
		return sanitized;
	}

	// For other types (functions, symbols, etc.), return type description
	return `[${typeof value}]`;
}

/**
 * Sanitize a payload for safe logging/storage
 *
 * This function recursively processes a payload to:
 * - Remove control characters
 * - Redact detected credentials and secrets
 * - Truncate oversized strings
 * - Handle large base64 blobs
 * - Limit recursion depth and array lengths
 *
 * @param payload - The payload to sanitize
 * @param options - Sanitization options
 * @returns Sanitized copy of the payload
 */
export function sanitizePayload(
	payload: unknown,
	options: SanitizeOptions = {},
): unknown {
	const fullOptions: Required<SanitizeOptions> = {
		maxStringLength: options.maxStringLength ?? MAX_STRING_LENGTH,
		maxDepth: options.maxDepth ?? MAX_RECURSION_DEPTH,
		maxArrayLength: options.maxArrayLength ?? MAX_ARRAY_LENGTH,
		removeControlChars: options.removeControlChars ?? true,
		redactSecrets: options.redactSecrets ?? true,
		truncateLargeBlobs: options.truncateLargeBlobs ?? true,
	};

	return sanitizeValue(payload, fullOptions, 0);
}

/**
 * Check if a payload contains any high-severity sensitive content
 */
export function containsHighSeverityContent(payload: unknown): boolean {
	const findings = detectSensitiveContent(payload);
	return findings.some((f) => f.severity === "high");
}

/**
 * Create a sanitization summary for logging
 */
export function createSanitizationSummary(
	original: unknown,
	sanitized: unknown,
): { changed: boolean; findings: SensitiveContentFinding[] } {
	const findings = detectSensitiveContent(original);
	const originalStr = JSON.stringify(original);
	const sanitizedStr = JSON.stringify(sanitized);
	return {
		changed: originalStr !== sanitizedStr,
		findings,
	};
}

/**
 * Firewall check result
 */
export interface ContextFirewallResult {
	allowed: boolean;
	sanitizedPayload: unknown;
	findings: SensitiveContentFinding[];
	blocked?: boolean;
	blockReason?: string;
}

/**
 * Context Firewall - Main entry point for payload checking
 *
 * This function:
 * 1. Detects sensitive content in the payload
 * 2. Sanitizes the payload for safe usage
 * 3. Optionally blocks payloads with high-severity content
 *
 * @param payload - The payload to check
 * @param options - Options including whether to block on high severity
 * @returns Result with sanitized payload and findings
 */
export function checkContextFirewall(
	payload: unknown,
	options: SanitizeOptions & { blockHighSeverity?: boolean } = {},
): ContextFirewallResult {
	const findings = detectSensitiveContent(payload);
	const sanitizedPayload = sanitizePayload(payload, options);

	const highSeverityFindings = findings.filter((f) => f.severity === "high");

	if (options.blockHighSeverity && highSeverityFindings.length > 0) {
		const types = [...new Set(highSeverityFindings.map((f) => f.type))];
		logger.warn("Context firewall blocked payload with high-severity content", {
			types,
			findingCount: highSeverityFindings.length,
		});
		return {
			allowed: false,
			sanitizedPayload,
			findings,
			blocked: true,
			blockReason: `High-severity sensitive content detected: ${types.join(", ")}`,
		};
	}

	if (findings.length > 0) {
		logger.debug("Context firewall detected sensitive content", {
			findingCount: findings.length,
			severities: findings.map((f) => f.severity),
		});
	}

	return {
		allowed: true,
		sanitizedPayload,
		findings,
	};
}
