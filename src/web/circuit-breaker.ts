import { EventEmitter } from "node:events";

export enum CircuitState {
	CLOSED = "CLOSED", // Normal operation
	OPEN = "OPEN", // Failing, fast rejection
	HALF_OPEN = "HALF_OPEN", // Testing recovery
}

export interface CircuitBreakerOptions {
	failureThreshold: number; // Number of failures before opening
	resetTimeoutMs: number; // Time to wait before trying again (Half-Open)
	halfOpenMaxAttempts: number; // Number of successes needed to close
}

export class CircuitBreaker extends EventEmitter {
	private state: CircuitState = CircuitState.CLOSED;
	private failures = 0;
	private successes = 0;
	private lastFailureTime = 0;
	private nextAttemptTime = 0;
	private options: CircuitBreakerOptions;

	constructor(
		private name: string,
		options: CircuitBreakerOptions = {
			failureThreshold: 5,
			resetTimeoutMs: 30000,
			halfOpenMaxAttempts: 2,
		},
	) {
		super();
		this.options = this.normalizeOptions(options);
	}

	updateOptions(options: CircuitBreakerOptions) {
		this.options = this.normalizeOptions({ ...this.options, ...options });
		// If currently open, realign the next attempt window with updated timeout.
		if (this.state === CircuitState.OPEN) {
			this.nextAttemptTime = this.lastFailureTime + this.options.resetTimeoutMs;
		}
	}

	getState(): CircuitState {
		// Auto-transition to HALF_OPEN if timeout passed
		if (
			this.state === CircuitState.OPEN &&
			Date.now() >= this.nextAttemptTime
		) {
			this.transition(CircuitState.HALF_OPEN);
		}
		return this.state;
	}

	async execute<T>(action: () => Promise<T>): Promise<T> {
		const state = this.getState();

		if (state === CircuitState.OPEN) {
			const waitMs = Math.max(0, this.nextAttemptTime - Date.now());
			throw new Error(
				`CircuitBreaker '${this.name}' is OPEN. Retry in ${Math.ceil(waitMs / 1000)}s.`,
			);
		}

		try {
			const result = await action();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure(error);
			throw error;
		}
	}

	private onSuccess() {
		if (this.state === CircuitState.HALF_OPEN) {
			this.successes++;
			if (this.successes >= this.options.halfOpenMaxAttempts) {
				this.transition(CircuitState.CLOSED);
			}
		} else if (this.state === CircuitState.CLOSED) {
			this.failures = 0;
		}
	}

	private onFailure(error: unknown) {
		this.lastFailureTime = Date.now();
		this.failures++;

		if (this.state === CircuitState.CLOSED) {
			if (this.failures >= this.options.failureThreshold) {
				this.transition(CircuitState.OPEN);
			}
		} else if (this.state === CircuitState.HALF_OPEN) {
			// If we fail in half-open, go back to open immediately
			this.transition(CircuitState.OPEN);
		}
	}

	private transition(newState: CircuitState) {
		if (this.state === newState) return;

		const oldState = this.state;
		this.state = newState;

		if (newState === CircuitState.OPEN) {
			this.nextAttemptTime = Date.now() + this.options.resetTimeoutMs;
			this.emit("open", {
				name: this.name,
				failures: this.failures,
				nextAttempt: this.nextAttemptTime,
			});
		} else if (newState === CircuitState.CLOSED) {
			this.failures = 0;
			this.successes = 0;
			this.emit("close", { name: this.name });
		} else if (newState === CircuitState.HALF_OPEN) {
			this.successes = 0;
			this.emit("half_open", { name: this.name });
		}

		console.log(
			`[CircuitBreaker:${this.name}] Transition: ${oldState} -> ${newState}`,
		);
	}

	private normalizeOptions(
		options: CircuitBreakerOptions,
	): CircuitBreakerOptions {
		return {
			failureThreshold: Math.max(1, Math.trunc(options.failureThreshold)),
			resetTimeoutMs: Math.max(1, Math.trunc(options.resetTimeoutMs)),
			halfOpenMaxAttempts: Math.max(1, Math.trunc(options.halfOpenMaxAttempts)),
		};
	}
}

export const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(
	name: string,
	options?: CircuitBreakerOptions,
): CircuitBreaker {
	if (!circuitBreakers.has(name)) {
		circuitBreakers.set(name, new CircuitBreaker(name, options));
	} else if (options) {
		circuitBreakers.get(name)?.updateOptions(options);
	}
	// biome-ignore lint/style/noNonNullAssertion: we just set it
	return circuitBreakers.get(name)!;
}

const AGENT_BREAKER_OPTIONS: CircuitBreakerOptions = {
	failureThreshold: 5,
	resetTimeoutMs: 30000,
	halfOpenMaxAttempts: 1,
};

const agentBreakerCache = new Map<string, CircuitBreaker>();

export function getAgentCircuitBreaker(provider: string): CircuitBreaker {
	if (!agentBreakerCache.has(provider)) {
		const breaker = getCircuitBreaker(
			`agent-prompt-${provider}`,
			AGENT_BREAKER_OPTIONS,
		);
		agentBreakerCache.set(provider, breaker);
	}
	return agentBreakerCache.get(provider) as CircuitBreaker;
}
