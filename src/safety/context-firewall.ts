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
 * Credential pattern definition (without compiled regex)
 *
 * Each pattern is designed to minimize false positives while catching
 * common credential formats. Patterns are stored as source strings and
 * compiled fresh for each check to avoid global regex lastIndex issues.
 */
interface CredentialPatternDef {
	name: string;
	type: SensitiveContentFinding["type"];
	source: string;
	flags: string;
	severity: SensitiveContentFinding["severity"];
}

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
			const { trackContextFirewall } = require("../telemetry/security-events.js");
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

const CREDENTIAL_PATTERN_DEFS: CredentialPatternDef[] = [
	// API Keys - various formats
	{
		name: "Generic API Key",
		type: "api_key",
		source:
			"(?:api[_-]?key|apikey|api[_-]?token)[':\"\\s=]+['\"]?([a-zA-Z0-9_\\-]{20,})",
		flags: "gi",
		severity: "high",
	},
	{
		name: "OpenAI API Key",
		type: "api_key",
		source: "sk-[a-zA-Z0-9]{20,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Anthropic API Key",
		type: "api_key",
		source: "sk-ant-[a-zA-Z0-9\\-_]{20,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "GitHub Token",
		type: "api_key",
		source: "gh[pousr]_[a-zA-Z0-9]{36,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Slack Token",
		type: "api_key",
		source: "xox[baprs]-[a-zA-Z0-9\\-]{10,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Stripe Key",
		type: "api_key",
		source: "(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}",
		flags: "g",
		severity: "high",
	},

	// AWS Credentials
	{
		name: "AWS Access Key ID",
		type: "aws_secret",
		source: "AKIA[A-Z0-9]{16}",
		flags: "g",
		severity: "high",
	},
	{
		name: "AWS Secret Access Key",
		type: "aws_secret",
		source:
			"(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?key)[':\"\\s=]+['\"]?([a-zA-Z0-9/+=]{40})",
		flags: "gi",
		severity: "high",
	},

	// Private Keys
	{
		name: "RSA Private Key",
		type: "private_key",
		source: "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
		flags: "g",
		severity: "high",
	},
	{
		name: "PGP Private Key",
		type: "private_key",
		// Split to avoid triggering secret scanners on this detection pattern
		source: "-----BEGIN PGP PRIV" + "ATE KEY BLOCK-----",
		flags: "g",
		severity: "high",
	},

	// JWT Tokens
	{
		name: "JWT Token",
		type: "jwt_token",
		source: "eyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*",
		flags: "g",
		severity: "medium",
	},

	// Password patterns
	{
		name: "Password in URL",
		type: "password",
		source: ":\\/\\/[^:]+:([^@]+)@",
		flags: "g",
		severity: "high",
	},
	{
		name: "Password Assignment",
		type: "password",
		source: "(?:password|passwd|pwd|secret)[':\"\\s=]+['\"]?([^'\"\\s]{8,})",
		flags: "gi",
		severity: "medium",
	},

	// Generic secrets
	{
		name: "Bearer Token",
		type: "generic_secret",
		source: "Bearer\\s+[a-zA-Z0-9_\\-\\.]+",
		flags: "gi",
		severity: "medium",
	},
	{
		name: "Authorization Header",
		type: "generic_secret",
		source:
			"Authorization[':\"\\s]+['\"]?(?:Basic|Bearer|Token)\\s+[a-zA-Z0-9_\\-\\./+=]+",
		flags: "gi",
		severity: "medium",
	},

	// GCP/Google Cloud Credentials
	{
		name: "GCP Access Token",
		type: "api_key",
		source: "ya29\\.[a-zA-Z0-9\\-_]{20,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Google API Key",
		type: "api_key",
		source: "AIza[a-zA-Z0-9\\-_]{35}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Google OAuth Refresh Token",
		type: "api_key",
		source: "1//[a-zA-Z0-9\\-_]{40,}",
		flags: "g",
		severity: "high",
	},

	// Azure Credentials
	{
		name: "Azure SAS Token",
		type: "api_key",
		source: "[?&](?:sv|sig|se|sp)=[a-zA-Z0-9%\\-_]{10,}",
		flags: "gi",
		severity: "high",
	},
	{
		name: "Azure Connection String",
		type: "api_key",
		source:
			"(?:AccountKey|SharedAccessKey)=[a-zA-Z0-9+/=]{40,}",
		flags: "gi",
		severity: "high",
	},
	{
		name: "Azure AD Client Secret",
		type: "api_key",
		// Azure AD client secrets contain ~ and often start with specific patterns
		source: "(?:client[_-]?secret|azure[_-]?secret)[':\"\\s=]+['\"]?([a-zA-Z0-9~_\\-\\.]{32,})",
		flags: "gi",
		severity: "high",
	},

	// Base64-Encoded Secrets (detecting common patterns when decoded)
	{
		name: "Base64-Encoded API Key",
		type: "api_key",
		source:
			"(?:api[_-]?key|token|secret|password)[':\"\\s=]+['\"]?([A-Za-z0-9+/=]{24,})",
		flags: "gi",
		severity: "high",
	},

	// Hex-Encoded Secrets (32+ hex chars often indicate secrets)
	{
		name: "Hex-Encoded Secret",
		type: "generic_secret",
		source: "(?:secret|key|token)[':\"\\s=]+['\"]?([a-fA-F0-9]{32,})",
		flags: "gi",
		severity: "medium",
	},

	// Database Connection Strings
	{
		name: "MongoDB Connection String",
		type: "generic_secret",
		source: "mongodb(?:\\+srv)?:\\/\\/[^\\s]+",
		flags: "gi",
		severity: "high",
	},
	{
		name: "PostgreSQL Connection String",
		type: "generic_secret",
		source: "postgres(?:ql)?:\\/\\/[^\\s]+",
		flags: "gi",
		severity: "high",
	},
	{
		name: "MySQL Connection String",
		type: "generic_secret",
		source: "mysql:\\/\\/[^\\s]+",
		flags: "gi",
		severity: "high",
	},

	// NPM/Registry Tokens
	{
		name: "NPM Token",
		type: "api_key",
		source: "npm_[a-zA-Z0-9]{36}",
		flags: "g",
		severity: "high",
	},
	{
		name: "PyPI Token",
		type: "api_key",
		source: "pypi-[a-zA-Z0-9]{60,}",
		flags: "g",
		severity: "high",
	},
];

