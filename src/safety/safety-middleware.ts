/**
 * Safety Middleware - Unified Security Layer for Tool Execution
 *
 * This module consolidates all security checks into a single middleware layer
 * that integrates with the agent transport. It provides:
 *
 * 1. **Loop Detection**: Enhanced pattern detection (exact, similar, cyclic, frequency)
 * 2. **Sequence Analysis**: Behavioral threat detection (exfiltration, reconnaissance, etc.)
 * 3. **Context Firewall**: Argument sanitization before logging/storage
 *
 * ## Integration Points
 *
 * ```
 * Tool Call → preExecution() → [Firewall] → [Execute] → postExecution()
 *                  ↓                                         ↓
 *            Loop check                               Record outcome
 *            Sequence check                           Update state
 *            Sanitize args
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * const middleware = new SafetyMiddleware();
 *
 * // Before execution
 * const check = middleware.preExecution(toolName, args);
 * if (check.blocked) {
 *   // Handle block/approval requirement
 * }
 *
 * // After execution
 * middleware.postExecution(toolName, args, success);
 *
 * // For audit logging
 * const sanitized = middleware.sanitizeForLogging(args);
 * ```
 *
 * @module safety/safety-middleware
 */

import { createLogger } from "../utils/logger.js";
import {
	type ContextFirewallResult,
	type SanitizeOptions,
	checkContextFirewall,
	sanitizePayload,
} from "./context-firewall.js";
import {
	type LoopDetectionResult,
	type LoopDetectorConfig,
	LoopDetector,
} from "./loop-detector.js";
import {
	type SequenceAnalysisResult,
	ToolSequenceAnalyzer,
} from "./tool-sequence-analyzer.js";

/**
 * Configuration for ToolSequenceAnalyzer
 */
interface ToolSequenceAnalyzerConfig {
	maxRecords?: number;
	maxAgeMs?: number;
}

const logger = createLogger("safety:middleware");

/**
 * Result of pre-execution safety check
 */
export interface PreExecutionResult {
	/** Whether tool execution should proceed */
	allowed: boolean;
	/** Whether user approval is required */
	requiresApproval: boolean;
	/** Reason for block or approval requirement */
	reason?: string;
	/** Suggestion for resolving the issue */
	suggestion?: string;
	/** Which check triggered (loop, sequence, firewall) */
	triggeredBy?: "loop" | "sequence" | "firewall";
	/** Sanitized arguments safe for logging */
	sanitizedArgs: Record<string, unknown>;
	/** Detection details */
	details?: {
		loopResult?: LoopDetectionResult;
		sequenceResult?: SequenceAnalysisResult;
		firewallResult?: ContextFirewallResult;
	};
}

/**
 * Configuration for SafetyMiddleware
 */
export interface SafetyMiddlewareConfig {
	/** Loop detector configuration */
	loopDetector?: LoopDetectorConfig;
	/** Sequence analyzer configuration */
	sequenceAnalyzer?: ToolSequenceAnalyzerConfig;
	/** Context firewall options */
	contextFirewall?: SanitizeOptions & { blockHighSeverity?: boolean };
	/** Whether to enable loop detection (default: true) */
	enableLoopDetection?: boolean;
	/** Whether to enable sequence analysis (default: true) */
	enableSequenceAnalysis?: boolean;
	/** Whether to enable context firewall (default: true) */
	enableContextFirewall?: boolean;
}

/**
 * Safety Middleware class
 *
 * Provides a unified interface for all security checks in the tool execution pipeline.
 */
export class SafetyMiddleware {
	private loopDetector: LoopDetector;
	private sequenceAnalyzer: ToolSequenceAnalyzer;
	private config: Required<
		Omit<
			SafetyMiddlewareConfig,
			"loopDetector" | "sequenceAnalyzer" | "contextFirewall"
		>
	> & {
		contextFirewall: SanitizeOptions & { blockHighSeverity?: boolean };
	};

	constructor(config?: SafetyMiddlewareConfig) {
		this.loopDetector = new LoopDetector({
			// Default: more lenient than standalone for integration
			maxIdenticalCalls: config?.loopDetector?.maxIdenticalCalls ?? 5,
			maxSimilarCalls: config?.loopDetector?.maxSimilarCalls ?? 10,
			maxCallsPerMinute: config?.loopDetector?.maxCallsPerMinute ?? 120,
			autoPause: config?.loopDetector?.autoPause ?? false, // Don't auto-pause, let transport handle
			...config?.loopDetector,
		});

		this.sequenceAnalyzer = new ToolSequenceAnalyzer({
			maxRecords: config?.sequenceAnalyzer?.maxRecords ?? 100,
			maxAgeMs: config?.sequenceAnalyzer?.maxAgeMs ?? 300000, // 5 minutes
			...config?.sequenceAnalyzer,
		});

		this.config = {
			enableLoopDetection: config?.enableLoopDetection ?? true,
			enableSequenceAnalysis: config?.enableSequenceAnalysis ?? true,
			enableContextFirewall: config?.enableContextFirewall ?? true,
			contextFirewall: {
				redactSecrets: true,
				maxStringLength: 1000,
				removeControlChars: true,
				truncateLargeBlobs: true,
				blockHighSeverity: false, // Don't block by default, just sanitize
				...config?.contextFirewall,
			},
		};
	}

