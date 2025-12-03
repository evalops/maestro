/**
 * Tool Usage Ledger.
 *
 * Tracks tool calls per session with aggregated statistics.
 * Provides insights into agent behavior and resource usage.
 *
 * Inspired by Amp's tool usage ledger.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("agent:tool-ledger");

/** Single tool call record */
export interface ToolCallRecord {
	/** Tool name */
	toolName: string;
	/** Input parameters (sanitized) */
	input: Record<string, unknown>;
	/** Whether the call succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Duration in milliseconds */
	durationMs: number;
	/** Timestamp of the call */
	timestamp: Date;
	/** Token cost if known */
	tokenCost?: number;
	/** Turn number in conversation */
	turnNumber: number;
}

/** Aggregated stats for a single tool */
export interface ToolStats {
	/** Total number of calls */
	totalCalls: number;
	/** Number of successful calls */
	successCount: number;
	/** Number of failed calls */
	failureCount: number;
	/** Total duration in milliseconds */
	totalDurationMs: number;
	/** Average duration in milliseconds */
	avgDurationMs: number;
	/** Total token cost if tracked */
	totalTokenCost: number;
	/** Last used timestamp */
	lastUsed: Date | null;
}

/** Session-level aggregated stats */
export interface SessionStats {
	/** Total tool calls */
	totalCalls: number;
	/** Total successful calls */
	successCount: number;
	/** Total failed calls */
	failureCount: number;
	/** Success rate (0-1) */
	successRate: number;
	/** Total duration of all tool calls */
	totalDurationMs: number;
	/** Total token cost */
	totalTokenCost: number;
	/** Per-tool breakdown */
	byTool: Map<string, ToolStats>;
	/** Session start time */
	sessionStart: Date;
	/** Most used tools (top 5) */
	topTools: Array<{ tool: string; calls: number }>;
	/** Most error-prone tools */
	errorProneTools: Array<{ tool: string; errorRate: number; calls: number }>;
}

/** Tool usage patterns for analysis */
export interface UsagePattern {
	/** Tool name */
	tool: string;
	/** Common patterns detected */
	patterns: string[];
	/** Frequency score (0-1) */
	frequencyScore: number;
}

/**
 * Tool Usage Ledger.
 *
 * Tracks and analyzes tool usage throughout a session.
 */
export class ToolLedger {
	private records: ToolCallRecord[] = [];
	private statsByTool: Map<string, ToolStats> = new Map();
	private sessionStart: Date = new Date();
	private currentTurn = 0;

	constructor() {
		this.reset();
	}

	/**
	 * Record a tool call.
	 */
	recordCall(
		toolName: string,
		input: Record<string, unknown>,
		success: boolean,
		durationMs: number,
		options?: {
			error?: string;
			tokenCost?: number;
		},
	): void {
		const record: ToolCallRecord = {
			toolName,
			input: this.sanitizeInput(input),
			success,
			durationMs,
			timestamp: new Date(),
			turnNumber: this.currentTurn,
			...options,
		};

		this.records.push(record);
		this.updateStats(record);

		log.debug("Tool call recorded", {
			tool: toolName,
			success,
			durationMs,
			turn: this.currentTurn,
		});
	}

	/**
	 * Increment turn counter.
	 */
	nextTurn(): void {
		this.currentTurn++;
	}

	/**
	 * Get current turn number.
	 */
	getCurrentTurn(): number {
		return this.currentTurn;
	}

	/**
	 * Get stats for a specific tool.
	 */
	getToolStats(toolName: string): ToolStats | null {
		return this.statsByTool.get(toolName) ?? null;
	}

	/**
	 * Get aggregated session stats.
	 */
	getSessionStats(): SessionStats {
		let totalCalls = 0;
		let successCount = 0;
		let failureCount = 0;
		let totalDurationMs = 0;
		let totalTokenCost = 0;

		for (const stats of this.statsByTool.values()) {
			totalCalls += stats.totalCalls;
			successCount += stats.successCount;
			failureCount += stats.failureCount;
			totalDurationMs += stats.totalDurationMs;
			totalTokenCost += stats.totalTokenCost;
		}

		const topTools = Array.from(this.statsByTool.entries())
			.sort((a, b) => b[1].totalCalls - a[1].totalCalls)
			.slice(0, 5)
			.map(([tool, stats]) => ({ tool, calls: stats.totalCalls }));

		const errorProneTools = Array.from(this.statsByTool.entries())
			.filter(([, stats]) => stats.totalCalls >= 3) // Only consider tools with enough calls
			.map(([tool, stats]) => ({
				tool,
				errorRate: stats.failureCount / stats.totalCalls,
				calls: stats.totalCalls,
			}))
			.filter((t) => t.errorRate > 0.2) // More than 20% error rate
			.sort((a, b) => b.errorRate - a.errorRate)
			.slice(0, 5);

		return {
			totalCalls,
			successCount,
			failureCount,
			successRate: totalCalls > 0 ? successCount / totalCalls : 1,
			totalDurationMs,
			totalTokenCost,
			byTool: this.statsByTool,
			sessionStart: this.sessionStart,
			topTools,
			errorProneTools,
		};
	}

	/**
	 * Get recent tool calls.
	 */
	getRecentCalls(limit = 10): ToolCallRecord[] {
		return this.records.slice(-limit);
	}

	/**
	 * Get all calls for a specific tool.
	 */
	getCallsForTool(toolName: string): ToolCallRecord[] {
		return this.records.filter((r) => r.toolName === toolName);
	}

