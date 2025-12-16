/**
 * Health Check Utilities - Kubernetes-compatible health probes
 *
 * Provides readiness and liveness probes for containerized deployments.
 * Supports component-based health checks with configurable timeouts.
 *
 * @example
 * ```typescript
 * const health = createHealthChecker();
 *
 * // Register components
 * health.register('slack', async () => {
 *   const test = await slackClient.auth.test();
 *   return test.ok;
 * });
 *
 * health.register('redis', async () => {
 *   await redis.ping();
 *   return true;
 * });
 *
 * // Check health
 * const status = await health.check();
 * // { healthy: true, components: { slack: { healthy: true }, redis: { healthy: true } } }
 * ```
 */

import * as logger from "../logger.js";

export type HealthStatus = "healthy" | "unhealthy" | "degraded";

export interface ComponentHealth {
	healthy: boolean;
	status: HealthStatus;
	message?: string;
	lastCheck: number;
	latencyMs?: number;
}

export interface HealthCheckResult {
	healthy: boolean;
	status: HealthStatus;
	timestamp: number;
	components: Record<string, ComponentHealth>;
	version?: string;
}

export type HealthCheckFn = () => Promise<
	boolean | { healthy: boolean; message?: string }
>;

export interface HealthCheckerConfig {
	/** Default timeout for health checks (ms) (default: 5000) */
	timeoutMs?: number;
	/** Application version string */
	version?: string;
	/** Cache health results for this duration (ms) (default: 0 = no cache) */
	cacheTtlMs?: number;
}

export interface RegisteredCheck {
	name: string;
	check: HealthCheckFn;
	critical: boolean;
	timeoutMs: number;
}

/**
 * Health checker with component-based checks.
 */
export class HealthChecker {
	private checks: Map<string, RegisteredCheck> = new Map();
	private cachedResult: HealthCheckResult | null = null;
	private cacheTimestamp = 0;

	private readonly defaultTimeoutMs: number;
	private readonly version?: string;
	private readonly cacheTtlMs: number;

	constructor(config: HealthCheckerConfig = {}) {
		this.defaultTimeoutMs = config.timeoutMs ?? 5000;
		this.version = config.version;
		this.cacheTtlMs = config.cacheTtlMs ?? 0;
	}

	/**
	 * Register a health check.
	 *
	 * @param name Component name
	 * @param check Function that returns true if healthy
	 * @param options Additional options
	 */
	register(
		name: string,
		check: HealthCheckFn,
		options?: { critical?: boolean; timeoutMs?: number },
	): void {
		this.checks.set(name, {
			name,
			check,
			critical: options?.critical ?? true,
			timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
		});
	}

	/**
	 * Unregister a health check.
	 */
	unregister(name: string): boolean {
		return this.checks.delete(name);
	}

	/**
	 * Run all health checks.
	 */
	async check(): Promise<HealthCheckResult> {
		// Return cached result if valid
		if (this.cachedResult && this.cacheTtlMs > 0) {
			if (Date.now() - this.cacheTimestamp < this.cacheTtlMs) {
				return this.cachedResult;
			}
		}

		const components: Record<string, ComponentHealth> = {};
		const startTime = Date.now();

		// Run all checks in parallel
		const checkPromises = Array.from(this.checks.values()).map(
			async (registered) => {
				const result = await this.runCheck(registered);
				components[registered.name] = result;
			},
		);

		await Promise.all(checkPromises);

		// Determine overall status
		const criticalComponents = Array.from(this.checks.values())
			.filter((c) => c.critical)
			.map((c) => c.name);

		const hasUnhealthyCritical = criticalComponents.some(
			(name) => !components[name]?.healthy,
		);

		const hasUnhealthyNonCritical = Object.entries(components)
			.filter(([name]) => !criticalComponents.includes(name))
			.some(([, health]) => !health.healthy);

		let status: HealthStatus;
		if (hasUnhealthyCritical) {
			status = "unhealthy";
		} else if (hasUnhealthyNonCritical) {
			status = "degraded";
		} else {
			status = "healthy";
		}

		const result: HealthCheckResult = {
			healthy: !hasUnhealthyCritical,
			status,
			timestamp: startTime,
			components,
			version: this.version,
		};

		// Cache result
		this.cachedResult = result;
		this.cacheTimestamp = Date.now();

		return result;
	}

