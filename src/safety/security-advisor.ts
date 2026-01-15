/**
 * Security Advisor - Aggregates security events into actionable advisories
 *
 * Monitors security event patterns and generates human-readable warnings
 * about potential threats, suspicious activity, and recommended actions.
 *
 * @module safety/security-advisor
 */

import { createLogger } from "../utils/logger.js";
import {
	type SecurityEvent,
	type SecurityEventType,
	getRecentEvents,
	getEventStats,
	onSecurityEvent,
} from "../telemetry/security-events.js";

const logger = createLogger("safety:security-advisor");

/**
 * Security advisory levels
 */
export type AdvisoryLevel = "info" | "warning" | "alert" | "critical";

/**
 * A security advisory generated from event patterns
 */
export interface SecurityAdvisory {
	/** Advisory level */
	level: AdvisoryLevel;
	/** Short title */
	title: string;
	/** Detailed description */
	description: string;
	/** Recommended action */
	recommendation: string;
	/** Related event types */
	relatedEvents: SecurityEventType[];
	/** When this advisory was generated */
	timestamp: number;
	/** Number of events that triggered this */
	eventCount: number;
	/** Time window of analysis (ms) */
	windowMs: number;
}

/**
 * Configuration for the security advisor
 */
export interface SecurityAdvisorConfig {
	/** Time window for pattern analysis (ms). Default: 5 minutes */
	analysisWindowMs: number;
	/** Threshold for reconnaissance warning (reads). Default: 10 */
	reconReadThreshold: number;
	/** Threshold for repeated blocks warning. Default: 3 */
	repeatedBlockThreshold: number;
	/** Threshold for loop warning. Default: 3 */
	loopThreshold: number;
	/** Threshold for firewall triggers. Default: 5 */
	firewallThreshold: number;
	/** Enable real-time monitoring */
	enableRealtime: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_ADVISOR_CONFIG: SecurityAdvisorConfig = {
	analysisWindowMs: 5 * 60 * 1000, // 5 minutes
	reconReadThreshold: 10,
	repeatedBlockThreshold: 3,
	loopThreshold: 3,
	firewallThreshold: 5,
	enableRealtime: true,
};

/**
 * Callback for advisory notifications
 */
export type AdvisoryCallback = (advisory: SecurityAdvisory) => void;

/**
 * Security Advisor
 *
 * Analyzes security events to detect threat patterns and generate advisories.
 */
export class SecurityAdvisor {
	private config: SecurityAdvisorConfig;
	private callbacks = new Set<AdvisoryCallback>();
	private recentAdvisories: SecurityAdvisory[] = [];
	private unsubscribe: (() => void) | null = null;
	private lastAnalysis = 0;
	private analysisDebounceMs = 1000;

	constructor(config: Partial<SecurityAdvisorConfig> = {}) {
		this.config = { ...DEFAULT_ADVISOR_CONFIG, ...config };

		if (this.config.enableRealtime) {
			this.startRealtime();
		}
	}

	/**
	 * Start real-time event monitoring
	 */
	startRealtime(): void {
		if (this.unsubscribe) return;

		this.unsubscribe = onSecurityEvent((_event) => {
			// Debounce analysis
			const now = Date.now();
			if (now - this.lastAnalysis > this.analysisDebounceMs) {
				this.lastAnalysis = now;
				this.analyzeAndNotify();
			}
		});

		logger.debug("Real-time security monitoring started");
	}

	/**
	 * Stop real-time monitoring
	 */
	stopRealtime(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
			logger.debug("Real-time security monitoring stopped");
		}
	}

	/**
	 * Register a callback for new advisories
	 */
	onAdvisory(callback: AdvisoryCallback): () => void {
		this.callbacks.add(callback);
		return () => this.callbacks.delete(callback);
	}

	/**
	 * Analyze recent events and generate advisories
	 */
	analyze(): SecurityAdvisory[] {
		const advisories: SecurityAdvisory[] = [];
		const cutoff = Date.now() - this.config.analysisWindowMs;
		const events = getRecentEvents(500).filter((e) => e.timestamp > cutoff);

		if (events.length === 0) {
			return advisories;
		}

		// Check for reconnaissance patterns
		const reconAdvisory = this.checkReconnaissance(events);
		if (reconAdvisory) advisories.push(reconAdvisory);

		// Check for repeated blocks
		const blocksAdvisory = this.checkRepeatedBlocks(events);
		if (blocksAdvisory) advisories.push(blocksAdvisory);

		// Check for loop patterns
		const loopAdvisory = this.checkLoopPatterns(events);
		if (loopAdvisory) advisories.push(loopAdvisory);

		// Check for firewall triggers
		const firewallAdvisory = this.checkFirewallTriggers(events);
		if (firewallAdvisory) advisories.push(firewallAdvisory);

		// Check for circuit breaker state
		const circuitAdvisory = this.checkCircuitBreaker(events);
		if (circuitAdvisory) advisories.push(circuitAdvisory);

		// Check for anomalies
		const anomalyAdvisory = this.checkAnomalies(events);
		if (anomalyAdvisory) advisories.push(anomalyAdvisory);

		return advisories;
	}

