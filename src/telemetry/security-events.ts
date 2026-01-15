/**
 * Security Events Telemetry
 *
 * This module provides telemetry tracking for security-related events
 * from the safety middleware, including:
 *
 * - Loop detection events (exact, similar, cyclic, frequency)
 * - Sequence analysis events (suspicious patterns detected)
 * - Context firewall events (sensitive content detection)
 * - Tool execution security events
 *
 * Events are emitted to the existing telemetry infrastructure and can be
 * used for monitoring, alerting, and compliance.
 *
 * @module telemetry/security-events
 */

import { createLogger } from "../utils/logger.js";
import { persistSecurityEvent } from "./security-event-store.js";

// Lazy logger to avoid module initialization issues in tests
let _logger: ReturnType<typeof createLogger> | undefined;
function getLogger() {
	if (!_logger) {
		_logger = createLogger("telemetry:security");
	}
	return _logger;
}

/**
 * Configuration for event emission
 */
interface EmitConfig {
	/** Whether to persist events to disk. Default: true in production */
	persist: boolean;
}

let emitConfig: EmitConfig = {
	persist: process.env.NODE_ENV !== "test",
};

/**
 * Configure event emission behavior
 */
export function configureSecurityEvents(config: Partial<EmitConfig>): void {
	emitConfig = { ...emitConfig, ...config };
}

/**
 * Security event types
 */
export type SecurityEventType =
	| "loop_detected"
	| "sequence_pattern_detected"
	| "context_firewall_triggered"
	| "tool_blocked"
	| "tool_approval_required"
	| "sensitive_content_detected"
	| "circuit_breaker_state_change"
	| "adaptive_threshold_anomaly";

/**
 * Severity levels for security events
 */
export type SecuritySeverity = "low" | "medium" | "high" | "critical";

/**
 * Base security event structure
 */
