/**
 * Session state tracking module.
 *
 * Provides enhanced tracking of session-level state including:
 * - Per-model token usage and costs
 * - Web search request counts
 * - Session duration and turn counts
 * - Plan mode state
 * - Bypass permissions mode
 *
 * Inspired by Claude Code's session state management patterns.
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("session-state");

/**
 * Per-model usage statistics.
 */
export interface ModelUsageStats {
	/** Input tokens consumed */
	inputTokens: number;
	/** Output tokens generated */
	outputTokens: number;
	/** Cache read input tokens */
	cacheReadInputTokens: number;
	/** Cache creation input tokens */
	cacheCreationInputTokens: number;
	/** Web search requests made */
	webSearchRequests: number;
	/** Total cost in USD */
	costUSD: number;
	/** Context window size for this model */
	contextWindow: number;
}

/**
 * Session state tracking.
 */
export interface SessionState {
	/** Session ID */
	sessionId: string;
	/** Original working directory at session start */
	originalCwd: string;
	/** Current working directory */
	cwd: string;
	/** Session start timestamp */
	startTime: number;
	/** Last interaction timestamp */
	lastInteractionTime: number;
	/** Total cost in USD */
	totalCostUSD: number;
	/** Total API duration in ms */
	totalAPIDuration: number;
	/** Total API duration excluding retries */
	totalAPIDurationWithoutRetries: number;
	/** Total tool execution duration in ms */
	totalToolDuration: number;
	/** Lines of code added */
	totalLinesAdded: number;
	/** Lines of code removed */
	totalLinesRemoved: number;
	/** Whether any model cost is unknown */
	hasUnknownModelCost: boolean;
	/** Per-model usage tracking */
	modelUsage: Record<string, ModelUsageStats>;
	/** Current main loop model override */
	mainLoopModelOverride?: string;
	/** Initial main loop model */
	initialMainLoopModel?: string;
	/** Whether session is interactive */
	isInteractive: boolean;
	/** Client type (cli, api, vscode, etc.) */
	clientType: string;
	/** Whether bypass permissions mode is enabled for this session */
	sessionBypassPermissionsMode: boolean;
	/** Whether user has exited plan mode */
	hasExitedPlanMode: boolean;
	/** Total number of turns */
	turnCount: number;
	/** Total number of subagents spawned */
	subagentCount: number;
	/** Total duration of subagent execution in ms */
	subagentDurationMs: number;
}

/**
 * Create a new session state instance.
 */
export function createSessionState(options: {
	sessionId: string;
	cwd: string;
	isInteractive?: boolean;
	clientType?: string;
}): SessionState {
	const now = Date.now();
	return {
		sessionId: options.sessionId,
		originalCwd: options.cwd,
		cwd: options.cwd,
		startTime: now,
		lastInteractionTime: now,
		totalCostUSD: 0,
		totalAPIDuration: 0,
		totalAPIDurationWithoutRetries: 0,
		totalToolDuration: 0,
		totalLinesAdded: 0,
		totalLinesRemoved: 0,
		hasUnknownModelCost: false,
		modelUsage: {},
		isInteractive: options.isInteractive ?? true,
		clientType: options.clientType ?? "cli",
		sessionBypassPermissionsMode: false,
		hasExitedPlanMode: false,
		turnCount: 0,
		subagentCount: 0,
		subagentDurationMs: 0,
	};
}

/**
 * Get context window size for a model.
 */
export function getContextWindowForModel(modelId: string): number {
	// Models with 1M context
	if (modelId.includes("1m") || modelId.includes("1M")) {
		return 1_000_000;
	}
	// Default to 200K for most Claude models
	return 200_000;
}

/**
 * Record API usage for a model.
 */
export function recordModelUsage(
	state: SessionState,
	modelId: string,
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		webSearchRequests?: number;
		costUSD: number;
	},
): void {
	const existing = state.modelUsage[modelId] ?? {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		webSearchRequests: 0,
		costUSD: 0,
		contextWindow: getContextWindowForModel(modelId),
	};

	existing.inputTokens += usage.inputTokens;
	existing.outputTokens += usage.outputTokens;
	existing.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
	existing.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
	existing.webSearchRequests += usage.webSearchRequests ?? 0;
	existing.costUSD += usage.costUSD;

	state.modelUsage[modelId] = existing;
	state.totalCostUSD += usage.costUSD;
	state.lastInteractionTime = Date.now();

	logger.debug("Recorded model usage", {
		modelId,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		costUSD: usage.costUSD,
	});
}

/**
 * Record tool execution duration.
 */
