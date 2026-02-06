/**
 * Type definitions for the Tool Sequence Analyzer
 *
 * @module safety/sequence-analyzer-types
 */

/**
 * Tool call record for sequence analysis
 */
export interface ToolCallRecord {
	/** Tool name */
	tool: string;
	/** Tool arguments (sanitized) */
	args: Record<string, unknown>;
	/** Timestamp of the call */
	timestamp: number;
	/** Tags/categories for the tool */
	tags: Set<string>;
	/** Whether the call was approved */
	approved: boolean;
	/** Whether the call succeeded */
	success?: boolean;
}

/**
 * Suspicious pattern detection result
 */
export interface SequenceAnalysisResult {
	/** Recommended action */
	action: "allow" | "require_approval" | "block";
	/** Pattern ID if detected */
	patternId?: string;
	/** Human-readable reason */
	reason?: string;
	/** Severity level */
	severity?: "low" | "medium" | "high" | "critical";
	/** Matching records that triggered the pattern */
	matchingRecords?: ToolCallRecord[];
}

/**
 * Pattern definition for suspicious sequences
 */
export interface SequencePattern {
	/** Unique identifier */
	id: string;
	/** Human-readable description */
	description: string;
	/** Severity level */
	severity: "low" | "medium" | "high" | "critical";
	/** Recommended action when detected */
	action: "log" | "require_approval" | "block";
	/** Minimum time window for the pattern (ms) */
	windowMs?: number;
	/** Detection function */
	detect: (
		records: ToolCallRecord[],
		currentTool: string,
		currentArgs: Record<string, unknown>,
	) => {
		matched: boolean;
		reason?: string;
		matchingRecords?: ToolCallRecord[];
	};
}

/**
 * Session-level statistics for temporal evasion detection
 * These persist for the entire session and don't get pruned by time
 */
export interface SessionStats {
	/** Total tool calls in session */
	totalToolCalls: number;
	/** Tool call counts by type */
	toolCounts: Map<string, number>;
	/** Sensitive file accesses in session */
	sensitiveAccesses: number;
	/** Network egress operations in session */
	egressOperations: number;
	/** Session start time */
	sessionStart: number;
	/** Unique paths accessed */
	uniquePaths: Set<string>;
}
