/**
 * Loop Detector - Automatic detection of repetitive tool patterns
 *
 * This module detects when the agent appears to be stuck in a loop, either
 * from confusion, injection attacks, or other issues. It monitors tool calls
 * and triggers warnings or pauses when repetitive patterns are detected.
 *
 * ## Detection Methods
 *
 * 1. **Exact Repetition**: Same tool+args called multiple times
 * 2. **Similar Operations**: Same tool with varying args (e.g., reading similar paths)
 * 3. **Cyclic Patterns**: Repeating sequences of tools (A→B→C→A→B→C)
 * 4. **High Frequency**: Unusually rapid tool execution
 *
 * ## Actions
 *
 * - **warn**: Log a warning for monitoring
 * - **pause**: Require user confirmation to continue
 * - **halt**: Stop execution entirely
 *
 * @module safety/loop-detector
 */

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:loop-detector");

/**
 * Configuration for loop detection
 */
export interface LoopDetectorConfig {
	/** Maximum identical calls before warning (default: 3) */
	maxIdenticalCalls?: number;
	/** Maximum similar calls before warning (default: 5) */
	maxSimilarCalls?: number;
	/** Time window for detection in ms (default: 60000) */
	windowMs?: number;
	/** Minimum time between calls in ms (default: 100) */
	minCallIntervalMs?: number;
	/** Maximum calls per minute before warning (default: 60) */
	maxCallsPerMinute?: number;
	/** Enable/disable auto-pause (default: true) */
	autoPause?: boolean;
}

/**
 * Loop detection result
 */
export interface LoopDetectionResult {
	/** Whether a loop was detected */
	detected: boolean;
	/** Type of loop detected */
	type?: "exact" | "similar" | "cyclic" | "frequency";
	/** Recommended action */
	action?: "warn" | "pause" | "halt";
	/** Human-readable description */
	reason?: string;
	/** Number of repetitions detected */
	repetitions?: number;
	/** Suggestion for the user */
	suggestion?: string;
}

/**
 * Internal record of a tool call
 */
interface CallRecord {
	/** Hash of tool + args */
	hash: string;
	/** Tool name */
	tool: string;
	/** Simplified args signature */
	argsSignature: string;
	/** Timestamp */
	timestamp: number;
}

/**
 * Generate a hash for a tool call
 */
function hashCall(tool: string, args: Record<string, unknown>): string {
	const normalized = JSON.stringify(
		{ tool, args },
		Object.keys({ tool, args }).sort(),
	);
	return createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate a simplified signature for args (for similarity detection)
 */
function getArgsSignature(args: Record<string, unknown>): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") {
			// For strings, use a normalized version (lowercase, truncated)
			const normalized = value.toLowerCase().slice(0, 50);
			parts.push(`${key}:str(${normalized.length})`);
		} else if (typeof value === "number") {
			parts.push(`${key}:num`);
		} else if (typeof value === "boolean") {
			parts.push(`${key}:bool`);
		} else if (Array.isArray(value)) {
			parts.push(`${key}:arr(${value.length})`);
		} else if (value && typeof value === "object") {
			parts.push(`${key}:obj`);
		}
	}

	return parts.sort().join(",");
}

/**
 * Detect cyclic patterns in a sequence
 * Returns the cycle length if found, 0 otherwise
 */
function detectCycle(
	sequence: string[],
	minCycleLength = 2,
	maxCycleLength = 10,
): number {
	if (sequence.length < minCycleLength * 2) {
		return 0;
	}

	// Try different cycle lengths
	for (let cycleLen = minCycleLength; cycleLen <= maxCycleLength; cycleLen++) {
		if (sequence.length < cycleLen * 2) {
			break;
		}

		// Check if the last cycleLen items match the previous cycleLen items
		let isCycle = true;
		for (let i = 0; i < cycleLen; i++) {
			const idx1 = sequence.length - 1 - i;
			const idx2 = sequence.length - 1 - cycleLen - i;
			if (idx2 < 0 || sequence[idx1] !== sequence[idx2]) {
				isCycle = false;
				break;
			}
		}

		if (isCycle) {
			// Verify the cycle repeats at least once more
			const lastIdx = sequence.length - 1 - cycleLen * 2;
			if (lastIdx >= 0) {
				let hasThirdRepeat = true;
				for (let i = 0; i < cycleLen && lastIdx - i >= 0; i++) {
					if (sequence[lastIdx - i] !== sequence[sequence.length - 1 - i]) {
						hasThirdRepeat = false;
						break;
					}
				}
				if (hasThirdRepeat) {
					return cycleLen;
				}
			}
			return cycleLen;
		}
	}

	return 0;
}

