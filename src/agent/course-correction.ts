/**
 * Course Correction System.
 *
 * Monitors agent behavior and automatically injects steering messages when
 * the agent appears to be going off-track. Inspired by Amp's course correction.
 *
 * Detection patterns:
 * - Repeated failed tool calls (same tool failing multiple times)
 * - Looping behavior (same action repeated without progress)
 * - Ignoring user instructions (not addressing key parts of request)
 * - Over-engineering (adding unnecessary complexity)
 * - Scope creep (working on unrelated tasks)
 */

import { createLogger } from "../utils/logger.js";
import type { AgentEvent, AppMessage, AssistantMessage } from "./types.js";

const logger = createLogger("course-correction");

/**
 * A detected issue that may need correction.
 */
export interface DetectedIssue {
	/** Type of issue detected */
	type: CourseIssueType;
	/** Severity from 0-1 (higher = more severe) */
	severity: number;
	/** Human-readable description */
	description: string;
	/** Suggested correction message to inject */
	correction: string;
	/** Evidence that led to this detection */
	evidence: string[];
}

/**
 * Types of issues that can be detected.
 */
export type CourseIssueType =
	| "repeated_failure"
	| "loop_detected"
	| "scope_creep"
	| "over_engineering"
	| "ignoring_instructions"
	| "stuck"
	| "excessive_tool_calls";

/**
 * Configuration for the course corrector.
 */
export interface CourseCorrectorConfig {
	/** Whether course correction is enabled */
	enabled: boolean;
	/** Minimum severity threshold to trigger correction (0-1) */
	severityThreshold: number;
	/** Maximum corrections per session */
	maxCorrectionsPerSession: number;
	/** Minimum turns between corrections */
	minTurnsBetweenCorrections: number;
	/** Maximum tool calls before warning about excessive usage */
	maxToolCallsPerTurn: number;
	/** Number of repeated failures before triggering */
	repeatedFailureThreshold: number;
	/** Number of similar actions to detect a loop */
	loopDetectionWindow: number;
}

const DEFAULT_CONFIG: CourseCorrectorConfig = {
	enabled: true,
	severityThreshold: 0.5,
	maxCorrectionsPerSession: 5,
	minTurnsBetweenCorrections: 3,
	maxToolCallsPerTurn: 15,
	repeatedFailureThreshold: 3,
	loopDetectionWindow: 5,
};

/**
 * Tracks state for course correction detection.
 */
interface CorrectionState {
	/** Total corrections issued this session */
	totalCorrections: number;
	/** Turn number of last correction */
	lastCorrectionTurn: number;
	/** Current turn number */
	currentTurn: number;
	/** Recent tool calls for loop detection */
	recentToolCalls: ToolCallRecord[];
	/** Tool failure counts by tool name */
	toolFailures: Map<string, number>;
	/** Tool calls in current turn */
	toolCallsThisTurn: number;
	/** Original user request for scope checking */
	originalRequest: string | null;
	/** Key topics/keywords from original request */
	requestKeywords: Set<string>;
}

interface ToolCallRecord {
	toolName: string;
	inputHash: string;
	success: boolean;
	turn: number;
}

/**
 * Course Corrector monitors agent behavior and injects steering when needed.
 */
export class CourseCorrector {
	private config: CourseCorrectorConfig;
	private state: CorrectionState;

	constructor(config: Partial<CourseCorrectorConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.state = this.createInitialState();
	}

	private createInitialState(): CorrectionState {
		return {
			totalCorrections: 0,
			lastCorrectionTurn: Number.NEGATIVE_INFINITY,
			currentTurn: 0,
			recentToolCalls: [],
			toolFailures: new Map(),
			toolCallsThisTurn: 0,
			originalRequest: null,
			requestKeywords: new Set(),
		};
	}

	/**
	 * Reset state for a new session.
	 */
	reset(): void {
		this.state = this.createInitialState();
	}