	/**
	 * Run all pre-execution safety checks
	 *
	 * Call this before executing a tool. Returns whether execution should proceed
	 * and provides sanitized arguments for logging.
	 */
	preExecution(
		toolName: string,
		args: Record<string, unknown>,
	): PreExecutionResult {
		const details: PreExecutionResult["details"] = {};

		// 1. Context Firewall - sanitize and check for high-severity content
		let sanitizedArgs = args;
		if (this.config.enableContextFirewall) {
			const firewallResult = checkContextFirewall(
				args,
				this.config.contextFirewall,
			);
			details.firewallResult = firewallResult;
			sanitizedArgs = firewallResult.sanitizedPayload as Record<
				string,
				unknown
			>;

			if (firewallResult.blocked) {
				logger.warn("Context firewall blocked tool execution", {
					toolName,
					reason: firewallResult.blockReason,
					findingsCount: firewallResult.findings.length,
				});
				return {
					allowed: false,
					requiresApproval: false,
					reason: firewallResult.blockReason,
					suggestion: "Remove sensitive content from tool arguments",
					triggeredBy: "firewall",
					sanitizedArgs,
					details,
				};
			}
		}

		// 2. Loop Detection - check for repetitive patterns
		if (this.config.enableLoopDetection) {
			const loopResult = this.loopDetector.check(toolName, args);
			details.loopResult = loopResult;

			if (loopResult.detected) {
				logger.info("Loop pattern detected", {
					toolName,
					type: loopResult.type,
					repetitions: loopResult.repetitions,
				});

				if (loopResult.action === "pause" || loopResult.action === "halt") {
					return {
						allowed: false,
						requiresApproval: loopResult.action === "pause",
						reason: loopResult.reason,
						suggestion: loopResult.suggestion,
						triggeredBy: "loop",
						sanitizedArgs,
						details,
					};
				}
				// For "warn" action, log but continue
			}
		}

		// 3. Sequence Analysis - check for suspicious behavioral patterns
		if (this.config.enableSequenceAnalysis) {
			const sequenceResult = this.sequenceAnalyzer.checkTool(toolName, args);
			details.sequenceResult = sequenceResult;

			if (sequenceResult.action === "require_approval") {
				logger.warn("Suspicious tool sequence detected", {
					toolName,
					patternId: sequenceResult.patternId,
					reason: sequenceResult.reason,
				});

				return {
					allowed: false,
					requiresApproval: true,
					reason: sequenceResult.reason,
					triggeredBy: "sequence",
					sanitizedArgs,
					details,
				};
			}

			if (sequenceResult.action === "block") {
				return {
					allowed: false,
					requiresApproval: false,
					reason: sequenceResult.reason,
					triggeredBy: "sequence",
					sanitizedArgs,
					details,
				};
			}
		}

		return {
			allowed: true,
			requiresApproval: false,
			sanitizedArgs,
			details,
		};
	}

	/**
	 * Record tool execution outcome
	 *
	 * Call this after tool execution completes (success or failure).
	 * Updates internal state for pattern detection.
	 */
	postExecution(
		toolName: string,
		args: Record<string, unknown>,
		success: boolean,
		approved: boolean = true,
	): void {
		// Record in loop detector
		if (this.config.enableLoopDetection) {
			this.loopDetector.record(toolName, args);
		}

		// Record in sequence analyzer
		if (this.config.enableSequenceAnalysis) {
			this.sequenceAnalyzer.recordTool(toolName, args, approved, success);
		}
	}

	/**
	 * Sanitize arguments for logging/storage
	 *
	 * Use this to get a safe version of tool arguments for audit logs.
	 */
	sanitizeForLogging(args: Record<string, unknown>): Record<string, unknown> {
		if (!this.config.enableContextFirewall) {
			return args;
		}
		return sanitizePayload(args, this.config.contextFirewall) as Record<
			string,
			unknown
		>;
	}

	/**
	 * Resume from paused state (loop detection)
	 */
	resumeLoopDetection(): void {
		this.loopDetector.resume();
	}

	/**
	 * Check if loop detector is paused
	 */
	isLoopDetectorPaused(): boolean {
		return this.loopDetector.isPausedState();
	}

	/**
	 * Get loop detector pause reason
	 */
	getLoopPauseReason(): string | undefined {
		return this.loopDetector.getPauseReason();
	}

	/**
	 * Reset all internal state
	 */
	reset(): void {
		this.loopDetector.reset();
		this.sequenceAnalyzer.clear();
	}

	/**
	 * Get statistics about safety checks
	 */
	getStats(): {
		loopDetector: ReturnType<LoopDetector["getStats"]>;
		sequenceAnalyzer: ReturnType<ToolSequenceAnalyzer["getSummary"]>;
	} {
		return {
			loopDetector: this.loopDetector.getStats(),
			sequenceAnalyzer: this.sequenceAnalyzer.getSummary(),
		};
	}
}

/**
 * Default safety middleware instance
 */
export const defaultSafetyMiddleware = new SafetyMiddleware();

/**
 * Create a safety middleware with custom configuration
 */
export function createSafetyMiddleware(
	config?: SafetyMiddlewareConfig,
): SafetyMiddleware {
	return new SafetyMiddleware(config);
}