/**
 * Loop Detector class
 */
export class LoopDetector {
	private config: Required<LoopDetectorConfig>;
	private records: CallRecord[] = [];
	private isPaused = false;
	private pauseReason?: string;

	constructor(config?: LoopDetectorConfig) {
		this.config = {
			maxIdenticalCalls: config?.maxIdenticalCalls ?? 3,
			maxSimilarCalls: config?.maxSimilarCalls ?? 5,
			windowMs: config?.windowMs ?? 60000,
			minCallIntervalMs: config?.minCallIntervalMs ?? 100,
			maxCallsPerMinute: config?.maxCallsPerMinute ?? 60,
			autoPause: config?.autoPause ?? true,
		};
	}

	/**
	 * Check a tool call for loop patterns
	 */
	check(tool: string, args: Record<string, unknown>): LoopDetectionResult {
		const now = Date.now();
		const hash = hashCall(tool, args);
		const argsSignature = getArgsSignature(args);

		// Prune old records
		this.pruneRecords(now);

		// Check for paused state
		if (this.isPaused) {
			return {
				detected: true,
				type: "exact",
				action: "pause",
				reason: this.pauseReason ?? "Loop detector is paused",
				suggestion: "Resume execution or investigate the repeated pattern",
			};
		}

		// Check 1: Exact repetition
		const identicalCount = this.records.filter((r) => r.hash === hash).length;
		if (identicalCount >= this.config.maxIdenticalCalls) {
			const result: LoopDetectionResult = {
				detected: true,
				type: "exact",
				action: this.config.autoPause ? "pause" : "warn",
				reason: `Identical tool call repeated ${identicalCount + 1} times: ${tool}`,
				repetitions: identicalCount + 1,
				suggestion: "Check if the operation is completing successfully",
			};

			if (this.config.autoPause) {
				this.pause(result.reason!);
			}

			logger.warn("Exact repetition loop detected", {
				tool,
				count: identicalCount + 1,
			});

			return result;
		}

		// Check 2: Similar operations (same tool, similar args pattern)
		const similarCount = this.records.filter(
			(r) => r.tool === tool && r.argsSignature === argsSignature,
		).length;
		if (similarCount >= this.config.maxSimilarCalls) {
			const result: LoopDetectionResult = {
				detected: true,
				type: "similar",
				action: this.config.autoPause ? "pause" : "warn",
				reason: `Similar ${tool} calls detected ${similarCount + 1} times`,
				repetitions: similarCount + 1,
				suggestion: "Verify that these operations are intentional",
			};

			if (this.config.autoPause) {
				this.pause(result.reason!);
			}

			logger.warn("Similar operation loop detected", {
				tool,
				count: similarCount + 1,
			});

			return result;
		}

		// Check 3: Cyclic patterns
		const toolSequence = [...this.records.map((r) => r.tool), tool];
		const cycleLength = detectCycle(toolSequence);
		if (cycleLength > 0) {
			const cyclePattern = toolSequence.slice(-cycleLength).join(" → ");
			const result: LoopDetectionResult = {
				detected: true,
				type: "cyclic",
				action: "warn",
				reason: `Cyclic pattern detected: ${cyclePattern}`,
				repetitions: 2,
				suggestion: "The agent may be stuck in a decision loop",
			};

			logger.warn("Cyclic pattern detected", {
				cycleLength,
				pattern: cyclePattern,
			});

			return result;
		}

		// Check 4: High frequency
		const recentCalls = this.records.filter(
			(r) => now - r.timestamp < 60000,
		).length;
		if (recentCalls >= this.config.maxCallsPerMinute) {
			const result: LoopDetectionResult = {
				detected: true,
				type: "frequency",
				action: "warn",
				reason: `High call frequency detected: ${recentCalls + 1} calls in the last minute`,
				repetitions: recentCalls + 1,
				suggestion: "Consider if this many operations are necessary",
			};

			logger.warn("High frequency loop detected", {
				callsPerMinute: recentCalls + 1,
			});

			return result;
		}

		// Check 5: Too rapid calls
		const lastCall = this.records[this.records.length - 1];
		if (lastCall && now - lastCall.timestamp < this.config.minCallIntervalMs) {
			// Don't trigger on this alone, just note it
			logger.debug("Very rapid tool calls detected", {
				intervalMs: now - lastCall.timestamp,
			});
		}

		return { detected: false };
	}

