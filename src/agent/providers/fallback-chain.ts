/**
 * Model Fallback Chain
 *
 * Provides resilience against API outages by automatically falling back to
 * alternative models when the primary model fails.
 *
 * ## Features
 *
 * - Configurable fallback chains per primary model
 * - Automatic retry with exponential backoff
 * - Health tracking to skip known-failing models
 * - Cost-aware fallback ordering
 *
 * ## Usage
 *
 * ```typescript
 * import { modelFallbackChain } from "./fallback-chain.js";
 *
 * // Configure fallback chain
 * modelFallbackChain.setChain("claude-sonnet-4-20250514", [
 *   "claude-3-5-sonnet-20241022",
 *   "gpt-4o",
 *   "gemini-1.5-pro",
 * ]);
 *
 * // Get next model to try
 * const model = modelFallbackChain.getNextModel("claude-sonnet-4-20250514");
 *
 * // Report failure
 * modelFallbackChain.reportFailure("claude-sonnet-4-20250514", "rate_limit");
 * ```
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("providers:fallback-chain");

/**
 * Failure types that trigger fallback
 */
export type FailureType =
	| "rate_limit"
	| "timeout"
	| "server_error"
	| "auth_error"
	| "capacity"
	| "network"
	| "unknown";

/**
 * Model health status
 */
interface ModelHealth {
	failures: number;
	lastFailure: number | null;
	lastSuccess: number | null;
	lastFailureType: FailureType | null;
	consecutiveFailures: number;
}

/**
 * Default fallback chains by model family
 */
const DEFAULT_CHAINS: Record<string, string[]> = {
	// Claude 4 fallbacks
	"claude-sonnet-4-20250514": [
		"claude-3-5-sonnet-20241022",
		"gpt-4o",
		"gemini-1.5-pro",
	],
	"claude-opus-4-20250514": [
		"claude-opus-4-5-20251101",
		"claude-sonnet-4-20250514",
		"gpt-4-turbo",
	],
	"claude-opus-4-5-20251101": [
		"claude-opus-4-20250514",
		"claude-sonnet-4-20250514",
		"gpt-4-turbo",
	],

	// Claude 3.5 fallbacks
	"claude-3-5-sonnet-20241022": [
		"claude-sonnet-4-20250514",
		"gpt-4o",
		"gemini-1.5-pro",
	],
	"claude-3-5-haiku-20241022": [
		"gpt-4o-mini",
		"gemini-1.5-flash",
		"claude-3-haiku-20240307",
	],

	// OpenAI fallbacks
	"gpt-4o": [
		"claude-sonnet-4-20250514",
		"gemini-1.5-pro",
		"gpt-4-turbo",
	],
	"gpt-4o-mini": [
		"claude-3-5-haiku-20241022",
		"gemini-1.5-flash",
		"gpt-3.5-turbo",
	],

	// Google fallbacks
	"gemini-1.5-pro": [
		"claude-sonnet-4-20250514",
		"gpt-4o",
		"gemini-2.0-flash",
	],
	"gemini-1.5-flash": [
		"gpt-4o-mini",
		"claude-3-5-haiku-20241022",
		"gemini-2.0-flash",
	],

	// Reasoning models
	"o1": [
		"claude-opus-4-5-20251101",
		"o1-preview",
		"deepseek-r1",
	],
	"deepseek-r1": [
		"o1",
		"claude-opus-4-5-20251101",
		"deepseek-reasoner",
	],
};

/**
 * Time to consider a model "healthy" again after failures (5 minutes)
 */
const HEALTH_RECOVERY_MS = 5 * 60 * 1000;

/**
 * Number of consecutive failures before skipping a model
 */
const FAILURE_THRESHOLD = 3;

/**
 * Model fallback chain manager
 */
class ModelFallbackChain {
	private chains = new Map<string, string[]>();
	private health = new Map<string, ModelHealth>();
	private currentAttempts = new Map<string, number>();
	private enabled = true;

	constructor() {
		// Initialize with default chains
		for (const [model, chain] of Object.entries(DEFAULT_CHAINS)) {
			this.chains.set(model, chain);
		}
	}

	/**
	 * Enable or disable fallback chains
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		logger.info(`Fallback chains ${enabled ? "enabled" : "disabled"}`);
	}

	/**
	 * Set custom fallback chain for a model
	 */
	setChain(model: string, fallbacks: string[]): void {
		this.chains.set(model, fallbacks);
		logger.info("Fallback chain configured", { model, fallbacks });
	}

	/**
	 * Get fallback chain for a model
	 */
	getChain(model: string): string[] {
		return this.chains.get(model) || [];
	}

	/**
	 * Initialize health tracking for a model
	 */
	private getHealth(model: string): ModelHealth {
		let health = this.health.get(model);
		if (!health) {
			health = {
				failures: 0,
				lastFailure: null,
				lastSuccess: null,
				lastFailureType: null,
				consecutiveFailures: 0,
			};
			this.health.set(model, health);
		}
		return health;
	}

