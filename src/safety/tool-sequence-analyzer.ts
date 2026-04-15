/**
 * Tool Sequence Analyzer - Behavioral threat detection for tool calls
 *
 * This module analyzes sequences of tool calls to detect suspicious patterns
 * that may indicate:
 *
 * 1. **Data Exfiltration**: Read sensitive data → network egress
 * 2. **Privilege Escalation**: Normal ops → system modifications
 * 3. **Reconnaissance**: Systematic exploration of sensitive paths
 * 4. **Injection Attacks**: Unusual tool combinations from injected prompts
 * 5. **Confusion Loops**: Repeated similar operations suggesting confusion
 *
 * ## How It Works
 *
 * The analyzer maintains a sliding window of recent tool calls and applies
 * pattern matching rules to detect suspicious sequences. When a suspicious
 * pattern is detected, it can:
 *
 * - Log a warning for security monitoring
 * - Require user approval before continuing
 * - Block the operation entirely (for critical patterns)
 *
 * ## Integration
 *
 * The analyzer should be called before each tool execution:
 *
 * ```typescript
 * const result = analyzer.checkTool(toolName, toolArgs);
 * if (result.action === 'block') {
 *   throw new Error(result.reason);
 * }
 * if (result.action === 'require_approval') {
 *   await requestUserApproval(result.reason);
 * }
 * analyzer.recordTool(toolName, toolArgs, result);
 * ```
 *
 * @module safety/tool-sequence-analyzer
 */

import { createLogger } from "../utils/logger.js";
import type {
	SequenceAnalysisResult,
	SessionStats,
	ToolCallRecord,
} from "./sequence-analyzer-types.js";
import { SUSPICIOUS_PATTERNS } from "./suspicious-patterns.js";
import { getToolTags } from "./tool-categorization.js";

export type {
	SequenceAnalysisResult,
	SequencePattern,
	ToolCallRecord,
} from "./sequence-analyzer-types.js";

const logger = createLogger("safety:tool-sequence-analyzer");

/**
 * Tool Sequence Analyzer class
 */
export class ToolSequenceAnalyzer {
	/** Sliding window of recent tool calls */
	private records: ToolCallRecord[] = [];

	/** Maximum records to keep */
	private maxRecords: number;

	/** Maximum age of records (ms) */
	private maxAgeMs: number;

	/**
	 * Session-level statistics for temporal evasion detection
	 * These persist for the entire session to detect slow-burn attacks
	 */
	private sessionStats: SessionStats = {
		totalToolCalls: 0,
		toolCounts: new Map(),
		sensitiveAccesses: 0,
		egressOperations: 0,
		sessionStart: Date.now(),
		uniquePaths: new Set(),
	};

	/**
	 * Session-level thresholds for temporal evasion detection
	 */
	private readonly sessionThresholds = {
		/** Max total tool calls per session */
		maxToolCalls: 500,
		/** Max sensitive file accesses per session */
		maxSensitiveAccesses: 50,
		/** Max network egress operations per session */
		maxEgressOperations: 20,
		/** Max unique paths to access */
		maxUniquePaths: 200,
		/** Alert after this many calls of same tool type */
		toolTypeThreshold: 100,
	};

	constructor(options?: { maxRecords?: number; maxAgeMs?: number }) {
		this.maxRecords = options?.maxRecords ?? 100;
		this.maxAgeMs = options?.maxAgeMs ?? 600000; // 10 minutes default
	}

	/**
	 * Get session statistics for monitoring
	 */
	getSessionStats(): Readonly<{
		totalToolCalls: number;
		sensitiveAccesses: number;
		egressOperations: number;
		uniquePathCount: number;
		sessionDurationMs: number;
	}> {
		return {
			totalToolCalls: this.sessionStats.totalToolCalls,
			sensitiveAccesses: this.sessionStats.sensitiveAccesses,
			egressOperations: this.sessionStats.egressOperations,
			uniquePathCount: this.sessionStats.uniquePaths.size,
			sessionDurationMs: Date.now() - this.sessionStats.sessionStart,
		};
	}

	/**
	 * Check session-level patterns for temporal evasion
	 * This catches attackers who space out operations over time
	 */
	private checkSessionPatterns(
		toolName: string,
		toolArgs: Record<string, unknown>,
	): SequenceAnalysisResult | null {
		const tags = getToolTags(toolName);

		// Track session stats
		this.sessionStats.totalToolCalls++;
		const toolCount = (this.sessionStats.toolCounts.get(toolName) ?? 0) + 1;
		this.sessionStats.toolCounts.set(toolName, toolCount);

		// Track sensitive accesses
		if (tags.has("sensitive") || tags.has("privesc")) {
			this.sessionStats.sensitiveAccesses++;
		}

		// Track egress operations
		if (tags.has("network") || tags.has("egress")) {
			this.sessionStats.egressOperations++;
		}

		// Track unique paths
		const path = this.extractPath(toolArgs);
		if (path) {
			this.sessionStats.uniquePaths.add(path);
		}

		// Check session-level thresholds
		if (
			this.sessionStats.totalToolCalls >= this.sessionThresholds.maxToolCalls
		) {
			return {
				action: "require_approval",
				patternId: "session-tool-limit",
				reason: `Session tool call limit reached (${this.sessionStats.totalToolCalls} calls). This may indicate automated abuse.`,
				severity: "high",
			};
		}

		if (
			this.sessionStats.sensitiveAccesses >=
			this.sessionThresholds.maxSensitiveAccesses
		) {
			return {
				action: "require_approval",
				patternId: "session-sensitive-limit",
				reason: `Session sensitive access limit reached (${this.sessionStats.sensitiveAccesses} accesses). Possible reconnaissance or data harvesting.`,
				severity: "high",
			};
		}

		if (
			this.sessionStats.egressOperations >=
			this.sessionThresholds.maxEgressOperations
		) {
			return {
				action: "block",
				patternId: "session-egress-limit",
				reason: `Session egress limit reached (${this.sessionStats.egressOperations} operations). Possible data exfiltration.`,
				severity: "critical",
			};
		}

		if (
			this.sessionStats.uniquePaths.size >=
			this.sessionThresholds.maxUniquePaths
		) {
			return {
				action: "require_approval",
				patternId: "session-path-limit",
				reason: `Session unique path limit reached (${this.sessionStats.uniquePaths.size} paths). Possible filesystem enumeration.`,
				severity: "high",
			};
		}

		// Check for excessive use of single tool type
		if (toolCount >= this.sessionThresholds.toolTypeThreshold) {
			return {
				action: "require_approval",
				patternId: "session-tool-type-limit",
				reason: `Excessive use of ${toolName} (${toolCount} calls). May indicate automated abuse.`,
				severity: "medium",
			};
		}

		return null;
	}

