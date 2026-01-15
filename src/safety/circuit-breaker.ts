/**
 * Circuit Breaker - Graceful degradation under repeated failures
 *
 * The circuit breaker pattern prevents cascading failures by:
 * 1. Tracking failures per tool/operation
 * 2. "Opening" the circuit when failures exceed threshold
 * 3. Rejecting calls while open (fail fast)
 * 4. Periodically testing if the service has recovered
 *
 * ## States
 *
 * ```
 * CLOSED ──(failure threshold)──> OPEN
 *    ↑                              │
 *    │                         (reset timeout)
 *    │                              │
 *    └──(success threshold)─── HALF-OPEN
 * ```
 *
 * - **CLOSED**: Normal operation, calls pass through
 * - **OPEN**: All calls rejected immediately
 * - **HALF-OPEN**: Allow test calls to check recovery
 *
 * ## Usage
 *
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 5 });
 *
 * try {
 *   const result = await breaker.execute(async () => {
 *     return await riskyOperation();
 *   });
 * } catch (e) {
 *   if (e instanceof CircuitOpenError) {
 *     // Circuit is open, fail fast
 *   }
 * }
 * ```
 *
 * @module safety/circuit-breaker
 */

import { createLogger } from "../utils/logger.js";
import { trackCircuitBreakerStateChange } from "../telemetry/security-events.js";

const logger = createLogger("safety:circuit-breaker");

/**
 * Circuit breaker states
 */
