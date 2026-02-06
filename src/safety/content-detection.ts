/**
 * Content Detection - Sensitive content detection and value redaction/vaulting
 *
 * Provides functions to detect sensitive content (credentials, secrets, control chars)
 * in arbitrary payloads and to redact or vault detected values.
 *
 * @module safety/content-detection
 */

import { createHash } from "node:crypto";
import {
	CONTROL_CHAR_PATTERN,
	CREDENTIAL_PATTERN_DEFS,
	type SensitiveContentFinding,
	createPatternRegex,
	isLargeBase64Blob,
	truncationHash,
} from "./credential-patterns.js";
import type { CredentialStore, CredentialType } from "./credential-store.js";

/** Maximum recursion depth for recursive detection */
const MAX_RECURSION_DEPTH = 20;

/** Maximum array length for recursive detection */
const MAX_ARRAY_LENGTH = 100;

// ============================================================================
// VALUE TRANSFORMATION
// ============================================================================

/**
 * Truncate a string with hash suffix
 */
export function truncateWithHash(
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
 * Redact a sensitive value using hash-based identification
 *
 * Uses SHA-256 hash of the value for identification without leaking
 * any portion of the actual secret. The hash allows correlation between
 * redacted instances of the same secret without exposing the secret itself.
 */
export function redactSensitiveValue(value: string, type: string): string {
	// Use first 8 chars of SHA-256 hash for identification
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `[REDACTED:${type}:${hash}]`;
}

/**
 * Map finding type to credential store type
 */
export function mapToCredentialType(
	findingType: SensitiveContentFinding["type"],
): CredentialType {
	switch (findingType) {
		case "api_key":
			return "api_key";
		case "aws_secret":
			return "secret";
		case "private_key":
			return "private_key";
		case "jwt_token":
			return "token";
		case "password":
			return "password";
		case "generic_secret":
			return "secret";
		default:
			return "unknown";
	}
}

/**
 * Vault a sensitive value in the credential store
 *
 * Stores the value securely and returns a reference that can be
 * resolved at tool execution time.
 */
export function vaultSensitiveValue(
	value: string,
	type: string,
	store: CredentialStore,
): string {
	const credType = mapToCredentialType(type as SensitiveContentFinding["type"]);
	return store.store(value, credType);
}

// ============================================================================
// DETECTION
// ============================================================================

/**
 * Detect sensitive content in a string value
 */
export function detectInString(
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

	// Check credential patterns (create fresh regex to avoid lastIndex issues)
	for (const def of CREDENTIAL_PATTERN_DEFS) {
		const pattern = createPatternRegex(def);
		if (pattern.test(value)) {
			findings.push({
				type: def.type,
				path,
				description: `Possible ${def.name} detected`,
				severity: def.severity,
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