	/**
	 * Extract file path from tool arguments
	 */
	private extractPath(args: Record<string, unknown>): string | null {
		// Common path argument names
		const pathKeys = [
			"path",
			"file",
			"file_path",
			"filePath",
			"target",
			"source",
		];
		for (const key of pathKeys) {
			const value = args[key];
			if (typeof value === "string") {
				return value;
			}
		}
		return null;
	}

	/**
	 * Check a tool call against suspicious patterns
	 */
	checkTool(
		toolName: string,
		toolArgs: Record<string, unknown>,
	): SequenceAnalysisResult {
		// Clean old records first
		this.pruneOldRecords();

		// Check session-level patterns first (for temporal evasion detection)
		const sessionResult = this.checkSessionPatterns(toolName, toolArgs);
		if (sessionResult) {
			logger.warn("Session-level pattern detected", {
				patternId: sessionResult.patternId,
				severity: sessionResult.severity,
				tool: toolName,
				reason: sessionResult.reason,
			});
			return sessionResult;
		}

		// Check each pattern with fail-closed error handling
		for (const pattern of SUSPICIOUS_PATTERNS) {
			try {
				const result = pattern.detect(this.records, toolName, toolArgs);

				if (result.matched) {
					logger.warn("Suspicious tool sequence detected", {
						patternId: pattern.id,
						severity: pattern.severity,
						tool: toolName,
						reason: result.reason,
					});

					const action =
						pattern.action === "log"
							? "allow"
							: pattern.action === "require_approval"
								? "require_approval"
								: "block";

					return {
						action,
						patternId: pattern.id,
						reason: result.reason ?? pattern.description,
						severity: pattern.severity,
						matchingRecords: result.matchingRecords,
					};
				}
			} catch (err) {
				// Fail-closed: if a pattern detection throws, require approval
				// This prevents attackers from crafting inputs that crash patterns
				logger.error(
					`Pattern detection error - failing closed [pattern=${pattern.id}, tool=${toolName}]`,
					err instanceof Error ? err : new Error(String(err)),
				);
				return {
					action: "require_approval",
					patternId: pattern.id,
					reason: `Security pattern check failed: ${pattern.description}. Manual review required.`,
					severity: "high",
				};
			}
		}

		return { action: "allow" };
	}

	/**
	 * Record a tool call (call after execution)
	 */
	recordTool(
		toolName: string,
		toolArgs: Record<string, unknown>,
		approved: boolean,
		success?: boolean,
	): void {
		const record: ToolCallRecord = {
			tool: toolName,
			args: this.sanitizeArgs(toolArgs),
			timestamp: Date.now(),
			tags: getToolTags(toolName),
			approved,
			success,
		};

		this.records.push(record);
		this.pruneOldRecords();
	}

	/**
	 * Remove old records from the window
	 */
	private pruneOldRecords(): void {
		const cutoff = Date.now() - this.maxAgeMs;

		// Remove records older than cutoff
		this.records = this.records.filter((r) => r.timestamp > cutoff);

		// Trim to max size
		if (this.records.length > this.maxRecords) {
			this.records = this.records.slice(-this.maxRecords);
		}
	}

	/**
	 * Sanitize args for storage (remove large values)
	 */
	private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string") {
				// Truncate long strings
				sanitized[key] =
					value.length > 200 ? `${value.slice(0, 200)}...` : value;
			} else if (typeof value === "number" || typeof value === "boolean") {
				sanitized[key] = value;
			} else if (Array.isArray(value)) {
				sanitized[key] = `[Array: ${value.length} items]`;
			} else if (value && typeof value === "object") {
				sanitized[key] = "[Object]";
			}
		}

		return sanitized;
	}

	/**
	 * Get current record count
	 */
	getRecordCount(): number {
		return this.records.length;
	}

	/**
	 * Clear all records
	 */
	clear(): void {
		this.records = [];
	}

	/**
	 * Get a summary of recent activity
	 */
	getSummary(): {
		totalCalls: number;
		byTool: Record<string, number>;
		byTag: Record<string, number>;
	} {
		const byTool: Record<string, number> = {};
		const byTag: Record<string, number> = {};

		for (const record of this.records) {
			byTool[record.tool] = (byTool[record.tool] || 0) + 1;
			for (const tag of record.tags) {
				byTag[tag] = (byTag[tag] || 0) + 1;
			}
		}

		return {
			totalCalls: this.records.length,
			byTool,
			byTag,
		};
	}
}

/**
 * Default analyzer instance
 */
export const defaultToolSequenceAnalyzer = new ToolSequenceAnalyzer();
