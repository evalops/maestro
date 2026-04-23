import {
	CircuitBreaker,
	type CircuitBreakerConfig,
} from "../safety/circuit-breaker.js";
import { createLogger } from "./logger.js";

const logger = createLogger("runtime:downstream");

export const FailClosed = "fail-closed";
export const FailOpen = "fail-open";

export type DownstreamFailureMode = typeof FailClosed | typeof FailOpen;

export interface DownstreamConfig {
	failureMode: DownstreamFailureMode;
	breaker?: CircuitBreaker | Partial<CircuitBreakerConfig> | false;
}

export class DownstreamClient {
	readonly name: string;
	readonly failureMode: DownstreamFailureMode;
	private readonly breaker?: CircuitBreaker;

	constructor(name: string, config: DownstreamConfig) {
		this.name = name;
		this.failureMode = config.failureMode;
		if (config.breaker === false || config.breaker === undefined) {
			this.breaker = undefined;
		} else if (config.breaker instanceof CircuitBreaker) {
			this.breaker = config.breaker;
		} else {
			this.breaker = new CircuitBreaker({
				...config.breaker,
				toolName: config.breaker.toolName ?? name,
			});
		}
	}

	async callOp<T>(
		op: string,
		fn: () => Promise<T>,
		failOpenValue: () => T,
	): Promise<T> {
		try {
			return this.breaker ? await this.breaker.execute(fn) : await fn();
		} catch (error) {
			if (this.failureMode === FailOpen) {
				logger.warn("Downstream call failed (fail-open)", {
					downstream: this.name,
					op,
					error: error instanceof Error ? error.message : String(error),
				});
				return failOpenValue();
			}
			logger.error(
				"Downstream call failed (fail-closed)",
				error instanceof Error ? error : new Error(String(error)),
				{ downstream: this.name, op },
			);
			throw error;
		}
	}
}

export function New(name: string, config: DownstreamConfig): DownstreamClient {
	return new DownstreamClient(name, config);
}

export function CallOp<T>(
	client: DownstreamClient,
	op: string,
	fn: () => Promise<T>,
	failOpenValue: () => T,
): Promise<T> {
	return client.callOp(op, fn, failOpenValue);
}