export type CircuitState = "closed" | "open" | "half-open";

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
	constructor(
		public readonly toolName: string,
		public readonly retryAfterMs: number,
	) {
		super(
			`Circuit breaker open for "${toolName}". Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
		);
		this.name = "CircuitOpenError";
	}
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
	/** Number of failures before opening circuit. Default: 5 */
	failureThreshold: number;
	/** Time to wait before transitioning from OPEN to HALF-OPEN (ms). Default: 30000 */
	resetTimeoutMs: number;
	/** Consecutive successes needed to close circuit from HALF-OPEN. Default: 2 */
	successThreshold: number;
	/** Optional tool name for logging/telemetry */
	toolName?: string;
}

/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 5,
	resetTimeoutMs: 30_000,
	successThreshold: 2,
};

/**
 * Internal state for a circuit
 */
interface CircuitInternalState {
	state: CircuitState;
	failures: number;
	successes: number;
	lastFailureTime: number | null;
	lastStateChange: number;
}

/**
 * Error thrown when circuit breaker config is invalid
 */
export class CircuitBreakerConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CircuitBreakerConfigError";
	}
}

/** Maximum safe time value to avoid Infinity arithmetic issues */
const MAX_TIME_VALUE = 999_999_999;

/**
 * Circuit Breaker
 *
 * Wraps operations with failure tracking and automatic circuit management.
 */
export class CircuitBreaker {
	private readonly config: CircuitBreakerConfig;
	private circuitState: CircuitInternalState;

	constructor(config: Partial<CircuitBreakerConfig> = {}) {
		this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
		this.validateConfig();
		this.circuitState = {
			state: "closed",
			failures: 0,
			successes: 0,
			lastFailureTime: null,
			lastStateChange: Date.now(),
		};
	}

	/**
	 * Validate configuration values
	 */
	private validateConfig(): void {
		if (this.config.failureThreshold < 1) {
			throw new CircuitBreakerConfigError(
				`failureThreshold must be >= 1, got ${this.config.failureThreshold}`,
			);
		}
		if (this.config.resetTimeoutMs < 0) {
			throw new CircuitBreakerConfigError(
				`resetTimeoutMs must be >= 0, got ${this.config.resetTimeoutMs}`,
			);
		}
		if (this.config.successThreshold < 1) {
			throw new CircuitBreakerConfigError(
				`successThreshold must be >= 1, got ${this.config.successThreshold}`,
			);
		}
		if (!Number.isFinite(this.config.failureThreshold)) {
			throw new CircuitBreakerConfigError(
				"failureThreshold must be a finite number",
			);
		}
		if (!Number.isFinite(this.config.resetTimeoutMs)) {
			throw new CircuitBreakerConfigError(
				"resetTimeoutMs must be a finite number",
			);
		}
		if (!Number.isFinite(this.config.successThreshold)) {
			throw new CircuitBreakerConfigError(
				"successThreshold must be a finite number",
			);
		}
	}

	/**
	 * Get current circuit state
	 */
	get state(): CircuitState {
		return this.circuitState.state;
	}

	/**
	 * Get current failure count
	 */
	get failures(): number {
		return this.circuitState.failures;
	}

	/**
	 * Check if the circuit should transition states based on timing
	 */
	private checkStateTransition(): void {
		const now = Date.now();
		const prevState = this.circuitState.state;

		if (this.circuitState.state === "open") {
			// Use MAX_TIME_VALUE instead of Infinity to avoid arithmetic issues
			const timeSinceLastFailure = this.circuitState.lastFailureTime
				? now - this.circuitState.lastFailureTime
				: MAX_TIME_VALUE;

			if (timeSinceLastFailure >= this.config.resetTimeoutMs) {
				this.circuitState.state = "half-open";
				this.circuitState.successes = 0;
				this.circuitState.lastStateChange = now;

				logger.info("Circuit breaker transitioning to half-open", {
					toolName: this.config.toolName,
					timeSinceLastFailure,
				});

				trackCircuitBreakerStateChange({
					fromState: prevState,
					toState: "half-open",
					toolName: this.config.toolName,
					failureCount: this.circuitState.failures,
					reason: "Reset timeout elapsed, testing recovery",
				});
			}
		}
	}

	/**
	 * Record a successful execution
	 */
	private recordSuccess(): void {
		const prevState = this.circuitState.state;

		if (this.circuitState.state === "half-open") {
			this.circuitState.successes++;

			if (this.circuitState.successes >= this.config.successThreshold) {
				this.circuitState.state = "closed";
				this.circuitState.failures = 0;
				this.circuitState.successes = 0;
				this.circuitState.lastStateChange = Date.now();

				logger.info("Circuit breaker closed after recovery", {
					toolName: this.config.toolName,
					successThreshold: this.config.successThreshold,
				});

				trackCircuitBreakerStateChange({
					fromState: prevState,
					toState: "closed",
					toolName: this.config.toolName,
					reason: "Successful recovery confirmed",
				});
			}
		} else if (this.circuitState.state === "closed") {
			// Reset failure count on success in closed state
			this.circuitState.failures = 0;
		}
	}

	/**
	 * Record a failed execution
	 */
	private recordFailure(): void {
		const now = Date.now();
		const prevState = this.circuitState.state;

		this.circuitState.failures++;
		this.circuitState.lastFailureTime = now;

		if (this.circuitState.state === "half-open") {
			// Any failure in half-open immediately opens the circuit
			this.circuitState.state = "open";
			this.circuitState.successes = 0;
			this.circuitState.lastStateChange = now;

			logger.warn("Circuit breaker reopened after half-open failure", {
				toolName: this.config.toolName,
			});

			trackCircuitBreakerStateChange({
				fromState: prevState,
				toState: "open",
				toolName: this.config.toolName,
				failureCount: this.circuitState.failures,
				reason: "Failure during half-open test",
			});
		} else if (
			this.circuitState.state === "closed" &&
			this.circuitState.failures >= this.config.failureThreshold
		) {
			this.circuitState.state = "open";
			this.circuitState.lastStateChange = now;

			logger.warn("Circuit breaker opened due to failure threshold", {
				toolName: this.config.toolName,
				failures: this.circuitState.failures,
				threshold: this.config.failureThreshold,
			});

			trackCircuitBreakerStateChange({
				fromState: prevState,
				toState: "open",
				toolName: this.config.toolName,
				failureCount: this.circuitState.failures,
				reason: `Failure threshold exceeded (${this.circuitState.failures}/${this.config.failureThreshold})`,
			});
		}
	}

	/**
	 * Execute an operation through the circuit breaker
	 *
	 * @param operation - The async operation to execute
	 * @returns The operation result
	 * @throws CircuitOpenError if circuit is open
	 * @throws The operation's error if it fails
	 */
	async execute<T>(operation: () => Promise<T>): Promise<T> {
		// Check for state transitions (OPEN -> HALF-OPEN after timeout)
		this.checkStateTransition();

		// If circuit is open, fail fast
		if (this.circuitState.state === "open") {
			const retryAfterMs = this.circuitState.lastFailureTime
				? this.config.resetTimeoutMs -
					(Date.now() - this.circuitState.lastFailureTime)
				: this.config.resetTimeoutMs;

			throw new CircuitOpenError(
				this.config.toolName ?? "unknown",
				Math.max(0, retryAfterMs),
			);
		}

		try {
			const result = await operation();
			this.recordSuccess();
			return result;
		} catch (error) {
			this.recordFailure();
			throw error;
		}
	}

	/**
	 * Get statistics about the circuit breaker
	 */
	getStats(): {
		state: CircuitState;
		failures: number;
		successes: number;
		lastFailureTime: number | null;
		lastStateChange: number;
		timeInCurrentState: number;
	} {
		return {
			...this.circuitState,
			timeInCurrentState: Date.now() - this.circuitState.lastStateChange,
		};
	}

	/**
	 * Manually reset the circuit breaker to closed state
	 */
	reset(): void {
		const prevState = this.circuitState.state;
		this.circuitState = {
			state: "closed",
			failures: 0,
			successes: 0,
			lastFailureTime: null,
			lastStateChange: Date.now(),
		};

		if (prevState !== "closed") {
			trackCircuitBreakerStateChange({
				fromState: prevState,
				toState: "closed",
				toolName: this.config.toolName,
				reason: "Manual reset",
			});
		}
	}

	/**
	 * Manually trip the circuit breaker to open state
	 * Useful for proactive protection when issues are detected
	 */
	trip(reason?: string): void {
		const prevState = this.circuitState.state;
		if (prevState === "open") return;

		this.circuitState.state = "open";
		this.circuitState.lastFailureTime = Date.now();
		this.circuitState.lastStateChange = Date.now();

		logger.warn("Circuit breaker manually tripped", {
			toolName: this.config.toolName,
			reason,
		});

		trackCircuitBreakerStateChange({
			fromState: prevState,
			toState: "open",
			toolName: this.config.toolName,
			failureCount: this.circuitState.failures,
			reason: reason ?? "Manual trip",
		});
	}
}

/**
 * Circuit breaker registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
	private breakers = new Map<string, CircuitBreaker>();
	private readonly defaultConfig: Partial<CircuitBreakerConfig>;

	constructor(defaultConfig: Partial<CircuitBreakerConfig> = {}) {
		this.defaultConfig = defaultConfig;
	}

	/**
	 * Get or create a circuit breaker for a given key
	 */
	getOrCreate(
		key: string,
		config?: Partial<CircuitBreakerConfig>,
	): CircuitBreaker {
		let breaker = this.breakers.get(key);
		if (!breaker) {
			breaker = new CircuitBreaker({
				...this.defaultConfig,
				...config,
				toolName: key,
			});
			this.breakers.set(key, breaker);
		}
		return breaker;
	}

	/**
	 * Get all circuit breakers
	 */
	getAll(): Map<string, CircuitBreaker> {
		return new Map(this.breakers);
	}

	/**
	 * Get summary of all circuit states
	 */
	getSummary(): Record<
		string,
		{ state: CircuitState; failures: number; timeInState: number }
	> {
		const summary: Record<
			string,
			{ state: CircuitState; failures: number; timeInState: number }
		> = {};

		for (const [key, breaker] of this.breakers) {
			const stats = breaker.getStats();
			summary[key] = {
				state: stats.state,
				failures: stats.failures,
				timeInState: stats.timeInCurrentState,
			};
		}

		return summary;
	}

	/**
	 * Reset all circuit breakers
	 */
	resetAll(): void {
		for (const breaker of this.breakers.values()) {
			breaker.reset();
		}
	}

	/**
	 * Clear all circuit breakers
	 */
	clear(): void {
		this.breakers.clear();
	}
}

/**
 * Default global registry instance
 */
export const defaultCircuitBreakerRegistry = new CircuitBreakerRegistry();
