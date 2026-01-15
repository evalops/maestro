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

// Lazy logger to avoid module initialization issues in tests
let _logger: ReturnType<typeof createLogger> | undefined;
function getLogger() {
	if (!_logger) {
		_logger = createLogger("telemetry:security");
	}
	return _logger;
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
	| "sensitive_content_detected";

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
 * Event listeners for external consumers
 */
type SecurityEventListener = (event: SecurityEvent) => void;
const listeners: SecurityEventListener[] = [];

/**
 * Register a listener for security events
 */
export function onSecurityEvent(listener: SecurityEventListener): () => void {
	listeners.push(listener);
	return () => {
		const index = listeners.indexOf(listener);
		if (index > -1) {
			listeners.splice(index, 1);
		}
	};
}

/**
 * Emit a security event
 */
function emitEvent(event: SecurityEvent): void {
	// Log the event
	const logger = getLogger();
	const logFn =
		event.severity === "critical" || event.severity === "high"
			? logger.warn.bind(logger)
			: logger.info.bind(logger);

	logFn(`Security event: ${event.type}`, {
		severity: event.severity,
		description: event.description,
		...event.metadata,
	});

	// Add to buffer
	eventBuffer.push(event);
	if (eventBuffer.length > MAX_BUFFER_SIZE) {
		eventBuffer.shift();
	}

	// Notify listeners
	for (const listener of listeners) {
		try {
			listener(event);
		} catch (err) {
			logger.error(
				"Error in security event listener",
				err instanceof Error ? err : new Error(String(err)),
			);
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
	source: "loop" | "sequence" | "firewall" | "policy";
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
 * Clear the event buffer (for testing)
 */
export function clearEventBuffer(): void {
	eventBuffer.length = 0;
}