export function recordToolDuration(
	state: SessionState,
	durationMs: number,
): void {
	state.totalToolDuration += durationMs;
	state.lastInteractionTime = Date.now();
}

/**
 * Record API call duration.
 */
export function recordAPIDuration(
	state: SessionState,
	durationMs: number,
	isRetry = false,
): void {
	state.totalAPIDuration += durationMs;
	if (!isRetry) {
		state.totalAPIDurationWithoutRetries += durationMs;
	}
	state.lastInteractionTime = Date.now();
}

/**
 * Record lines of code changed.
 */
export function recordLinesChanged(
	state: SessionState,
	added: number,
	removed: number,
): void {
	state.totalLinesAdded += added;
	state.totalLinesRemoved += removed;
}

/**
 * Record a subagent completion.
 */
export function recordSubagentCompletion(
	state: SessionState,
	durationMs: number,
): void {
	state.subagentCount += 1;
	state.subagentDurationMs += durationMs;
}

/**
 * Increment turn count.
 */
export function incrementTurnCount(state: SessionState): void {
	state.turnCount += 1;
	state.lastInteractionTime = Date.now();
}

/**
 * Set plan mode exited state.
 */
export function setPlanModeExited(state: SessionState, exited: boolean): void {
	state.hasExitedPlanMode = exited;
}

/**
 * Set bypass permissions mode.
 */
export function setBypassPermissionsMode(
	state: SessionState,
	bypass: boolean,
): void {
	state.sessionBypassPermissionsMode = bypass;
}

/**
 * Get session duration in milliseconds.
 */
export function getSessionDuration(state: SessionState): number {
	return Date.now() - state.startTime;
}

/**
 * Get aggregated token totals across all models.
 */
export function getTokenTotals(state: SessionState): {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	webSearchRequests: number;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadInputTokens = 0;
	let cacheCreationInputTokens = 0;
	let webSearchRequests = 0;

	for (const usage of Object.values(state.modelUsage)) {
		inputTokens += usage.inputTokens;
		outputTokens += usage.outputTokens;
		cacheReadInputTokens += usage.cacheReadInputTokens;
		cacheCreationInputTokens += usage.cacheCreationInputTokens;
		webSearchRequests += usage.webSearchRequests;
	}

	return {
		inputTokens,
		outputTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		webSearchRequests,
	};
}

/**
 * Get a summary of session state for display or logging.
 */
export function getSessionSummary(state: SessionState): {
	sessionId: string;
	durationMs: number;
	durationFormatted: string;
	totalCostUSD: number;
	totalCostFormatted: string;
	turnCount: number;
	linesChanged: { added: number; removed: number };
	tokens: ReturnType<typeof getTokenTotals>;
	modelCount: number;
	subagentStats: { count: number; durationMs: number };
} {
	const durationMs = getSessionDuration(state);
	const tokens = getTokenTotals(state);

	// Format duration
	const seconds = Math.floor(durationMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	let durationFormatted: string;
	if (hours > 0) {
		durationFormatted = `${hours}h ${minutes % 60}m`;
	} else if (minutes > 0) {
		durationFormatted = `${minutes}m ${seconds % 60}s`;
	} else {
		durationFormatted = `${seconds}s`;
	}

	// Format cost
	const totalCostFormatted =
		state.totalCostUSD < 0.01
			? `$${state.totalCostUSD.toFixed(4)}`
			: `$${state.totalCostUSD.toFixed(2)}`;

	return {
		sessionId: state.sessionId,
		durationMs,
		durationFormatted,
		totalCostUSD: state.totalCostUSD,
		totalCostFormatted,
		turnCount: state.turnCount,
		linesChanged: {
			added: state.totalLinesAdded,
			removed: state.totalLinesRemoved,
		},
		tokens,
		modelCount: Object.keys(state.modelUsage).length,
		subagentStats: {
			count: state.subagentCount,
			durationMs: state.subagentDurationMs,
		},
	};
}

/**
 * Reset session statistics (but keep session ID and directories).
 */
export function resetSessionStats(state: SessionState): void {
	state.startTime = Date.now();
	state.lastInteractionTime = Date.now();
	state.totalCostUSD = 0;
	state.totalAPIDuration = 0;
	state.totalAPIDurationWithoutRetries = 0;
	state.totalToolDuration = 0;
	state.totalLinesAdded = 0;
	state.totalLinesRemoved = 0;
	state.hasUnknownModelCost = false;
	state.modelUsage = {};
	state.turnCount = 0;
	state.subagentCount = 0;
	state.subagentDurationMs = 0;
}