	/**
	 * Record a new user turn and extract intent.
	 */
	recordUserTurn(message: string): void {
		this.state.currentTurn++;
		this.state.toolCallsThisTurn = 0;

		// Store original request if this is the first user message
		if (this.state.originalRequest === null) {
			this.state.originalRequest = message;
			this.state.requestKeywords = this.extractKeywords(message);
		}
	}

	/**
	 * Record a tool call for pattern detection.
	 */
	recordToolCall(
		toolName: string,
		input: Record<string, unknown>,
		success: boolean,
	): void {
		this.state.toolCallsThisTurn++;

		const inputHash = this.hashInput(input);
		this.state.recentToolCalls.push({
			toolName,
			inputHash,
			success,
			turn: this.state.currentTurn,
		});

		// Keep only recent calls
		if (this.state.recentToolCalls.length > 20) {
			this.state.recentToolCalls.shift();
		}

		// Track failures
		if (!success) {
			const count = this.state.toolFailures.get(toolName) || 0;
			this.state.toolFailures.set(toolName, count + 1);
		} else {
			// Reset failure count on success
			this.state.toolFailures.set(toolName, 0);
		}
	}

	/**
	 * Analyze current state and detect any issues.
	 */
	detectIssues(): DetectedIssue[] {
		if (!this.config.enabled) {
			return [];
		}

		const issues: DetectedIssue[] = [];

		// Check repeated failures
		const failureIssue = this.detectRepeatedFailures();
		if (failureIssue) issues.push(failureIssue);

		// Check for loops
		const loopIssue = this.detectLoops();
		if (loopIssue) issues.push(loopIssue);

		// Check excessive tool calls
		const excessiveIssue = this.detectExcessiveToolCalls();
		if (excessiveIssue) issues.push(excessiveIssue);

		// Sort by severity
		issues.sort((a, b) => b.severity - a.severity);

		return issues;
	}

	/**
	 * Get a correction message if one should be issued.
	 */
	getCorrection(): string | null {
		if (!this.config.enabled) {
			return null;
		}

		// Check if we've exceeded max corrections
		if (this.state.totalCorrections >= this.config.maxCorrectionsPerSession) {
			return null;
		}

		// Check minimum turns between corrections
		const turnsSinceCorrection =
			this.state.currentTurn - this.state.lastCorrectionTurn;
		if (turnsSinceCorrection < this.config.minTurnsBetweenCorrections) {
			return null;
		}

		const issues = this.detectIssues();
		const significantIssue = issues.find(
			(i) => i.severity >= this.config.severityThreshold,
		);

		if (!significantIssue) {
			return null;
		}

		// Record this correction
		this.state.totalCorrections++;
		this.state.lastCorrectionTurn = this.state.currentTurn;

		logger.info("Course correction triggered", {
			issueType: significantIssue.type,
			severity: significantIssue.severity,
			description: significantIssue.description,
		});

		return significantIssue.correction;
	}

	/**
	 * Create a correction from an issue (for manual triggering).
	 */
	createCorrectionFromIssue(issue: DetectedIssue): string {
		this.state.totalCorrections++;
		this.state.lastCorrectionTurn = this.state.currentTurn;
		return issue.correction;
	}

	// =========================================================================
	// Detection Methods
	// =========================================================================

	private detectRepeatedFailures(): DetectedIssue | null {
		for (const [toolName, count] of this.state.toolFailures) {
			if (count >= this.config.repeatedFailureThreshold) {
				return {
					type: "repeated_failure",
					severity: Math.min(0.9, 0.5 + count * 0.1),
					description: `Tool '${toolName}' has failed ${count} times consecutively`,
					correction: `IMPORTANT: The ${toolName} tool has failed multiple times. Please:
1. Stop and reconsider your approach
2. Check if you're using the correct parameters
3. Consider an alternative approach to achieve the same goal
4. If you're stuck, explain the issue to the user and ask for guidance`,
					evidence: [`${toolName} failed ${count} times`],
				};
			}
		}
		return null;
	}

