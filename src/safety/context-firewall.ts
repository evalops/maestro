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

import { vaultSensitiveValue } from "./content-detection.js";
import {
	MAX_RECURSION_DEPTH,
	sanitizePayload as sanitizePayloadCore,
} from "./context-firewall-sanitize.js";
import {
	CREDENTIAL_PATTERN_DEFS,
	type SanitizeOptions,
	replaceCredentialPatternMatches,
} from "./credential-patterns.js";
import {
	type CredentialStore,
	credentialStore as defaultCredentialStore,
} from "./credential-store.js";

// Re-export types and functions from extracted modules for backward compatibility
export type {
	SensitiveContentFinding,
	SanitizeOptions,
} from "./credential-patterns.js";
export { detectSensitiveContent } from "./content-detection.js";
export {
	CredentialFragmentTracker,
	credentialFragmentTracker,
} from "./context-firewall-sanitize.js";
export {
	checkContextFirewall,
	containsHighSeverityContent,
	type ContextFirewallOptions,
	type ContextFirewallResult,
	createSanitizationSummary,
	DEFAULT_BLOCKING_CONFIG,
	type FirewallBlockingConfig,
	sanitizeLogMessage,
} from "./firewall-check.js";

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
	return sanitizePayloadCore(payload, {
		...options,
		credentialStore: options.credentialStore ?? defaultCredentialStore,
	});
}

/**
 * Vault credentials in a payload without altering other content.
 *
 * Replaces detected credentials with reference tokens while preserving
 * the original structure and non-credential data.
 */
export function vaultCredentialsInPayload(
	payload: unknown,
	store: CredentialStore = defaultCredentialStore,
): unknown {
	return vaultCredentialsInValue(payload, 0, store);
}

function vaultCredentialsInValue(
	value: unknown,
	depth: number,
	store: CredentialStore,
): unknown {
	if (depth > MAX_RECURSION_DEPTH) {
		return value;
	}

	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === "string") {
		return replaceCredentialPatternMatches(
			value,
			(secret, def) => vaultSensitiveValue(secret, def.type, store),
			CREDENTIAL_PATTERN_DEFS,
		);
	}

	if (Array.isArray(value)) {
		return value.map((item) => vaultCredentialsInValue(item, depth + 1, store));
	}

	if (typeof value === "object") {
		const vaulted: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			vaulted[key] = vaultCredentialsInValue(val, depth + 1, store);
		}
		return vaulted;
	}

	return value;
}