	/**
	 * Record a tool call (call after check)
	 */
	record(tool: string, args: Record<string, unknown>): void {
		const now = Date.now();
		this.records.push({
			hash: hashCall(tool, args),
			tool,
			argsSignature: getArgsSignature(args),
			timestamp: now,
		});

		// Keep records bounded
		if (this.records.length > 200) {
			this.records = this.records.slice(-100);
		}
	}

	/**
	 * Pause the detector (requires resume to continue)
	 */
	pause(reason: string): void {
		this.isPaused = true;
		this.pauseReason = reason;
		logger.info("Loop detector paused", { reason });
	}

	/**
	 * Resume from paused state
	 */
	resume(): void {
		this.isPaused = false;
		this.pauseReason = undefined;
		logger.info("Loop detector resumed");
	}

	/**
	 * Check if detector is paused
	 */
	isPausedState(): boolean {
		return this.isPaused;
	}

	/**
	 * Get pause reason
	 */
	getPauseReason(): string | undefined {
		return this.pauseReason;
	}

	/**
	 * Clear all records and reset state
	 */
	reset(): void {
		this.records = [];
		this.isPaused = false;
		this.pauseReason = undefined;
	}

	/**
	 * Get statistics about recent calls
	 */
	getStats(): {
		totalRecords: number;
		uniqueTools: number;
		uniqueHashes: number;
		oldestRecordAge: number | null;
		isPaused: boolean;
	} {
		const now = Date.now();
		const uniqueTools = new Set(this.records.map((r) => r.tool)).size;
		const uniqueHashes = new Set(this.records.map((r) => r.hash)).size;
		const oldestRecord = this.records[0];

		return {
			totalRecords: this.records.length,
			uniqueTools,
			uniqueHashes,
			oldestRecordAge: oldestRecord ? now - oldestRecord.timestamp : null,
			isPaused: this.isPaused,
		};
	}

	/**
	 * Prune records older than the window
	 */
	private pruneRecords(now: number): void {
		const cutoff = now - this.config.windowMs;
		this.records = this.records.filter((r) => r.timestamp > cutoff);
	}
}

/**
 * Default loop detector instance
 */
export const defaultLoopDetector = new LoopDetector();

/**
 * Integration helper for tool execution
 *
 * Call this before executing each tool. Returns an action to take.
 */
export function checkForLoop(
	tool: string,
	args: Record<string, unknown>,
	detector: LoopDetector = defaultLoopDetector,
): {
	shouldProceed: boolean;
	requiresConfirmation: boolean;
	message?: string;
} {
	const result = detector.check(tool, args);

	if (!result.detected) {
		detector.record(tool, args);
		return { shouldProceed: true, requiresConfirmation: false };
	}

	switch (result.action) {
		case "halt":
			return {
				shouldProceed: false,
				requiresConfirmation: false,
				message: result.reason,
			};

		case "pause":
			return {
				shouldProceed: false,
				requiresConfirmation: true,
				message: `${result.reason}. ${result.suggestion ?? ""}`,
			};
		default:
			// Record and continue with warning
			detector.record(tool, args);
			return {
				shouldProceed: true,
				requiresConfirmation: false,
				message: result.reason,
			};
	}
}