	private detectLoops(): DetectedIssue | null {
		const window = this.config.loopDetectionWindow;
		const recent = this.state.recentToolCalls.slice(-window);

		if (recent.length < window) {
			return null;
		}

		// Check for exact repeats
		const signatures = recent.map((r) => `${r.toolName}:${r.inputHash}`);
		const uniqueSignatures = new Set(signatures);

		// If more than half are duplicates, we might be looping
		if (uniqueSignatures.size <= window / 2) {
			const repeatedAction = signatures[signatures.length - 1];
			return {
				type: "loop_detected",
				severity: 0.7,
				description: `Detected repeated actions: ${repeatedAction}`,
				correction: `NOTICE: You appear to be repeating the same action multiple times without making progress. This suggests you may be stuck in a loop.

Please:
1. Stop and reassess what you're trying to accomplish
2. Consider if there's a different approach
3. If the current approach isn't working, try something else
4. If you're genuinely stuck, explain the situation to the user`,
				evidence: signatures,
			};
		}

		return null;
	}

	private detectExcessiveToolCalls(): DetectedIssue | null {
		if (this.state.toolCallsThisTurn > this.config.maxToolCallsPerTurn) {
			return {
				type: "excessive_tool_calls",
				severity: 0.6,
				description: `${this.state.toolCallsThisTurn} tool calls in a single turn`,
				correction: `NOTICE: You've made ${this.state.toolCallsThisTurn} tool calls in this turn, which is unusually high.

Please:
1. Pause and consolidate your work
2. Summarize what you've accomplished so far
3. Focus on the most important next step
4. Consider if you're over-complicating the solution`,
				evidence: [`${this.state.toolCallsThisTurn} tool calls this turn`],
			};
		}
		return null;
	}

	// =========================================================================
	// Utility Methods
	// =========================================================================

	private extractKeywords(text: string): Set<string> {
		// Extract meaningful words (nouns, verbs) - simplified approach
		const words = text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 3);

		// Filter out common stop words
		const stopWords = new Set([
			"this",
			"that",
			"with",
			"from",
			"have",
			"will",
			"would",
			"could",
			"should",
			"about",
			"there",
			"their",
			"what",
			"when",
			"where",
			"which",
			"while",
			"please",
			"thanks",
			"thank",
			"help",
			"want",
			"need",
			"like",
			"make",
			"just",
			"some",
			"other",
			"into",
			"been",
			"being",
			"does",
			"doing",
		]);

		return new Set(words.filter((w) => !stopWords.has(w)));
	}

	private hashInput(input: Record<string, unknown>): string {
		// Simple hash for comparing inputs
		const str = JSON.stringify(input, Object.keys(input).sort());
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash.toString(36);
	}

	/**
	 * Get current state for debugging/monitoring.
	 */
	getState(): Readonly<CorrectionState> {
		return this.state;
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<CourseCorrectorConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Check if course correction is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}
}

/**
 * Create a course corrector with default configuration.
 */
export function createCourseCorrector(
	config?: Partial<CourseCorrectorConfig>,
): CourseCorrector {
	return new CourseCorrector(config);
}

/**
 * Format a correction message for injection into the conversation.
 */
export function formatCorrectionMessage(correction: string): string {
	return `<system-reminder>
[COURSE CORRECTION]
${correction}
</system-reminder>`;
}

/**
 * Create a ReminderProvider that uses a CourseCorrector.
 * This integrates course correction with the SystemReminderManager.
 */
export function createCourseCorrectionProvider(
	corrector: CourseCorrector,
): import("./system-reminders.js").ReminderProvider {
	return {
		id: "course-correction",
		minInterval: 30000, // 30 seconds minimum between corrections

		getReminders(
			_context: import("./system-reminders.js").ReminderContext,
		): import("./system-reminders.js").SystemReminder[] {
			const correction = corrector.getCorrection();
			if (!correction) {
				return [];
			}

			return [
				{
					id: "course-correction-active",
					content: `[COURSE CORRECTION]\n${correction}`,
					priority: 10, // High priority
				},
			];
		},
	};
}
