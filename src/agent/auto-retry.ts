/**
 * Auto-Retry Controller
 *
 * Handles automatic retry of transient provider errors (overloaded, rate limit, 5xx).
 * Uses exponential backoff with configurable settings.
 *
 * ## Retry Flow
 *
 * 1. On agent_end, check if the last assistant message is a retryable error
 * 2. If retryable, emit auto_retry_start event and wait with exponential backoff
 * 3. After delay, call agent.continue() to retry
 * 4. On success, emit auto_retry_end with success=true
 * 5. On max retries exceeded, emit auto_retry_end with success=false
 *
 * ## Events
 *
 * - `auto_retry_start`: Emitted when retry is about to begin
 * - `auto_retry_end`: Emitted when retry succeeds or all retries exhausted
 */

import type { RetryConfig } from "../config/toml-config.js";
import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import { isRetryableError } from "./context-overflow.js";
import type { AgentEvent, AssistantMessage } from "./types.js";

const logger = createLogger("auto-retry");

export interface AutoRetryConfig {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

function extractRetryDelayMs(errorMessage?: string): number | undefined {
	if (!errorMessage) return undefined;

	// Pattern 1: "Your quota will reset after 18h31m10s" / "10m15s" / "39s"
	const resetMatch = errorMessage.match(
		/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i,
	);
	if (resetMatch?.[3]) {
		const hours = resetMatch[1] ? Number.parseInt(resetMatch[1], 10) : 0;
		const minutes = resetMatch[2] ? Number.parseInt(resetMatch[2], 10) : 0;
		const seconds = Number.parseFloat(resetMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			if (totalMs > 0) {
				return Math.ceil(totalMs + 1000);
			}
		}
	}

	// Pattern 2: "Please retry in X[ms|s]"
	const retryInMatch = errorMessage.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1] && retryInMatch[2]) {
		const value = Number.parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	// Pattern 3: "retryDelay": "34.074824224s"
	const retryDelayMatch = errorMessage.match(
		/"retryDelay":\s*"([0-9.]+)(ms|s)"/i,
	);
	if (retryDelayMatch?.[1] && retryDelayMatch[2]) {
		const value = Number.parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms =
				retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	return undefined;
}

export type AutoRetryEventListener = (event: AgentEvent) => void;

/**
 * Controller for automatic retry of transient errors.
 */
export class AutoRetryController {
	private config: AutoRetryConfig;
	private retryAttempt = 0;
	private retryAbortController: AbortController | null = null;
	private retryPromise: Promise<void> | null = null;
	private retryResolve: (() => void) | null = null;
	private eventListener: AutoRetryEventListener | null = null;
	private lastAssistantMessage: AssistantMessage | null = null;

	constructor(config?: Partial<AutoRetryConfig>) {
		this.config = {
			enabled: config?.enabled ?? true,
			maxRetries: config?.maxRetries ?? 3,
			baseDelayMs: config?.baseDelayMs ?? 2000,
		};
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<AutoRetryConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Load configuration from RetryConfig.
	 */
	loadFromRetryConfig(retryConfig?: RetryConfig): void {
		if (retryConfig) {
			this.config = {
				enabled: retryConfig.enabled ?? true,
				maxRetries: retryConfig.max_retries ?? 3,
				baseDelayMs: retryConfig.base_delay_ms ?? 2000,
			};
		}
	}

	/**
	 * Set the event listener for retry events.
	 */
	setEventListener(listener: AutoRetryEventListener): void {
		this.eventListener = listener;
	}

	/**
	 * Check if auto-retry is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Check if a retry is currently in progress.
	 */
	isRetrying(): boolean {
		return this.retryAttempt > 0;
	}

	/**
	 * Get current retry attempt (0 if not retrying).
	 */
	getCurrentAttempt(): number {
		return this.retryAttempt;
	}

	/**
	 * Track the last assistant message for retry checking.
	 * Call this on message_end events for assistant messages.
	 */
	trackAssistantMessage(message: AssistantMessage): void {
		this.lastAssistantMessage = message;
	}

	/**
	 * Check if the last assistant message was a retryable error and handle it.
	 * Call this on agent_end events.
	 *
	 * @param agent - The agent instance for retrying
	 * @param contextWindow - Model's context window for overflow detection
	 * @returns true if retry was initiated, false otherwise
	 */
	async checkAndRetry(agent: Agent, contextWindow?: number): Promise<boolean> {
		if (!this.lastAssistantMessage) {
			return false;
		}

		const message = this.lastAssistantMessage;
		this.lastAssistantMessage = null;

		// Check if error is retryable
		if (!this.isRetryableErrorMessage(message, contextWindow)) {
			// If we were retrying and this succeeded, emit success
			if (this.retryAttempt > 0) {
				this.emitEvent({
					type: "auto_retry_end",
					success: true,
					attempt: this.retryAttempt,
				});
				this.retryAttempt = 0;
				this.resolveRetryPromise();
			}
			return false;
		}

		// Handle the retryable error
		return this.handleRetryableError(message, agent);
	}

	/**
	 * Check if a message is a retryable error.
	 */
	private isRetryableErrorMessage(
		message: AssistantMessage,
		contextWindow?: number,
	): boolean {
		return isRetryableError(message, contextWindow);
	}

	/**
	 * Handle a retryable error with exponential backoff.
	 */
	private async handleRetryableError(
		message: AssistantMessage,
		agent: Agent,
	): Promise<boolean> {
		if (!this.config.enabled) {
			return false;
		}

		this.retryAttempt++;

		// Create retry promise on first attempt
		if (this.retryAttempt === 1 && !this.retryPromise) {
			this.retryPromise = new Promise((resolve) => {
				this.retryResolve = resolve;
			});
		}

		// Check if max retries exceeded
		if (this.retryAttempt > this.config.maxRetries) {
			this.emitEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this.retryAttempt = 0;
			this.resolveRetryPromise();
			return false;
		}

		// Calculate delay with exponential backoff, honoring server-provided retry windows.
		const backoffMs = this.config.baseDelayMs * 2 ** (this.retryAttempt - 1);
		const serverDelayMs = extractRetryDelayMs(message.errorMessage);
		const delayMs = serverDelayMs
			? Math.max(serverDelayMs, backoffMs)
			: backoffMs;

		logger.info("Auto-retry starting", {
			attempt: this.retryAttempt,
			maxAttempts: this.config.maxRetries,
			delayMs,
			serverDelayMs,
			errorMessage: message.errorMessage,
		});

		this.emitEvent({
			type: "auto_retry_start",
			attempt: this.retryAttempt,
			maxAttempts: this.config.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state
		const messages = agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		if (lastMessage && lastMessage.role === "assistant") {
			agent.replaceMessages(messages.slice(0, -1));
		}

		// Wait with exponential backoff (abortable)
		this.retryAbortController = new AbortController();
		try {
			await this.sleep(delayMs, this.retryAbortController.signal);
		} catch {
			// Aborted during sleep
			const attempt = this.retryAttempt;
			this.retryAttempt = 0;
			this.retryAbortController = null;
			this.emitEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.resolveRetryPromise();
			return false;
		}
		this.retryAbortController = null;

		// Retry via continue() - use setTimeout to break out of event handler chain
		setTimeout(() => {
			agent.continue().catch((error: unknown) => {
				logger.warn("Retry continue() failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, 0);

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.retryAbortController?.abort();
	}

	/**
	 * Wait for current retry sequence to complete.
	 */
	async waitForRetry(): Promise<void> {
		if (this.retryPromise) {
			await this.retryPromise;
		}
	}

	/**
	 * Reset retry state.
	 */
	reset(): void {
		this.retryAttempt = 0;
		this.lastAssistantMessage = null;
		this.abortRetry();
		this.resolveRetryPromise();
	}

	private emitEvent(event: AgentEvent): void {
		this.eventListener?.(event);
	}

	private resolveRetryPromise(): void {
		if (this.retryResolve) {
			this.retryResolve();
			this.retryResolve = null;
			this.retryPromise = null;
		}
	}

	private sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			const timeout = setTimeout(resolve, ms);

			signal?.addEventListener("abort", () => {
				clearTimeout(timeout);
				reject(new Error("Aborted"));
			});
		});
	}
}

/**
 * Create an auto-retry controller with optional configuration.
 */
export function createAutoRetryController(
	config?: Partial<AutoRetryConfig>,
): AutoRetryController {
	return new AutoRetryController(config);
}