	/**
	 * Check if a model is currently healthy
	 */
	isHealthy(model: string): boolean {
		const health = this.getHealth(model);

		// Model has no failures
		if (health.consecutiveFailures === 0) {
			return true;
		}

		// Model has recovered
		if (
			health.lastFailure &&
			Date.now() - health.lastFailure > HEALTH_RECOVERY_MS
		) {
			return true;
		}

		// Too many consecutive failures
		if (health.consecutiveFailures >= FAILURE_THRESHOLD) {
			return false;
		}

		return true;
	}

	/**
	 * Report a successful call to a model
	 */
	reportSuccess(model: string): void {
		const health = this.getHealth(model);
		health.lastSuccess = Date.now();
		health.consecutiveFailures = 0;

		// Reset attempt counter on success
		this.currentAttempts.delete(model);

		logger.debug("Model success reported", { model });
	}

	/**
	 * Report a failure for a model
	 */
	reportFailure(model: string, failureType: FailureType): void {
		const health = this.getHealth(model);
		health.failures++;
		health.lastFailure = Date.now();
		health.lastFailureType = failureType;
		health.consecutiveFailures++;

		logger.warn("Model failure reported", {
			model,
			failureType,
			consecutiveFailures: health.consecutiveFailures,
			totalFailures: health.failures,
		});
	}

	/**
	 * Get the next model to try, considering health status
	 * Returns null if no healthy models available
	 */
	getNextModel(primaryModel: string): string | null {
		if (!this.enabled) {
			return primaryModel;
		}

		// Track attempt number
		const attempt = (this.currentAttempts.get(primaryModel) || 0);
		this.currentAttempts.set(primaryModel, attempt + 1);

		// First attempt - try primary if healthy
		if (attempt === 0 && this.isHealthy(primaryModel)) {
			return primaryModel;
		}

		// Get fallback chain
		const chain = this.getChain(primaryModel);
		if (chain.length === 0) {
			// No fallbacks configured, return primary anyway
			return primaryModel;
		}

		// Find first healthy fallback
		const fallbackIndex = attempt - 1;
		for (let i = fallbackIndex; i < chain.length; i++) {
			const fallback = chain[i];
			if (fallback && this.isHealthy(fallback)) {
				logger.info("Using fallback model", {
					primary: primaryModel,
					fallback,
					attempt: attempt + 1,
				});
				return fallback;
			}
		}

		// No healthy models found - return primary as last resort
		logger.warn("No healthy fallback models available", {
			primaryModel,
			chainLength: chain.length,
		});
		return primaryModel;
	}

	/**
	 * Reset attempt counter for a primary model
	 */
	resetAttempts(model: string): void {
		this.currentAttempts.delete(model);
	}

	/**
	 * Get health status for all tracked models
	 */
	getHealthStatus(): Record<string, { healthy: boolean; consecutiveFailures: number; lastFailureType: FailureType | null }> {
		const status: Record<string, { healthy: boolean; consecutiveFailures: number; lastFailureType: FailureType | null }> = {};

		for (const [model, health] of this.health.entries()) {
			status[model] = {
				healthy: this.isHealthy(model),
				consecutiveFailures: health.consecutiveFailures,
				lastFailureType: health.lastFailureType,
			};
		}

		return status;
	}

	/**
	 * Reset health status for a model
	 */
	resetHealth(model: string): void {
		this.health.delete(model);
		logger.info("Health status reset", { model });
	}

	/**
	 * Reset all health tracking
	 */
	resetAll(): void {
		this.health.clear();
		this.currentAttempts.clear();
		logger.info("All fallback chain state reset");
	}
}

/**
 * Global fallback chain instance
 */
export const modelFallbackChain = new ModelFallbackChain();

/**
 * Wrapper to execute with automatic fallback
 */
export async function withFallback<T>(
	primaryModel: string,
	execute: (model: string) => Promise<T>,
	maxAttempts = 3,
): Promise<T> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const model = modelFallbackChain.getNextModel(primaryModel);
		if (!model) {
			throw lastError || new Error("No models available");
		}

		try {
			const result = await execute(model);
			modelFallbackChain.reportSuccess(model);
			modelFallbackChain.resetAttempts(primaryModel);
			return result;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Determine failure type
			const failureType = categorizeError(lastError);
			modelFallbackChain.reportFailure(model, failureType);

			logger.warn("Model execution failed, trying fallback", {
				model,
				attempt: attempt + 1,
				maxAttempts,
				failureType,
			});
		}
	}

	modelFallbackChain.resetAttempts(primaryModel);
	throw lastError || new Error("All fallback attempts failed");
}

/**
 * Categorize an error into a failure type
 */
function categorizeError(error: Error): FailureType {
	const message = error.message.toLowerCase();

	if (message.includes("rate limit") || message.includes("429")) {
		return "rate_limit";
	}
	if (message.includes("timeout") || message.includes("timed out")) {
		return "timeout";
	}
	if (message.includes("500") || message.includes("502") || message.includes("503")) {
		return "server_error";
	}
	if (message.includes("401") || message.includes("403") || message.includes("auth")) {
		return "auth_error";
	}
	if (message.includes("capacity") || message.includes("overloaded")) {
		return "capacity";
	}
	if (message.includes("network") || message.includes("connect")) {
		return "network";
	}

	return "unknown";
}
