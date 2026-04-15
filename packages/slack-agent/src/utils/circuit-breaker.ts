/**
 * Circuit Breaker Pattern - Fault tolerance for external service calls
 *
 * Prevents cascading failures by failing fast when a service is unhealthy.
 * Automatically tests and recovers when the service becomes available again.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service failing, requests immediately rejected
 * - HALF_OPEN: Testing recovery, limited requests allowed
 *
 * @example
 * ```typescript
 * const breaker = createCircuitBreaker({
 *   failureThreshold: 5,
 *   resetTimeoutMs: 30000,
 * });
 *
 * try {
 *   const result = await breaker.execute(() => slackClient.postMessage(msg));
 * } catch (e) {
 *   if (e instanceof CircuitOpenError) {
 *     // Circuit is open, handle gracefully
 *   }
 * }
 * ```
 */

import * as logger from "../logger.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
	/** Name for logging purposes */
	name?: string;
	/** Number of failures before opening (default: 5) */
	failureThreshold?: number;
	/** Successes needed to close from half-open (default: 1) */
	successThreshold?: number;
	/** Time before testing recovery (ms) (default: 30000) */
	resetTimeoutMs?: number;
	/** Function to determine if error should trip the breaker (default: all errors) */
	shouldTrip?: (error: unknown) => boolean;
	/** Callback when state changes */
	onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
	state: CircuitState;
	failures: number;
	successes: number;
	totalCalls: number;
	totalFailures: number;
	totalSuccesses: number;
	lastFailureTime: number | null;
	lastSuccessTime: number | null;
}

/**
 * Error thrown when circuit is open.
 */
export class CircuitOpenError extends Error {
	override readonly name = "CircuitOpenError";
	readonly circuitName: string;
	readonly resetTimeoutMs: number;

	constructor(circuitName: string, resetTimeoutMs: number) {
		super(
			`Circuit "${circuitName}" is open. Will retry after ${resetTimeoutMs}ms`,
		);
		this.circuitName = circuitName;
		this.resetTimeoutMs = resetTimeoutMs;
	}
}

/**
 * Circuit breaker for fault-tolerant external calls.
 */
export class CircuitBreaker {
	private state: CircuitState = "CLOSED";
	private failures = 0;
	private successes = 0;
	private lastFailureTime: number | null = null;
	private lastSuccessTime: number | null = null;
	private openedAt: number | null = null;
	private totalCalls = 0;
	private totalFailures = 0;
	private totalSuccesses = 0;

	private readonly name: string;
	private readonly failureThreshold: number;
	private readonly successThreshold: number;
	private readonly resetTimeoutMs: number;
	private readonly shouldTrip: (error: unknown) => boolean;
	private readonly onStateChange?: (
		from: CircuitState,
		to: CircuitState,
	) => void;

	constructor(config: CircuitBreakerConfig = {}) {
		this.name = config.name ?? "default";
		this.failureThreshold = config.failureThreshold ?? 5;
		this.successThreshold = config.successThreshold ?? 1;
		this.resetTimeoutMs = config.resetTimeoutMs ?? 30000;
		this.shouldTrip = config.shouldTrip ?? (() => true);
		this.onStateChange = config.onStateChange;
	}

	/**
	 * Execute a function through the circuit breaker.
	 */
	async execute<T>(fn: () => Promise<T>): Promise<T> {
		this.totalCalls++;

		// Check if circuit should transition from OPEN to HALF_OPEN
		if (this.state === "OPEN") {
			if (this.shouldAttemptReset()) {
				this.transitionTo("HALF_OPEN");
			} else {
				throw new CircuitOpenError(this.name, this.resetTimeoutMs);
			}
		}

		try {
			const result = await fn();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure(error);
			throw error;
		}
	}

	/**
	 * Check if enough time has passed to attempt reset.
	 */
	private shouldAttemptReset(): boolean {
		if (this.openedAt === null) return false;
		return Date.now() - this.openedAt >= this.resetTimeoutMs;
	}

