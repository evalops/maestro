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

import { createLogger } from "../utils/logger.js";
import {
	redactSensitiveValue,
	truncateWithHash,
	vaultSensitiveValue,
} from "./content-detection.js";
import {
	CREDENTIAL_PATTERN_DEFS,
	type SanitizeOptions,
	createPatternRegex,
	isLargeBase64Blob,
	removeControlChars,
} from "./credential-patterns.js";
import {
	type CredentialStore,
	credentialStore as defaultCredentialStore,
} from "./credential-store.js";

const logger = createLogger("safety:context-firewall");

// Re-export types and functions from extracted modules for backward compatibility
export type {
	SensitiveContentFinding,
	SanitizeOptions,
} from "./credential-patterns.js";
export { detectSensitiveContent } from "./content-detection.js";
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

/** Maximum string length before truncation */
const MAX_STRING_LENGTH = 4096;

/** Maximum depth for recursive sanitization */
const MAX_RECURSION_DEPTH = 20;

/** Maximum array length before truncation */
const MAX_ARRAY_LENGTH = 100;

// ============================================================================
// CREDENTIAL FRAGMENT TRACKER
// ============================================================================

/**
 * Credential Fragment Tracker - Detects split credentials across multiple calls
 *
 * Attackers may split credentials across multiple tool calls to evade detection:
 * - Call 1: "sk-"
 * - Call 2: "abc123def456"
 *
 * This tracker maintains a sliding window of potential fragments and attempts
 * to reassemble them.
 */
export class CredentialFragmentTracker {
	/** Time window for fragment tracking (5 minutes) */
	private readonly windowMs = 5 * 60 * 1000;
	/** Maximum fragments to track */
	private readonly maxFragments = 100;
	/** Fragments with timestamps */
	private fragments: Array<{ value: string; timestamp: number }> = [];
	/** Known credential prefixes to track */
	private readonly credentialPrefixes = [
		"sk-", // OpenAI, Anthropic
		"ghp_", // GitHub Personal Access Token
		"gho_", // GitHub OAuth
		"github_pat_", // GitHub PAT
		"xoxb-", // Slack Bot Token
		"xoxp-", // Slack User Token
		"AKIA", // AWS Access Key ID
		"ya29.", // GCP Access Token
		"eyJ", // JWT/Base64 JSON
		"AIza", // Google API Key
		"npm_", // NPM Token
		"pypi-", // PyPI Token
	];
	/** Minimum fragment length to consider */
	private readonly minFragmentLength = 3;

	/**
	 * Record a potential credential fragment
	 */
	recordFragment(value: string): void {
		// Only track strings that look like potential credential parts
		if (typeof value !== "string" || value.length < this.minFragmentLength) {
			return;
		}

		// Check if this looks like a credential prefix or continuation
		const isPrefix = this.credentialPrefixes.some((p) =>
			value.toLowerCase().startsWith(p.toLowerCase()),
		);
		const looksLikeCredentialPart =
			isPrefix ||
			/^[a-zA-Z0-9_\-+/=]{8,}$/.test(value) || // Base64-ish or alphanumeric
			/^[a-fA-F0-9]{16,}$/.test(value); // Hex

		if (!looksLikeCredentialPart) {
			return;
		}

		this.fragments.push({ value, timestamp: Date.now() });
		this.pruneOldFragments();

		// Check for assembled credentials
		this.checkAssembledCredentials();
	}

	/**
	 * Prune fragments outside the time window
	 */
	private pruneOldFragments(): void {
		const cutoff = Date.now() - this.windowMs;
		this.fragments = this.fragments
			.filter((f) => f.timestamp > cutoff)
			.slice(-this.maxFragments);
	}