	/**
	 * Get the current threat level based on recent events
	 */
	getThreatLevel(): {
		level: AdvisoryLevel;
		score: number;
		summary: string;
	} {
		const stats = getEventStats();
		let score = 0;

		// Weight by severity
		score += stats.bySeverity.critical * 10;
		score += stats.bySeverity.high * 5;
		score += stats.bySeverity.medium * 2;
		score += stats.bySeverity.low * 0.5;

		// Bonus for recent high-severity events
		score += stats.recentHigh * 3;

		let level: AdvisoryLevel = "info";
		let summary = "No security concerns detected";

		if (score >= 50) {
			level = "critical";
			summary = "Critical security threats detected - review immediately";
		} else if (score >= 25) {
			level = "alert";
			summary = "Multiple security concerns - investigation recommended";
		} else if (score >= 10) {
			level = "warning";
			summary = "Some security events detected - monitor closely";
		} else if (score > 0) {
			summary = "Minor security events recorded";
		}

		return { level, score, summary };
	}

	/**
	 * Get recent advisories
	 */
	getRecentAdvisories(limit = 10): SecurityAdvisory[] {
		return this.recentAdvisories.slice(-limit);
	}

	/**
	 * Clear recent advisories
	 */
	clearAdvisories(): void {
		this.recentAdvisories = [];
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		this.stopRealtime();
		this.callbacks.clear();
		this.recentAdvisories = [];
	}

	// === Private Analysis Methods ===

	private analyzeAndNotify(): void {
		const advisories = this.analyze();

		for (const advisory of advisories) {
			// Check if we've already generated a similar advisory recently
			const isDuplicate = this.recentAdvisories.some(
				(a) =>
					a.title === advisory.title &&
					advisory.timestamp - a.timestamp < this.config.analysisWindowMs / 2,
			);

			if (!isDuplicate) {
				this.recentAdvisories.push(advisory);
				this.notifyCallbacks(advisory);
			}
		}

		// Prune old advisories
		const cutoff = Date.now() - this.config.analysisWindowMs * 2;
		this.recentAdvisories = this.recentAdvisories.filter(
			(a) => a.timestamp > cutoff,
		);
	}

	private notifyCallbacks(advisory: SecurityAdvisory): void {
		for (const callback of this.callbacks) {
			try {
				callback(advisory);
			} catch (err) {
				logger.error(
					"Error in advisory callback",
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		}
	}

	private checkReconnaissance(events: SecurityEvent[]): SecurityAdvisory | null {
		// Count Read and Glob events (possible reconnaissance)
		const readEvents = events.filter(
			(e) =>
				e.toolName === "Read" ||
				e.toolName === "Glob" ||
				(e.type === "tool_blocked" && e.toolName?.includes("Read")),
		);

		if (readEvents.length >= this.config.reconReadThreshold) {
			return {
				level: "warning",
				title: "Possible Reconnaissance Activity",
				description: `${readEvents.length} file read/search operations detected in the last ${Math.round(this.config.analysisWindowMs / 60000)} minutes. This could indicate automated scanning or data gathering.`,
				recommendation:
					"Review the accessed files and ensure they're related to the current task. Consider enabling stricter access controls.",
				relatedEvents: ["tool_blocked", "sensitive_content_detected"],
				timestamp: Date.now(),
				eventCount: readEvents.length,
				windowMs: this.config.analysisWindowMs,
			};
		}

		return null;
	}

	private checkRepeatedBlocks(events: SecurityEvent[]): SecurityAdvisory | null {
		const blockedEvents = events.filter((e) => e.type === "tool_blocked");

		if (blockedEvents.length >= this.config.repeatedBlockThreshold) {
			// Group by tool name
			const toolCounts = new Map<string, number>();
			for (const e of blockedEvents) {
				const tool = e.toolName ?? "unknown";
				toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
			}

			const topTool = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])[0];

			return {
				level: "alert",
				title: "Repeated Security Blocks",
				description: `${blockedEvents.length} tool executions were blocked. Most blocked tool: ${topTool?.[0]} (${topTool?.[1]} times). This may indicate attempted policy circumvention.`,
				recommendation:
					"Review the blocked operations and user intent. Consider adjusting safety policies if blocks are false positives.",
				relatedEvents: ["tool_blocked"],
				timestamp: Date.now(),
				eventCount: blockedEvents.length,
				windowMs: this.config.analysisWindowMs,
			};
		}

		return null;
	}