	/**
	 * Run a single health check with timeout.
	 */
	private async runCheck(
		registered: RegisteredCheck,
	): Promise<ComponentHealth> {
		const startTime = Date.now();

		try {
			const result = await Promise.race([
				registered.check(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									`Health check timeout after ${registered.timeoutMs}ms`,
								),
							),
						registered.timeoutMs,
					),
				),
			]);

			const latencyMs = Date.now() - startTime;
			const healthy = typeof result === "boolean" ? result : result.healthy;
			const message = typeof result === "object" ? result.message : undefined;

			return {
				healthy,
				status: healthy ? "healthy" : "unhealthy",
				message,
				lastCheck: startTime,
				latencyMs,
			};
		} catch (error) {
			const latencyMs = Date.now() - startTime;
			const message = error instanceof Error ? error.message : String(error);

			logger.logDebug(`Health check failed: ${registered.name}`, message);

			return {
				healthy: false,
				status: "unhealthy",
				message,
				lastCheck: startTime,
				latencyMs,
			};
		}
	}

	/**
	 * Quick readiness check (for Kubernetes readiness probes).
	 * Returns true if all critical components are healthy.
	 */
	async isReady(): Promise<boolean> {
		const result = await this.check();
		return result.healthy;
	}

	/**
	 * Quick liveness check (for Kubernetes liveness probes).
	 * Returns true if the process is running. Override for custom logic.
	 */
	isAlive(): boolean {
		return true;
	}

	/**
	 * Get registered component names.
	 */
	getComponentNames(): string[] {
		return Array.from(this.checks.keys());
	}

	/**
	 * Clear cached results.
	 */
	clearCache(): void {
		this.cachedResult = null;
		this.cacheTimestamp = 0;
	}

	/**
	 * Reset all checks.
	 */
	reset(): void {
		this.checks.clear();
		this.clearCache();
	}
}

/**
 * Create a new health checker instance.
 */
export function createHealthChecker(
	config?: HealthCheckerConfig,
): HealthChecker {
	return new HealthChecker(config);
}

/**
 * Create HTTP handlers for health endpoints.
 * Returns handlers compatible with Node's http.createServer or express.
 */
export function createHealthEndpoints(checker: HealthChecker): {
	handleLiveness: () => { status: number; body: string };
	handleReadiness: () => Promise<{ status: number; body: string }>;
	handleHealth: () => Promise<{ status: number; body: HealthCheckResult }>;
} {
	return {
		handleLiveness: () => {
			const alive = checker.isAlive();
			return {
				status: alive ? 200 : 503,
				body: alive ? "OK" : "Service Unavailable",
			};
		},

		handleReadiness: async () => {
			const ready = await checker.isReady();
			return {
				status: ready ? 200 : 503,
				body: ready ? "OK" : "Service Unavailable",
			};
		},

		handleHealth: async () => {
			const result = await checker.check();
			return {
				status: result.healthy ? 200 : 503,
				body: result,
			};
		},
	};
}

/**
 * Create standard health checks for common components.
 */
export const standardChecks = {
	/**
	 * Create a Slack connection health check.
	 */
	slack: (authTest: () => Promise<{ ok: boolean }>): HealthCheckFn => {
		return async () => {
			const result = await authTest();
			return result.ok;
		};
	},

	/**
	 * Create a Redis health check.
	 */
	redis: (ping: () => Promise<string>): HealthCheckFn => {
		return async () => {
			const pong = await ping();
			return pong === "PONG";
		};
	},

	/**
	 * Create a generic database health check.
	 */
	database: (query: () => Promise<unknown>): HealthCheckFn => {
		return async () => {
			await query();
			return true;
		};
	},

	/**
	 * Create a filesystem writability check.
	 */
	filesystem: (
		path: string,
		fs: {
			writeFile: (path: string, data: string) => Promise<void>;
			unlink: (path: string) => Promise<void>;
		},
	): HealthCheckFn => {
		return async () => {
			const testFile = `${path}/.health-check-${Date.now()}`;
			try {
				await fs.writeFile(testFile, "test");
				await fs.unlink(testFile);
				return true;
			} catch {
				return false;
			}
		};
	},

	/**
	 * Create a memory usage check.
	 */
	memory: (maxHeapUsedMB: number): HealthCheckFn => {
		return async () => {
			const usage = process.memoryUsage();
			const heapUsedMB = usage.heapUsed / 1024 / 1024;
			const healthy = heapUsedMB < maxHeapUsedMB;
			return {
				healthy,
				message: healthy
					? `Heap: ${heapUsedMB.toFixed(1)}MB`
					: `Heap usage too high: ${heapUsedMB.toFixed(1)}MB > ${maxHeapUsedMB}MB`,
			};
		};
	},
};
