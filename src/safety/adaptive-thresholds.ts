/**
 * Adaptive Thresholds - Dynamic threshold adjustment based on behavioral patterns
 *
 * Uses Exponentially Weighted Moving Average (EWMA) to track baseline behavior
 * and detect anomalies when current behavior deviates significantly from the norm.
 *
 * ## Key Concepts
 *
 * - **EWMA**: Gives more weight to recent observations while still considering history
 * - **Baseline**: Normal operating parameters for each metric
 * - **Anomaly Detection**: Alerts when values deviate 2+ standard deviations from baseline
 *
 * ## Usage
 *
 * ```typescript
 * const thresholds = new AdaptiveThresholds();
 *
 * // Record observations as they happen
 * thresholds.recordObservation("tool_calls_per_minute", 5);
 * thresholds.recordObservation("tool_calls_per_minute", 6);
 *
 * // Check if a value is anomalous
 * if (thresholds.isAnomaly("tool_calls_per_minute", 50)) {
 *   // Handle potential abuse
 * }
 *
 * // Get an adapted threshold
 * const threshold = thresholds.getAdaptedThreshold("failure_rate", 0.1);
 * ```
 *
 * @module safety/adaptive-thresholds
 */

import { createLogger } from "../utils/logger.js";
import { trackAdaptiveThresholdAnomaly } from "../telemetry/security-events.js";

const logger = createLogger("safety:adaptive-thresholds");

/**
 * Configuration for adaptive thresholds
 */
export interface AdaptiveThresholdsConfig {
	/** EWMA smoothing factor (0-1). Higher = more weight on recent values. Default: 0.3 */
	alpha: number;
	/** Number of standard deviations for anomaly detection. Default: 2.0 */
	anomalyThreshold: number;
	/** Minimum observations before anomaly detection activates. Default: 5 */
	minObservations: number;
	/** Maximum age of metric data in ms before decay. Default: 3600000 (1 hour) */
	maxAgeMs: number;
	/** Floor for standard deviation to prevent division issues. Default: 0.1 */
	stdDevFloor: number;
}

/**
 * Default configuration
 */
export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveThresholdsConfig = {
	alpha: 0.3,
	anomalyThreshold: 2.0,
	minObservations: 5,
	maxAgeMs: 3600000, // 1 hour
	stdDevFloor: 0.1,
};

/**
 * Internal state for tracking a metric
 */
interface MetricState {
	/** EWMA of the mean */
	mean: number;
	/** EWMA of variance (for computing std dev) */
	variance: number;
	/** Number of observations */
	count: number;
	/** Last observation timestamp */
	lastUpdate: number;
	/** Minimum observed value */
	min: number;
	/** Maximum observed value */
	max: number;
}

/**
 * Result of an anomaly check
 */
export interface AnomalyCheckResult {
	/** Whether this value is anomalous */
	isAnomaly: boolean;
	/** How many standard deviations from the mean */
	zScore: number;
	/** Current mean */
	mean: number;
	/** Current standard deviation */
	stdDev: number;
	/** Number of observations */
	observationCount: number;
	/** Reason if anomalous */
	reason?: string;
}

/**
 * Summary of a metric's current state
 */
export interface MetricSummary {
	mean: number;
	stdDev: number;
	min: number;
	max: number;
	count: number;
	lastUpdate: number;
	ageMs: number;
}

/**
 * Error thrown when adaptive thresholds config is invalid
 */
export class AdaptiveThresholdsConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdaptiveThresholdsConfigError";
	}
}

/** Minimum floor value to prevent division by zero */
const MIN_STD_DEV_FLOOR = 0.0001;

/**
 * Adaptive Thresholds
 *
 * Dynamically adjusts security thresholds based on observed behavior patterns.
 */
export class AdaptiveThresholds {
	private readonly config: AdaptiveThresholdsConfig;
	private metrics = new Map<string, MetricState>();

	constructor(config: Partial<AdaptiveThresholdsConfig> = {}) {
		this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
		this.validateConfig();
	}