export interface SecurityEvent {
	/** Event type */
	type: SecurityEventType;
	/** Event severity */
	severity: SecuritySeverity;
	/** Timestamp */
	timestamp: number;
	/** Tool name involved (if applicable) */
	toolName?: string;
	/** Human-readable description */
	description: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Loop detection event
 */
export interface LoopDetectionEvent extends SecurityEvent {
	type: "loop_detected";
	metadata: {
		loopType: "exact" | "similar" | "cyclic" | "frequency";
		repetitions: number;
		toolName: string;
		action: "warn" | "pause" | "halt";
	};
}

/**
 * Sequence pattern event
 */
export interface SequencePatternEvent extends SecurityEvent {
	type: "sequence_pattern_detected";
	metadata: {
		patternId: string;
		toolName: string;
		action: "allow" | "require_approval" | "block";
		matchingTools?: string[];
	};
}

/**
 * Context firewall event
 */
export interface ContextFirewallEvent extends SecurityEvent {
	type: "context_firewall_triggered";
	metadata: {
		findingTypes: string[];
		findingCount: number;
		blocked: boolean;
		toolName?: string;
	};
}

/**
 * In-memory event buffer for batch processing
 */
const eventBuffer: SecurityEvent[] = [];
const MAX_BUFFER_SIZE = 1000;

/**
 * Event deduplication configuration
 */
interface DeduplicationConfig {
	/** Time window for deduplication in ms. Events with same signature within window are deduplicated. */
	windowMs: number;
	/** Maximum entries in dedup cache before pruning */
	maxCacheSize: number;
}

const DEDUP_CONFIG: DeduplicationConfig = {
	windowMs: 5000, // 5 second dedup window
	maxCacheSize: 500,
};

/**
 * Deduplication cache: signature -> last emission timestamp
 */
const dedupCache = new Map<string, number>();

/**
 * Generate a signature for event deduplication
 * Events with same type, tool, and description within the window are considered duplicates
 */
function getEventSignature(event: SecurityEvent): string {
	return `${event.type}:${event.toolName ?? ""}:${event.description.slice(0, 100)}`;
}

/**
 * Check if an event should be deduplicated
 * Returns true if event is a duplicate and should NOT be emitted
 */
function shouldDeduplicate(event: SecurityEvent): boolean {
	const now = Date.now();
	const signature = getEventSignature(event);

	// Prune old entries periodically
	if (dedupCache.size > DEDUP_CONFIG.maxCacheSize) {
		const cutoff = now - DEDUP_CONFIG.windowMs;
		for (const [sig, timestamp] of dedupCache) {
			if (timestamp < cutoff) {
				dedupCache.delete(sig);
			}
		}
	}

	const lastEmission = dedupCache.get(signature);
	if (lastEmission && now - lastEmission < DEDUP_CONFIG.windowMs) {
		// Duplicate within window - skip
		return true;
	}

	// Not a duplicate - update cache and emit
	dedupCache.set(signature, now);
	return false;
}

/**
 * Event listeners for external consumers
 * Using Set for efficient add/remove operations
 */
type SecurityEventListener = (event: SecurityEvent) => void;
const listeners = new Set<SecurityEventListener>();

/**
 * Rate limiting state per event type
 */
const rateLimitState = new Map<
	SecurityEventType,
	{ count: number; windowStart: number; suppressed: number }
>();

const RATE_LIMIT_CONFIG = {
	/** Maximum events per type within the window */
	maxEventsPerWindow: 100,
	/** Rate limit window in ms */
	windowMs: 60_000, // 1 minute
};

/**
 * Check if an event should be rate limited
 * Returns true if event exceeds rate limit and should NOT be emitted
 */
function shouldRateLimit(event: SecurityEvent): boolean {
	const now = Date.now();
	let state = rateLimitState.get(event.type);

	if (!state || now - state.windowStart > RATE_LIMIT_CONFIG.windowMs) {
		// New window
		state = { count: 0, windowStart: now, suppressed: 0 };
		rateLimitState.set(event.type, state);
	}

	state.count++;

	if (state.count > RATE_LIMIT_CONFIG.maxEventsPerWindow) {
		state.suppressed++;
		// Log periodically when suppressing
		if (state.suppressed === 1 || state.suppressed % 50 === 0) {
			const logger = getLogger();
			logger.warn("Rate limiting security events", {
				type: event.type,
				suppressed: state.suppressed,
				windowMs: RATE_LIMIT_CONFIG.windowMs,
			});
		}
		return true;
	}

	return false;
}

/**
 * Register a listener for security events
 * Returns an unsubscribe function
 */
export function onSecurityEvent(listener: SecurityEventListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Sanitize event metadata for safe logging
 * Removes or hashes potentially sensitive fields while keeping useful summary info
 */
function sanitizeMetadataForLogging(
	metadata?: Record<string, unknown>,
): Record<string, unknown> {
	if (!metadata) return {};

	const safeMetadata: Record<string, unknown> = {};

	// Fields that are safe to log directly
	const safeFields = [
		"loopType",
		"repetitions",
		"action",
		"patternId",
		"findingCount",
		"blocked",
		"source",
		"severity",
		"zScore",
		"threshold",
		"observationCount",
		"fragmentCount",
		"totalLength",
	];

	// Fields that should be counted, not logged directly
	const countFields = ["findingTypes", "matchingTools"];

	// Fields that should be hashed if present
	const hashFields = ["toolName", "path", "target"];

	for (const [key, value] of Object.entries(metadata)) {
		if (safeFields.includes(key)) {
			safeMetadata[key] = value;
		} else if (countFields.includes(key)) {
			// Log count instead of values
			if (Array.isArray(value)) {
				safeMetadata[`${key}Count`] = value.length;
			}
		} else if (hashFields.includes(key) && typeof value === "string") {
			// Log hash instead of actual value
			safeMetadata[`${key}Hash`] = hashForLogging(value);
		} else if (typeof value === "number" || typeof value === "boolean") {
			// Numbers and booleans are generally safe
			safeMetadata[key] = value;
		}
		// Skip other fields to prevent leaking sensitive data
	}

	return safeMetadata;
}

/**
 * Create a short hash of a value for logging purposes
 */
function hashForLogging(value: string): string {
	// Simple hash for logging - not cryptographic, just for identification
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		const char = value.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Emit a security event with deduplication and rate limiting
 */
function emitEvent(event: SecurityEvent): void {
	// Apply deduplication - skip if duplicate within time window
	if (shouldDeduplicate(event)) {
		return;
	}

	// Apply rate limiting - skip if exceeding rate limit
	if (shouldRateLimit(event)) {
		return;
	}

	// Log the event with sanitized metadata to prevent leaking sensitive info
	const logger = getLogger();
	const logFn =
		event.severity === "critical" || event.severity === "high"
			? logger.warn.bind(logger)
			: logger.info.bind(logger);

	// Sanitize metadata before logging - only include safe summary info
	const safeMetadata = sanitizeMetadataForLogging(event.metadata);

	logFn(`Security event: ${event.type}`, {
		severity: event.severity,
		// Only log severity distribution, not the actual description which might contain sensitive paths
		descriptionLength: event.description.length,
		...safeMetadata,
	});

	// Add to buffer
	eventBuffer.push(event);
	if (eventBuffer.length > MAX_BUFFER_SIZE) {
		eventBuffer.shift();
	}

	// Persist to disk (async, fire-and-forget with outer error boundary)
	if (emitConfig.persist) {
		try {
			persistSecurityEvent(event).catch((err) => {
				try {
					logger.error(
						"Failed to persist security event",
						err instanceof Error ? err : new Error(String(err)),
					);
				} catch {
					// Logger itself failed - nothing we can do
				}
			});
		} catch {
			// persistSecurityEvent threw synchronously - rare but possible
		}
	}

	// Notify listeners (use Array.from to snapshot Set for safe iteration)
	for (const listener of Array.from(listeners)) {
		try {
			listener(event);
		} catch (err) {
			try {
				logger.error(
					"Error in security event listener",
					err instanceof Error ? err : new Error(String(err)),
				);
			} catch {
				// Logger itself failed - nothing we can do
			}
		}
	}
}

/**
 * Track a loop detection event
 */
export function trackLoopDetection(params: {
	loopType: "exact" | "similar" | "cyclic" | "frequency";
	repetitions: number;
	toolName: string;
	action: "warn" | "pause" | "halt";
	reason?: string;
}): void {
	const severity: SecuritySeverity =
		params.action === "halt"
			? "high"
			: params.action === "pause"
				? "medium"
				: "low";

	const event: LoopDetectionEvent = {
		type: "loop_detected",
		severity,
		timestamp: Date.now(),
		toolName: params.toolName,
		description:
			params.reason ??
			`${params.loopType} loop detected for ${params.toolName} (${params.repetitions} repetitions)`,
		metadata: {
			loopType: params.loopType,
			repetitions: params.repetitions,
			toolName: params.toolName,
			action: params.action,
		},
	};

	emitEvent(event);
}

/**
 * Track a sequence pattern detection event
 */
export function trackSequencePattern(params: {
	patternId: string;
	toolName: string;
	action: "allow" | "require_approval" | "block";
	severity: SecuritySeverity;
	reason?: string;
	matchingTools?: string[];
}): void {
	const event: SequencePatternEvent = {
		type: "sequence_pattern_detected",
		severity: params.severity,
		timestamp: Date.now(),
		toolName: params.toolName,
		description:
			params.reason ??
			`Pattern ${params.patternId} detected for ${params.toolName}`,
		metadata: {
			patternId: params.patternId,
			toolName: params.toolName,
			action: params.action,
			matchingTools: params.matchingTools,
		},
	};

	emitEvent(event);
}

/**
 * Track a context firewall event
 */
export function trackContextFirewall(params: {
	findingTypes: string[];
	findingCount: number;
	blocked: boolean;
	toolName?: string;
	reason?: string;
}): void {
	const severity: SecuritySeverity = params.blocked ? "high" : "medium";

	const event: ContextFirewallEvent = {
		type: "context_firewall_triggered",
		severity,
		timestamp: Date.now(),
		toolName: params.toolName,
		description:
			params.reason ??
			`Context firewall detected ${params.findingCount} sensitive items`,
		metadata: {
			findingTypes: params.findingTypes,
			findingCount: params.findingCount,
			blocked: params.blocked,
			toolName: params.toolName,
		},
	};

	emitEvent(event);
}

/**
 * Track a tool being blocked by security checks
 */
export function trackToolBlocked(params: {
	toolName: string;
	reason: string;
	source: "loop" | "sequence" | "firewall" | "policy" | "adaptive";
	severity?: SecuritySeverity;
}): void {
	const event: SecurityEvent = {
		type: "tool_blocked",
		severity: params.severity ?? "high",
		timestamp: Date.now(),
		toolName: params.toolName,
		description: `Tool ${params.toolName} blocked: ${params.reason}`,
		metadata: {
			source: params.source,
			reason: params.reason,
		},
	};

	emitEvent(event);
}

/**
 * Track a tool requiring approval
 */
export function trackToolApprovalRequired(params: {
	toolName: string;
	reason: string;
	source: "sequence" | "policy";
}): void {
	const event: SecurityEvent = {
		type: "tool_approval_required",
		severity: "medium",
		timestamp: Date.now(),
		toolName: params.toolName,
		description: `Tool ${params.toolName} requires approval: ${params.reason}`,
		metadata: {
			source: params.source,
			reason: params.reason,
		},
	};

	emitEvent(event);
}

/**
 * Track sensitive content detection (without blocking)
 */
export function trackSensitiveContent(params: {
	contentTypes: string[];
	count: number;
	context: string;
}): void {
	const event: SecurityEvent = {
		type: "sensitive_content_detected",
		severity: "low",
		timestamp: Date.now(),
		description: `Detected ${params.count} sensitive content items in ${params.context}`,
		metadata: {
			contentTypes: params.contentTypes,
			count: params.count,
			context: params.context,
		},
	};

	emitEvent(event);
}

/**
 * Get recent security events from the buffer
 */
export function getRecentEvents(
	limit = 100,
	filter?: { type?: SecurityEventType; severity?: SecuritySeverity },
): SecurityEvent[] {
	let events = eventBuffer.slice(-limit);

	if (filter?.type) {
		events = events.filter((e) => e.type === filter.type);
	}
	if (filter?.severity) {
		events = events.filter((e) => e.severity === filter.severity);
	}

	return events;
}

/**
 * Get security event statistics
 */
export function getEventStats(): {
	total: number;
	byType: Record<SecurityEventType, number>;
	bySeverity: Record<SecuritySeverity, number>;
	recentHigh: number;
} {
	const now = Date.now();
	const oneHourAgo = now - 60 * 60 * 1000;

	const byType: Record<SecurityEventType, number> = {
		loop_detected: 0,
		sequence_pattern_detected: 0,
		context_firewall_triggered: 0,
		tool_blocked: 0,
		tool_approval_required: 0,
		sensitive_content_detected: 0,
		circuit_breaker_state_change: 0,
		adaptive_threshold_anomaly: 0,
	};

	const bySeverity: Record<SecuritySeverity, number> = {
		low: 0,
		medium: 0,
		high: 0,
		critical: 0,
	};

	let recentHigh = 0;

	for (const event of eventBuffer) {
		byType[event.type]++;
		bySeverity[event.severity]++;

		if (
			event.timestamp > oneHourAgo &&
			(event.severity === "high" || event.severity === "critical")
		) {
			recentHigh++;
		}
	}

	return {
		total: eventBuffer.length,
		byType,
		bySeverity,
		recentHigh,
	};
}

/**
 * Clear the event buffer and deduplication cache (for testing)
 */
export function clearEventBuffer(): void {
	eventBuffer.length = 0;
	dedupCache.clear();
	rateLimitState.clear();
}

/**
 * Track a circuit breaker state change
 */
export function trackCircuitBreakerStateChange(params: {
	fromState: "closed" | "open" | "half-open";
	toState: "closed" | "open" | "half-open";
	toolName?: string;
	failureCount?: number;
	reason?: string;
}): void {
	const severity: SecuritySeverity =
		params.toState === "open" ? "high" : "medium";

	const event: SecurityEvent = {
		type: "circuit_breaker_state_change",
		severity,
		timestamp: Date.now(),
		toolName: params.toolName,
		description:
			params.reason ??
			`Circuit breaker: ${params.fromState} -> ${params.toState}`,
		metadata: {
			fromState: params.fromState,
			toState: params.toState,
			failureCount: params.failureCount,
		},
	};

	emitEvent(event);
}

/**
 * Track adaptive threshold anomaly detection
 */
export function trackAdaptiveThresholdAnomaly(params: {
	metric: string;
	value: number;
	mean: number;
	stdDev: number;
	zScore: number;
	threshold: number;
}): void {
	const event: SecurityEvent = {
		type: "adaptive_threshold_anomaly",
		severity: params.zScore > 3 ? "high" : "medium",
		timestamp: Date.now(),
		description: `Anomaly detected for metric "${params.metric}": value ${params.value.toFixed(2)} is ${params.zScore.toFixed(2)} std devs from mean ${params.mean.toFixed(2)}`,
		metadata: {
			metric: params.metric,
			value: params.value,
			mean: params.mean,
			stdDev: params.stdDev,
			zScore: params.zScore,
			threshold: params.threshold,
		},
	};

	emitEvent(event);
}