	/**
	 * Handle successful call.
	 */
	private onSuccess(): void {
		this.lastSuccessTime = Date.now();
		this.totalSuccesses++;

		if (this.state === "HALF_OPEN") {
			this.successes++;
			if (this.successes >= this.successThreshold) {
				this.transitionTo("CLOSED");
			}
		} else if (this.state === "CLOSED") {
			// Reset failure count on success in closed state
			this.failures = 0;
		}
	}

	/**
	 * Handle failed call.
	 */
	private onFailure(error: unknown): void {
		this.lastFailureTime = Date.now();
		this.totalFailures++;

		// Only trip on errors that should trip the breaker
		if (!this.shouldTrip(error)) {
			return;
		}

		if (this.state === "HALF_OPEN") {
			// Any failure in half-open immediately opens
			this.transitionTo("OPEN");
		} else if (this.state === "CLOSED") {
			this.failures++;
			if (this.failures >= this.failureThreshold) {
				this.transitionTo("OPEN");
			}
		}
	}

	/**
	 * Transition to a new state.
	 */
	private transitionTo(newState: CircuitState): void {
		const oldState = this.state;
		this.state = newState;

		logger.logDebug(`Circuit "${this.name}": ${oldState} -> ${newState}`);

		if (newState === "OPEN") {
			this.openedAt = Date.now();
			this.successes = 0;
			logger.logWarning(
				`Circuit "${this.name}" opened after ${this.failures} failures`,
			);
		} else if (newState === "CLOSED") {
			this.failures = 0;
			this.successes = 0;
			this.openedAt = null;
			logger.logInfo(`Circuit "${this.name}" closed, service recovered`);
		} else if (newState === "HALF_OPEN") {
			this.successes = 0;
			logger.logDebug(`Circuit "${this.name}" half-open, testing recovery`);
		}

		this.onStateChange?.(oldState, newState);
	}

	/**
	 * Get current circuit state.
	 */
	getState(): CircuitState {
		return this.state;
	}

	/**
	 * Get circuit statistics.
	 */
	getStats(): CircuitBreakerStats {
		return {
			state: this.state,
			failures: this.failures,
			successes: this.successes,
			totalCalls: this.totalCalls,
			totalFailures: this.totalFailures,
			totalSuccesses: this.totalSuccesses,
			lastFailureTime: this.lastFailureTime,
			lastSuccessTime: this.lastSuccessTime,
		};
	}

	/**
	 * Check if circuit is allowing requests.
	 */
	isAllowingRequests(): boolean {
		if (this.state === "CLOSED" || this.state === "HALF_OPEN") {
			return true;
		}
		// OPEN but might transition to HALF_OPEN
		return this.shouldAttemptReset();
	}

	/**
	 * Manually trip the circuit.
	 */
	trip(): void {
		if (this.state !== "OPEN") {
			this.transitionTo("OPEN");
		}
	}

	/**
	 * Manually reset the circuit.
	 */
	reset(): void {
		this.transitionTo("CLOSED");
	}

	/**
	 * Force to half-open state (for testing).
	 */
	halfOpen(): void {
		this.transitionTo("HALF_OPEN");
	}
}

/**
 * Create a new circuit breaker instance.
 */
export function createCircuitBreaker(
	config?: CircuitBreakerConfig,
): CircuitBreaker {
	return new CircuitBreaker(config);
}

/**
 * Create a circuit breaker configured for Slack API calls.
 *
 * Only trips on rate limits and server errors, not on validation errors.
 */
export function createSlackCircuitBreaker(
	name: string,
	config?: Partial<CircuitBreakerConfig>,
): CircuitBreaker {
	return new CircuitBreaker({
		name,
		failureThreshold: 5,
		successThreshold: 2,
		resetTimeoutMs: 30000,
		shouldTrip: (error: unknown) => {
			if (!(error instanceof Error)) return false;
			const message = error.message.toLowerCase();

			// Trip on rate limits
			if (message.includes("rate limit") || message.includes("429")) {
				return true;
			}

			// Trip on server errors
			if (
				message.includes("500") ||
				message.includes("502") ||
				message.includes("503") ||
				message.includes("504")
			) {
				return true;
			}

			// Trip on network errors
			if (
				message.includes("network") ||
				message.includes("econnreset") ||
				message.includes("timeout")
			) {
				return true;
			}

			// Don't trip on validation or auth errors
			return false;
		},
		...config,
	});
}