	/**
	 * Validate configuration values
	 */
	private validateConfig(): void {
		if (this.config.alpha < 0 || this.config.alpha > 1) {
			throw new AdaptiveThresholdsConfigError(
				`alpha must be between 0 and 1, got ${this.config.alpha}`,
			);
		}
		if (this.config.anomalyThreshold <= 0) {
			throw new AdaptiveThresholdsConfigError(
				`anomalyThreshold must be > 0, got ${this.config.anomalyThreshold}`,
			);
		}
		if (this.config.minObservations < 1) {
			throw new AdaptiveThresholdsConfigError(
				`minObservations must be >= 1, got ${this.config.minObservations}`,
			);
		}
		if (this.config.maxAgeMs < 0) {
			throw new AdaptiveThresholdsConfigError(
				`maxAgeMs must be >= 0, got ${this.config.maxAgeMs}`,
			);
		}
		// Ensure stdDevFloor is always positive to prevent division by zero
		if (this.config.stdDevFloor < MIN_STD_DEV_FLOOR) {
			logger.warn("stdDevFloor too small, using minimum", {
				provided: this.config.stdDevFloor,
				minimum: MIN_STD_DEV_FLOOR,
			});
			this.config.stdDevFloor = MIN_STD_DEV_FLOOR;
		}
	}

	/**
	 * Record an observation for a metric
	 *
	 * Updates the EWMA mean and variance using Welford's online algorithm
	 * combined with exponential smoothing.
	 */
	recordObservation(metric: string, value: number): void {
		const now = Date.now();
		let state = this.metrics.get(metric);

		if (!state) {
			// Initialize new metric
			state = {
				mean: value,
				variance: 0,
				count: 1,
				lastUpdate: now,
				min: value,
				max: value,
			};
			this.metrics.set(metric, state);
			logger.debug("New metric initialized", { metric, value });
			return;
		}

		// Apply time decay if needed
		const age = now - state.lastUpdate;
		if (age > this.config.maxAgeMs) {
			// Reset if data is too old
			logger.debug("Metric reset due to age", { metric, ageMs: age });
			state = {
				mean: value,
				variance: 0,
				count: 1,
				lastUpdate: now,
				min: value,
				max: value,
			};
			this.metrics.set(metric, state);
			return;
		}

		// Update using EWMA
		const alpha = this.config.alpha;
		const oldMean = state.mean;
		const delta = value - oldMean;

		// Update mean with EWMA
		state.mean = oldMean + alpha * delta;

		// Update variance with EWMA (Welford's method adapted for EWMA)
		// Formula: variance = alpha * (value - oldMean) * (value - newMean) + (1 - alpha) * oldVariance
		// Note: Due to floating-point precision, variance can occasionally go slightly negative.
		// We clamp to 0 when computing stdDev to handle this edge case.
		const newVariance =
			(1 - alpha) * state.variance + alpha * delta * (value - state.mean);

		// Guard against NaN/Infinity from extreme values
		state.variance = Number.isFinite(newVariance) ? newVariance : state.variance;

		state.count++;
		state.lastUpdate = now;
		state.min = Math.min(state.min, value);
		state.max = Math.max(state.max, value);

		logger.debug("Metric updated", {
			metric,
			value,
			mean: state.mean,
			stdDev: Math.sqrt(Math.max(0, state.variance)),
			count: state.count,
		});
	}

	/**
	 * Check if a value is anomalous for a given metric
	 *
	 * Returns true if the value deviates more than `anomalyThreshold` standard
	 * deviations from the baseline mean.
	 */
	isAnomaly(metric: string, value: number): boolean {
		return this.checkAnomaly(metric, value).isAnomaly;
	}

	/**
	 * Check for anomaly with detailed results
	 */
	checkAnomaly(metric: string, value: number): AnomalyCheckResult {
		const state = this.metrics.get(metric);

		// No baseline yet - can't detect anomalies
		if (!state || state.count < this.config.minObservations) {
			return {
				isAnomaly: false,
				zScore: 0,
				mean: state?.mean ?? value,
				stdDev: 0,
				observationCount: state?.count ?? 0,
				reason: "Insufficient observations for anomaly detection",
			};
		}

		// Calculate standard deviation with floor
		const stdDev = Math.max(
			Math.sqrt(Math.max(0, state.variance)),
			this.config.stdDevFloor,
		);

		// Calculate z-score (number of std devs from mean)
		const zScore = Math.abs(value - state.mean) / stdDev;

		const isAnomaly = zScore > this.config.anomalyThreshold;

		if (isAnomaly) {
			const reason = `Value ${value} is ${zScore.toFixed(2)} standard deviations from mean ${state.mean.toFixed(2)} (threshold: ${this.config.anomalyThreshold})`;

			logger.warn("Anomaly detected", {
				metric,
				value,
				mean: state.mean,
				stdDev,
				zScore,
				threshold: this.config.anomalyThreshold,
			});

			trackAdaptiveThresholdAnomaly({
				metric,
				value,
				mean: state.mean,
				stdDev,
				zScore,
				threshold: this.config.anomalyThreshold,
			});

			return {
				isAnomaly: true,
				zScore,
				mean: state.mean,
				stdDev,
				observationCount: state.count,
				reason,
			};
		}

		return {
			isAnomaly: false,
			zScore,
			mean: state.mean,
			stdDev,
			observationCount: state.count,
		};
	}