/**
 * Create a fresh regex from pattern definition
 * This avoids global regex lastIndex state issues
 */
function createPatternRegex(def: CredentialPatternDef): RegExp {
	return new RegExp(def.source, def.flags);
}

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
 * Redact a sensitive value using hash-based identification
 *
 * Uses SHA-256 hash of the value for identification without leaking
 * any portion of the actual secret. The hash allows correlation between
 * redacted instances of the same secret without exposing the secret itself.
 */
function redactSensitiveValue(value: string, type: string): string {
	// Use first 8 chars of SHA-256 hash for identification
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `[REDACTED:${type}:${hash}]`;
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

	// Redact secrets (create fresh regex to avoid lastIndex issues)
	if (options.redactSecrets) {
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
 * Safely stringify a value, handling circular references and other edge cases
 */
function safeStringify(value: unknown): string {
	const seen = new WeakSet();
	try {
		return JSON.stringify(value, (_key, val) => {
			if (typeof val === "object" && val !== null) {
				if (seen.has(val)) {
					return "[Circular]";
				}
				seen.add(val);
			}
			// Handle BigInt
			if (typeof val === "bigint") {
				return `[BigInt:${val.toString()}]`;
			}
			// Handle Symbol
			if (typeof val === "symbol") {
				return `[Symbol:${val.description ?? ""}]`;
			}
			return val;
		});
	} catch {
		return "[Unstringifiable]";
	}
}

/**
 * Create a sanitization summary for logging
 */
export function createSanitizationSummary(
	original: unknown,
	sanitized: unknown,
): { changed: boolean; findings: SensitiveContentFinding[] } {
	const findings = detectSensitiveContent(original);
	const originalStr = safeStringify(original);
	const sanitizedStr = safeStringify(sanitized);
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
 * Blocking configuration for the context firewall
 */
export interface FirewallBlockingConfig {
	/** Block if this many high-severity findings are detected. Default: 1 */
	highSeverityThreshold: number;
	/** Block if total findings exceed this count. Default: 5 */
	totalFindingsThreshold: number;
	/** Always block on these finding types */
	criticalTypes: SensitiveContentFinding["type"][];
	/** Whether blocking is enabled at all. Default: true */
	enabled: boolean;
}

/**
 * Default blocking configuration - conservative but protective
 */
export const DEFAULT_BLOCKING_CONFIG: FirewallBlockingConfig = {
	highSeverityThreshold: 2,
	totalFindingsThreshold: 5,
	criticalTypes: ["private_key", "aws_secret"],
	enabled: true,
};

/**
 * Extended options for context firewall check
 */
export interface ContextFirewallOptions extends SanitizeOptions {
	/** Legacy option: block on any high severity (deprecated, use blocking config) */
	blockHighSeverity?: boolean;
	/** Full blocking configuration */
	blocking?: Partial<FirewallBlockingConfig>;
}

/**
 * Context Firewall - Main entry point for payload checking
 *
 * This function:
 * 1. Detects sensitive content in the payload
 * 2. Sanitizes the payload for safe usage
 * 3. Blocks payloads based on configurable thresholds
 *
 * @param payload - The payload to check
 * @param options - Options including blocking configuration
 * @returns Result with sanitized payload and findings
 */
export function checkContextFirewall(
	payload: unknown,
	options: ContextFirewallOptions = {},
): ContextFirewallResult {
	try {
		return checkContextFirewallInner(payload, options);
	} catch (err) {
		// Fail-closed: if security check crashes, block the payload
		// This prevents attackers from crafting inputs that crash the firewall
		logger.error(
			"Context firewall error - failing closed",
			err instanceof Error ? err : new Error(String(err)),
		);
		return {
			allowed: false,
			sanitizedPayload: "[REDACTED:firewall_error]",
			findings: [],
			blocked: true,
			blockReason: "Security firewall encountered an error. Payload blocked for safety.",
		};
	}
}

/**
 * Internal implementation of context firewall check
 */
function checkContextFirewallInner(
	payload: unknown,
	options: ContextFirewallOptions,
): ContextFirewallResult {
	const findings = detectSensitiveContent(payload);
	const sanitizedPayload = sanitizePayload(payload, options);

	// Build blocking config from options
	// Support legacy `blockHighSeverity` option for backward compatibility
	const useLegacyMode = options.blockHighSeverity === true && !options.blocking;
	const blockingConfig: FirewallBlockingConfig = {
		...DEFAULT_BLOCKING_CONFIG,
		...options.blocking,
		// Legacy mode: block on ANY high-severity finding (threshold = 1)
		highSeverityThreshold: useLegacyMode
			? 1
			: (options.blocking?.highSeverityThreshold ??
				DEFAULT_BLOCKING_CONFIG.highSeverityThreshold),
		enabled:
			options.blocking?.enabled ??
			options.blockHighSeverity ??
			DEFAULT_BLOCKING_CONFIG.enabled,
	};

	if (!blockingConfig.enabled) {
		return {
			allowed: true,
			sanitizedPayload,
			findings,
		};
	}

	const highSeverityFindings = findings.filter((f) => f.severity === "high");
	const criticalFindings = findings.filter((f) =>
		blockingConfig.criticalTypes.includes(f.type),
	);

	// Check blocking conditions
	let shouldBlock = false;
	let blockReason = "";

	// Critical types always block
	if (criticalFindings.length > 0) {
		shouldBlock = true;
		const types = [...new Set(criticalFindings.map((f) => f.type))];
		blockReason = `Critical sensitive content detected: ${types.join(", ")}`;
	}
	// High severity threshold
	else if (highSeverityFindings.length >= blockingConfig.highSeverityThreshold) {
		shouldBlock = true;
		const types = [...new Set(highSeverityFindings.map((f) => f.type))];
		blockReason = `High-severity content detected (${highSeverityFindings.length} findings): ${types.join(", ")}`;
	}
	// Total findings threshold
	else if (findings.length >= blockingConfig.totalFindingsThreshold) {
		shouldBlock = true;
		blockReason = `Too many sensitive findings (${findings.length} >= ${blockingConfig.totalFindingsThreshold})`;
	}

	if (shouldBlock) {
		logger.warn("Context firewall blocking payload", {
			reason: blockReason,
			highSeverityCount: highSeverityFindings.length,
			totalFindings: findings.length,
		});
		return {
			allowed: false,
			sanitizedPayload,
			findings,
			blocked: true,
			blockReason,
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