	private checkLoopPatterns(events: SecurityEvent[]): SecurityAdvisory | null {
		const loopEvents = events.filter((e) => e.type === "loop_detected");

		if (loopEvents.length >= this.config.loopThreshold) {
			return {
				level: "warning",
				title: "Loop Behavior Detected",
				description: `${loopEvents.length} loop detection events recorded. This could indicate stuck processing or infinite recursion attempts.`,
				recommendation:
					"Check if the agent is making progress. Consider restarting the conversation or clarifying the task.",
				relatedEvents: ["loop_detected"],
				timestamp: Date.now(),
				eventCount: loopEvents.length,
				windowMs: this.config.analysisWindowMs,
			};
		}

		return null;
	}

	private checkFirewallTriggers(
		events: SecurityEvent[],
	): SecurityAdvisory | null {
		const firewallEvents = events.filter(
			(e) =>
				e.type === "context_firewall_triggered" ||
				e.type === "sensitive_content_detected",
		);

		if (firewallEvents.length >= this.config.firewallThreshold) {
			// Extract finding types
			const findingTypes = new Set<string>();
			for (const e of firewallEvents) {
				const types = (e.metadata?.findingTypes as string[]) ?? [];
				types.forEach((t) => findingTypes.add(t));
			}

			return {
				level: "alert",
				title: "Multiple Sensitive Content Detections",
				description: `Context firewall triggered ${firewallEvents.length} times. Detected types: ${[...findingTypes].join(", ")}. Sensitive data may be at risk.`,
				recommendation:
					"Review tool arguments for exposed credentials or sensitive data. Consider rotating any detected API keys or secrets.",
				relatedEvents: [
					"context_firewall_triggered",
					"sensitive_content_detected",
				],
				timestamp: Date.now(),
				eventCount: firewallEvents.length,
				windowMs: this.config.analysisWindowMs,
			};
		}

		return null;
	}

	private checkCircuitBreaker(events: SecurityEvent[]): SecurityAdvisory | null {
		const circuitEvents = events.filter(
			(e) =>
				e.type === "circuit_breaker_state_change" &&
				e.metadata?.toState === "open",
		);

		if (circuitEvents.length > 0) {
			const toolNames = [
				...new Set(circuitEvents.map((e) => e.toolName).filter(Boolean)),
			];

			return {
				level: "alert",
				title: "Circuit Breaker Opened",
				description: `Circuit breaker opened for ${toolNames.length > 0 ? toolNames.join(", ") : "tools"} due to repeated failures. Affected operations are temporarily blocked.`,
				recommendation:
					"Wait for the circuit breaker to reset, or investigate the underlying failure cause. Check logs for error details.",
				relatedEvents: ["circuit_breaker_state_change"],
				timestamp: Date.now(),
				eventCount: circuitEvents.length,
				windowMs: this.config.analysisWindowMs,
			};
		}

		return null;
	}

	private checkAnomalies(events: SecurityEvent[]): SecurityAdvisory | null {
		const anomalyEvents = events.filter(
			(e) => e.type === "adaptive_threshold_anomaly",
		);

		if (anomalyEvents.length > 0) {
			const metrics = [
				...new Set(anomalyEvents.map((e) => e.metadata?.metric as string)),
			].filter(Boolean);

			return {
				level: "warning",
				title: "Behavioral Anomaly Detected",
				description: `Unusual behavior detected in metrics: ${metrics.join(", ")}. Activity is significantly different from baseline.`,
				recommendation:
					"This may indicate automated activity or unusual user behavior. Review recent actions and verify intent.",
				relatedEvents: ["adaptive_threshold_anomaly"],
				timestamp: Date.now(),
				eventCount: anomalyEvents.length,
				windowMs: this.config.analysisWindowMs,
			};
		}

		return null;
	}
}

/**
 * Format an advisory for display
 */
export function formatAdvisory(advisory: SecurityAdvisory): string {
	const levelIcon =
		{
			info: "ℹ️",
			warning: "⚠️",
			alert: "🚨",
			critical: "🔴",
		}[advisory.level] ?? "•";

	const lines = [
		`${levelIcon} ${advisory.title}`,
		`  ${advisory.description}`,
		`  Recommendation: ${advisory.recommendation}`,
		`  Events: ${advisory.eventCount} in last ${Math.round(advisory.windowMs / 60000)}m`,
	];

	return lines.join("\n");
}

/**
 * Default global instance
 */
export const defaultSecurityAdvisor = new SecurityAdvisor();