	/**
	 * Get an adapted threshold based on observed behavior
	 *
	 * Returns a threshold that is `anomalyThreshold` standard deviations above
	 * the observed mean, or the default if insufficient data.
	 */
	getAdaptedThreshold(metric: string, defaultValue: number): number {
		const state = this.metrics.get(metric);

		// Use default if no baseline
		if (!state || state.count < this.config.minObservations) {
			return defaultValue;
		}

		const stdDev = Math.max(
			Math.sqrt(Math.max(0, state.variance)),
			this.config.stdDevFloor,
		);

		// Return mean + anomalyThreshold * stdDev
		const adaptedThreshold =
			state.mean + this.config.anomalyThreshold * stdDev;

		logger.debug("Adapted threshold calculated", {
			metric,
			defaultValue,
			adaptedThreshold,
			mean: state.mean,
			stdDev,
		});

		return adaptedThreshold;
	}

	/**
	 * Get summary statistics for a metric
	 */
	getMetricSummary(metric: string): MetricSummary | null {
		const state = this.metrics.get(metric);
		if (!state) return null;

		return {
			mean: state.mean,
			stdDev: Math.sqrt(Math.max(0, state.variance)),
			min: state.min,
			max: state.max,
			count: state.count,
			lastUpdate: state.lastUpdate,
			ageMs: Date.now() - state.lastUpdate,
		};
	}

	/**
	 * Get all tracked metrics
	 */
	getAllMetrics(): string[] {
		return Array.from(this.metrics.keys());
	}

	/**
	 * Get summary of all metrics
	 */
	getSummary(): Record<string, MetricSummary> {
		const summary: Record<string, MetricSummary> = {};

		for (const metric of this.metrics.keys()) {
			const ms = this.getMetricSummary(metric);
			if (ms) {
				summary[metric] = ms;
			}
		}

		return summary;
	}

	/**
	 * Reset a specific metric
	 */
	resetMetric(metric: string): void {
		this.metrics.delete(metric);
		logger.debug("Metric reset", { metric });
	}

	/**
	 * Clear all metrics
	 */
	clear(): void {
		this.metrics.clear();
		logger.debug("All metrics cleared");
	}

	/**
	 * Prune metrics that haven't been updated recently
	 */
	pruneStaleMetrics(): number {
		const now = Date.now();
		let pruned = 0;

		for (const [metric, state] of this.metrics) {
			if (now - state.lastUpdate > this.config.maxAgeMs) {
				this.metrics.delete(metric);
				pruned++;
			}
		}

		if (pruned > 0) {
			logger.debug("Stale metrics pruned", { count: pruned });
		}

		return pruned;
	}
}

/**
 * Predefined metric names for consistency
 */
export const METRICS = {
	/** Tool calls per minute */
	TOOL_CALLS_PER_MINUTE: "tool_calls_per_minute",
	/** Read operations per minute */
	READS_PER_MINUTE: "reads_per_minute",
	/** Write operations per minute */
	WRITES_PER_MINUTE: "writes_per_minute",
	/** Network egress operations per minute */
	EGRESS_PER_MINUTE: "egress_per_minute",
	/** Failure rate (0-1) */
	FAILURE_RATE: "failure_rate",
	/** Sensitive file accesses per session */
	SENSITIVE_ACCESSES: "sensitive_accesses",
	/** API calls per minute */
	API_CALLS_PER_MINUTE: "api_calls_per_minute",
	/** Average response time in ms */
	AVG_RESPONSE_TIME_MS: "avg_response_time_ms",
	/** Security findings per request */
	FINDINGS_PER_REQUEST: "findings_per_request",
} as const;

/**
 * Default global instance
 */
export const defaultAdaptiveThresholds = new AdaptiveThresholds();