	/**
	 * Detect repeated failures (potential loop).
	 */
	detectRepeatedFailures(threshold = 3): string | null {
		const recentFailures = this.records
			.filter((r) => !r.success)
			.slice(-threshold);

		if (recentFailures.length < threshold) {
			return null;
		}

		// Check if same tool failed repeatedly
		const toolCounts = new Map<string, number>();
		for (const record of recentFailures) {
			const count = (toolCounts.get(record.toolName) ?? 0) + 1;
			toolCounts.set(record.toolName, count);
			if (count >= threshold) {
				return `Tool "${record.toolName}" has failed ${count} times in a row`;
			}
		}

		// Check if similar errors occurred
		const errorMessages = recentFailures
			.filter((r): r is ToolCallRecord & { error: string } => Boolean(r.error))
			.map((r) => r.error);

		if (errorMessages.length >= threshold) {
			const uniqueErrors = new Set(errorMessages);
			if (uniqueErrors.size === 1) {
				return `Same error repeated ${threshold} times: ${errorMessages[0]}`;
			}
		}

		return null;
	}

	/**
	 * Detect excessive tool usage.
	 */
	detectExcessiveUsage(
		maxCallsPerTurn = 20,
	): { tool: string; count: number } | null {
		const currentTurnCalls = this.records.filter(
			(r) => r.turnNumber === this.currentTurn,
		);

		if (currentTurnCalls.length <= maxCallsPerTurn) {
			return null;
		}

		// Find most called tool this turn
		const toolCounts = new Map<string, number>();
		for (const record of currentTurnCalls) {
			toolCounts.set(
				record.toolName,
				(toolCounts.get(record.toolName) ?? 0) + 1,
			);
		}

		let maxTool = "";
		let maxCount = 0;
		for (const [tool, count] of toolCounts) {
			if (count > maxCount) {
				maxTool = tool;
				maxCount = count;
			}
		}

		return { tool: maxTool, count: maxCount };
	}

	/**
	 * Format stats for display.
	 */
	formatStats(): string {
		const stats = this.getSessionStats();
		const lines: string[] = [
			"Tool Usage Summary",
			"==================",
			`Total Calls: ${stats.totalCalls}`,
			`Success Rate: ${Math.round(stats.successRate * 100)}%`,
			`Total Duration: ${Math.round(stats.totalDurationMs / 1000)}s`,
			"",
			"Top Tools:",
		];

		for (const { tool, calls } of stats.topTools) {
			const toolStats = this.statsByTool.get(tool);
			if (!toolStats) continue;
			const rate = Math.round(
				(toolStats.successCount / toolStats.totalCalls) * 100,
			);
			lines.push(`  ${tool}: ${calls} calls (${rate}% success)`);
		}

		if (stats.errorProneTools.length > 0) {
			lines.push("", "Error-Prone Tools:");
			for (const { tool, errorRate, calls } of stats.errorProneTools) {
				lines.push(
					`  ${tool}: ${Math.round(errorRate * 100)}% error rate (${calls} calls)`,
				);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Export ledger as JSON.
	 */
	toJSON(): {
		records: ToolCallRecord[];
		stats: SessionStats;
		sessionStart: string;
	} {
		return {
			records: this.records,
			stats: this.getSessionStats(),
			sessionStart: this.sessionStart.toISOString(),
		};
	}

	/**
	 * Reset the ledger.
	 */
	reset(): void {
		this.records = [];
		this.statsByTool.clear();
		this.sessionStart = new Date();
		this.currentTurn = 0;
	}

	/**
	 * Update stats for a tool.
	 */
	private updateStats(record: ToolCallRecord): void {
		const existing = this.statsByTool.get(record.toolName);

		if (existing) {
			existing.totalCalls++;
			if (record.success) {
				existing.successCount++;
			} else {
				existing.failureCount++;
			}
			existing.totalDurationMs += record.durationMs;
			existing.avgDurationMs = existing.totalDurationMs / existing.totalCalls;
			existing.totalTokenCost += record.tokenCost ?? 0;
			existing.lastUsed = record.timestamp;
		} else {
			this.statsByTool.set(record.toolName, {
				totalCalls: 1,
				successCount: record.success ? 1 : 0,
				failureCount: record.success ? 0 : 1,
				totalDurationMs: record.durationMs,
				avgDurationMs: record.durationMs,
				totalTokenCost: record.tokenCost ?? 0,
				lastUsed: record.timestamp,
			});
		}
	}

	/**
	 * Sanitize input to avoid storing sensitive data.
	 */
	private sanitizeInput(
		input: Record<string, unknown>,
	): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(input)) {
			// Skip sensitive-looking keys
			if (/password|secret|token|key|auth|credential/i.test(key)) {
				sanitized[key] = "[REDACTED]";
				continue;
			}

			// Truncate long strings
			if (typeof value === "string" && value.length > 200) {
				sanitized[key] = `${value.substring(0, 200)}...`;
			} else if (typeof value === "object" && value !== null) {
				// Just note the type for complex objects
				sanitized[key] = `[${Array.isArray(value) ? "Array" : "Object"}]`;
			} else {
				sanitized[key] = value;
			}
		}

		return sanitized;
	}
}

/**
 * Create a new tool ledger.
 */
export function createToolLedger(): ToolLedger {
	return new ToolLedger();
}

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${(ms / 60000).toFixed(1)}m`;
}