	/**
	 * Check if assembled fragments match credential patterns
	 */
	private checkAssembledCredentials(): void {
		// Try various combinations of recent fragments
		const recentFragments = this.fragments.slice(-10);

		for (let i = 0; i < recentFragments.length; i++) {
			// Try assembling 2-4 consecutive fragments
			for (let len = 2; len <= Math.min(4, recentFragments.length - i); len++) {
				const assembled = recentFragments
					.slice(i, i + len)
					.map((f) => f.value)
					.join("");

				if (this.looksLikeAssembledCredential(assembled)) {
					logger.warn("Potential split credential detected", {
						fragmentCount: len,
						assembledLength: assembled.length,
						// Don't log the actual value for security
					});
					// Track this as a security event
					this.trackSplitCredentialDetection(len, assembled.length);
				}
			}
		}
	}

	/**
	 * Check if an assembled string looks like a credential
	 */
	private looksLikeAssembledCredential(value: string): boolean {
		// Check against common credential patterns
		const credentialPatterns = [
			/^sk-[a-zA-Z0-9]{40,}$/, // OpenAI-style
			/^ghp_[a-zA-Z0-9]{36}$/, // GitHub PAT
			/^AKIA[A-Z0-9]{16}$/, // AWS Access Key ID
			/^[a-zA-Z0-9]{32,}$/, // Generic long alphanumeric
			/^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/, // JWT
		];

		return credentialPatterns.some((p) => p.test(value));
	}

	/**
	 * Track split credential detection event
	 */
	private trackSplitCredentialDetection(
		fragmentCount: number,
		totalLength: number,
	): void {
		// Import would create circular dependency, so we do inline require
		// This is a rare event so the performance impact is minimal
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const {
				trackContextFirewall,
			} = require("../telemetry/security-events.js");
			trackContextFirewall({
				findingTypes: ["split_credential"],
				findingCount: 1,
				blocked: true,
				metadata: { fragmentCount, totalLength },
			});
		} catch {
			// Telemetry not available, just log
			logger.warn("Split credential tracking failed");
		}
	}

	/**
	 * Clear all tracked fragments
	 */
	clear(): void {
		this.fragments = [];
	}

	/**
	 * Get fragment count for testing
	 */
	getFragmentCount(): number {
		return this.fragments.length;
	}
}

/** Global credential fragment tracker instance */
export const credentialFragmentTracker = new CredentialFragmentTracker();

// ============================================================================
// SANITIZATION CORE
// ============================================================================

/**
 * Sanitize a string value
 */
function sanitizeString(
	value: string,
	options: Required<SanitizeOptions>,
): string {
	let result = value;

	// Track potential credential fragments for split credential detection
	// This must happen before any sanitization to capture the original value
	credentialFragmentTracker.recordFragment(value);

	// Remove control characters
	if (options.removeControlChars) {
		result = removeControlChars(result);
	}

	// Handle secrets: vault or redact (create fresh regex to avoid lastIndex issues)
	if (options.vaultCredentials) {
		// Vault mode: store credentials securely and replace with references
		for (const def of CREDENTIAL_PATTERN_DEFS) {
			const pattern = createPatternRegex(def);
			result = result.replace(pattern, (match) =>
				vaultSensitiveValue(match, def.type, options.credentialStore),
			);
		}
	} else if (options.redactSecrets) {
		// Redact mode: replace with hash-based redaction markers
		for (const def of CREDENTIAL_PATTERN_DEFS) {
			const pattern = createPatternRegex(def);
			result = result.replace(pattern, (match) =>
				redactSensitiveValue(match, def.type),
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
			sanitized.push(
				`[...${value.length - options.maxArrayLength} more items]`,
			);
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

	// Handle BigInt explicitly
	if (typeof value === "bigint") {
		return `[bigint:${value.toString()}]`;
	}

	// Handle Symbol explicitly
	if (typeof value === "symbol") {
		return `[symbol:${value.description ?? "unnamed"}]`;
	}

	// For other types (functions, etc.), return type description
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
		vaultCredentials: options.vaultCredentials ?? false,
		credentialStore: options.credentialStore ?? defaultCredentialStore,
	};

	return sanitizeValue(payload, fullOptions, 0);
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
		let result = value;
		for (const def of CREDENTIAL_PATTERN_DEFS) {
			const pattern = createPatternRegex(def);
			result = result.replace(pattern, (match) =>
				vaultSensitiveValue(match, def.type, store),
			);
		}
		return result;
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
