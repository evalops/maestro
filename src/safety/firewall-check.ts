/**
 * Firewall Check - Context firewall entry point and blocking logic
 *
 * Provides the main `checkContextFirewall` function that detects sensitive content,
 * sanitizes payloads, and blocks based on configurable thresholds.
 *
 * @module safety/firewall-check
 */

import { createLogger } from "../utils/logger.js";
import { detectSensitiveContent } from "./content-detection.js";
import { sanitizePayload } from "./context-firewall.js";
import type {
	SanitizeOptions,
	SensitiveContentFinding,
} from "./credential-patterns.js";
import { credentialStore as defaultCredentialStore } from "./credential-store.js";

const logger = createLogger("safety:firewall-check");

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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
 * Sanitize a log message (string) for safe output.
 *
 * Ensures secrets are redacted and never vaulted in log output.
 */
export function sanitizeLogMessage(
	message: string,
	options: SanitizeOptions = {},
): string {
	const sanitized = sanitizePayload(message, {
		...options,
		redactSecrets: options.redactSecrets ?? true,
		vaultCredentials: false,
	});

	if (typeof sanitized === "string") {
		return sanitized;
	}

	return safeStringify(sanitized);
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

// ============================================================================
// TYPES
// ============================================================================

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

// ============================================================================
// FIREWALL CHECK
// ============================================================================

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
			blockReason:
				"Security firewall encountered an error. Payload blocked for safety.",
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
	const store = options.credentialStore ?? defaultCredentialStore;
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

	// When vaultCredentials is enabled, credentials are securely stored and
	// replaced with references - they're no longer "leaked" so we don't block
	if (options.vaultCredentials) {
		logger.debug("Credential vaulting enabled, skipping blocking checks", {
			findingsCount: findings.length,
			vaultedCount: store.size,
		});
		return {
			allowed: true,
			sanitizedPayload,
			findings,
		};
	}

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
	else if (
		highSeverityFindings.length >= blockingConfig.highSeverityThreshold
	) {
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
