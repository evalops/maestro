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

import {
	trackContextFirewall,
	trackLoopDetection,
	trackSequencePattern,
	trackToolApprovalRequired,
	trackToolBlocked,
} from "../telemetry/security-events.js";
import { createLogger } from "../utils/logger.js";
import {
	type ContextFirewallOptions,
	type ContextFirewallResult,
	DEFAULT_BLOCKING_CONFIG,
	checkContextFirewall,
	sanitizePayload,
	vaultCredentialsInPayload,
} from "./context-firewall.js";
import { CredentialStore } from "./credential-store.js";
import {
	type LoopDetectionResult,
	LoopDetector,
	type LoopDetectorConfig,
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
	/** Context firewall options including blocking configuration */
	contextFirewall?: ContextFirewallOptions;
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
	private credentialStore: CredentialStore;
	private config: Required<
		Omit<
			SafetyMiddlewareConfig,
			"loopDetector" | "sequenceAnalyzer" | "contextFirewall"
		>
	> & {
		contextFirewall: ContextFirewallOptions;
	};

	constructor(config?: SafetyMiddlewareConfig) {
		this.credentialStore = new CredentialStore();
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
				...config?.contextFirewall,
				// Enable credential vaulting - stores credentials securely and replaces with refs
				vaultCredentials: config?.contextFirewall?.vaultCredentials ?? false,
				credentialStore: this.credentialStore,
				// Enable blocking by default with sensible thresholds
				blocking: {
					...DEFAULT_BLOCKING_CONFIG,
					...config?.contextFirewall?.blocking,
				},
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

			// Track findings even when not blocking
			if (firewallResult.findings.length > 0) {
				trackContextFirewall({
					findingTypes: [
						...new Set(firewallResult.findings.map((f) => f.type)),
					],
					findingCount: firewallResult.findings.length,
					blocked: firewallResult.blocked ?? false,
					toolName,
					reason: firewallResult.blockReason,
				});
			}

			if (firewallResult.blocked) {
				logger.warn("Context firewall blocked tool execution", {
					toolName,
					reason: firewallResult.blockReason,
					findingsCount: firewallResult.findings.length,
				});

				trackToolBlocked({
					toolName,
					reason: firewallResult.blockReason ?? "Sensitive content detected",
					source: "firewall",
					severity: "high",
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

				trackLoopDetection({
					loopType: loopResult.type ?? "exact",
					repetitions: loopResult.repetitions ?? 0,
					toolName,
					action: loopResult.action ?? "warn",
					reason: loopResult.reason,
				});

				if (loopResult.action === "pause" || loopResult.action === "halt") {
					trackToolBlocked({
						toolName,
						reason: loopResult.reason ?? "Loop detected",
						source: "loop",
						severity: loopResult.action === "halt" ? "high" : "medium",
					});

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

				trackSequencePattern({
					patternId: sequenceResult.patternId ?? "unknown",
					toolName,
					action: "require_approval",
					severity: "medium",
					reason: sequenceResult.reason,
				});

				trackToolApprovalRequired({
					toolName,
					reason: sequenceResult.reason ?? "Suspicious sequence detected",
					source: "sequence",
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
				trackSequencePattern({
					patternId: sequenceResult.patternId ?? "unknown",
					toolName,
					action: "block",
					severity: "high",
					reason: sequenceResult.reason,
				});

				trackToolBlocked({
					toolName,
					reason: sequenceResult.reason ?? "Blocked by sequence analysis",
					source: "sequence",
					severity: "high",
				});

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
		approved = true,
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
	 * Prepare arguments for execution when credential vaulting is enabled.
	 *
	 * Replaces detected credentials with vault references without mutating
	 * other argument content.
	 */
	prepareExecutionArgs<T>(args: T): T {
		if (
			!this.config.enableContextFirewall ||
			!this.config.contextFirewall.vaultCredentials
		) {
			return args;
		}

		return vaultCredentialsInPayload(args, this.credentialStore) as T;
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
		this.clearCredentials();
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

	/**
	 * Resolve credential references in tool arguments before execution
	 *
	 * When vaultCredentials is enabled, credentials detected during sanitization
	 * are stored securely and replaced with references like `{{CRED:api_key:abc123}}`.
	 * This method resolves those references back to their original values so tools
	 * can actually use the credentials.
	 *
	 * @param args - Tool arguments that may contain credential references
	 * @returns New object with credential references resolved to actual values
	 */
	resolveCredentials<T>(args: T): T {
		return this.credentialStore.resolveInObject(args);
	}

	/**
	 * Get credential store statistics (for diagnostics)
	 */
	getCredentialStats(): ReturnType<CredentialStore["getStats"]> {
		return this.credentialStore.getStats();
	}

	/**
	 * Clear stored credentials (for session reset)
	 */
	clearCredentials(): void {
		this.credentialStore.clear();
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
