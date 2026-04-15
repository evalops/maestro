/**
 * Metrics Utilities - Lightweight observability for API calls
 *
 * Provides simple metrics collection without external dependencies.
 * Supports histograms, counters, and gauges with tag-based filtering.
 *
 * @example
 * ```typescript
 * const metrics = createMetricsCollector();
 *
 * // Track API call latency
 * const timer = metrics.startTimer('slack_api_latency', { method: 'chat.postMessage' });
 * await slackClient.chat.postMessage(msg);
 * timer.end();
 *
 * // Count events
 * metrics.increment('messages_sent', { channel: 'general' });
 *
 * // Get summary
 * console.log(metrics.getSummary());
 * ```
 */

export type Tags = Record<string, string | number | boolean>;

export interface MetricEntry {
	name: string;
	value: number;
	timestamp: number;
	tags: Tags;
}

export interface Timer {
	end: () => number;
}

export interface HistogramSummary {
	count: number;
	sum: number;
	min: number;
	max: number;
	avg: number;
	p50: number;
	p90: number;
	p99: number;
}

export interface MetricSummary {
	counters: Record<string, number>;
	gauges: Record<string, number>;
	histograms: Record<string, HistogramSummary>;
}

export interface MetricsCollectorConfig {
	/** Max entries to keep per histogram (default: 1000) */
	maxHistogramEntries?: number;
	/** Enable detailed histogram percentiles (default: true) */
	enablePercentiles?: boolean;
	/** Prefix for all metric names */
	prefix?: string;
}

/**
 * Lightweight metrics collector for observability.
 */
export class MetricsCollector {
	private counters: Map<string, number> = new Map();
	private gauges: Map<string, number> = new Map();
	private histograms: Map<string, number[]> = new Map();

	private readonly maxHistogramEntries: number;
	private readonly enablePercentiles: boolean;
	private readonly prefix: string;

	constructor(config: MetricsCollectorConfig = {}) {
		this.maxHistogramEntries = config.maxHistogramEntries ?? 1000;
		this.enablePercentiles = config.enablePercentiles ?? true;
		this.prefix = config.prefix ?? "";
	}

	/**
	 * Build the full metric name with prefix and tags.
	 */
	private buildKey(name: string, tags?: Tags): string {
		const fullName = this.prefix ? `${this.prefix}_${name}` : name;
		if (!tags || Object.keys(tags).length === 0) {
			return fullName;
		}
		const tagStr = Object.entries(tags)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}=${v}`)
			.join(",");
		return `${fullName}{${tagStr}}`;
	}

	/**
	 * Increment a counter.
	 */
	increment(name: string, tags?: Tags, value = 1): void {
		const key = this.buildKey(name, tags);
		const current = this.counters.get(key) ?? 0;
		this.counters.set(key, current + value);
	}

	/**
	 * Decrement a counter.
	 */
	decrement(name: string, tags?: Tags, value = 1): void {
		this.increment(name, tags, -value);
	}

	/**
	 * Set a gauge value.
	 */
	gauge(name: string, value: number, tags?: Tags): void {
		const key = this.buildKey(name, tags);
		this.gauges.set(key, value);
	}

	/**
	 * Record a histogram value.
	 */
	histogram(name: string, value: number, tags?: Tags): void {
		const key = this.buildKey(name, tags);
		let values = this.histograms.get(key);
		if (!values) {
			values = [];
			this.histograms.set(key, values);
		}
		values.push(value);

		// Trim if too many entries
		if (values.length > this.maxHistogramEntries) {
			values.shift();
		}
	}

	/**
	 * Start a timer that records to a histogram.
	 */
	startTimer(name: string, tags?: Tags): Timer {
		const start = performance.now();
		return {
			end: () => {
				const duration = performance.now() - start;
				this.histogram(name, duration, tags);
				return duration;
			},
		};
	}

	/**
	 * Time an async function and record the duration.
	 */
	async time<T>(name: string, fn: () => Promise<T>, tags?: Tags): Promise<T> {
		const timer = this.startTimer(name, tags);
		try {
			return await fn();
		} finally {
			timer.end();
		}
	}

	/**
	 * Calculate histogram summary.
	 */
	private calculateHistogramSummary(values: number[]): HistogramSummary {
		if (values.length === 0) {
			return {
				count: 0,
				sum: 0,
				min: 0,
				max: 0,
				avg: 0,
				p50: 0,
				p90: 0,
				p99: 0,
			};
		}

		const sorted = [...values].sort((a, b) => a - b);
		const sum = sorted.reduce((a, b) => a + b, 0);
		const count = sorted.length;

		return {
			count,
			sum,
			min: sorted[0]!,
			max: sorted[count - 1]!,
			avg: sum / count,
			p50: this.enablePercentiles ? this.percentile(sorted, 50) : 0,
			p90: this.enablePercentiles ? this.percentile(sorted, 90) : 0,
			p99: this.enablePercentiles ? this.percentile(sorted, 99) : 0,
		};
	}

	/**
	 * Calculate percentile from sorted array.
	 */
	private percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
	}

	/**
	 * Get a counter value.
	 */
	getCounter(name: string, tags?: Tags): number {
		const key = this.buildKey(name, tags);
		return this.counters.get(key) ?? 0;
	}

	/**
	 * Get a gauge value.
	 */
	getGauge(name: string, tags?: Tags): number | undefined {
		const key = this.buildKey(name, tags);
		return this.gauges.get(key);
	}

	/**
	 * Get histogram summary.
	 */
	getHistogram(name: string, tags?: Tags): HistogramSummary | undefined {
		const key = this.buildKey(name, tags);
		const values = this.histograms.get(key);
		if (!values) return undefined;
		return this.calculateHistogramSummary(values);
	}

	/**
	 * Get all metrics summary.
	 */
	getSummary(): MetricSummary {
		const counters: Record<string, number> = {};
		const gauges: Record<string, number> = {};
		const histograms: Record<string, HistogramSummary> = {};

		for (const [key, value] of this.counters) {
			counters[key] = value;
		}

		for (const [key, value] of this.gauges) {
			gauges[key] = value;
		}

		for (const [key, values] of this.histograms) {
			histograms[key] = this.calculateHistogramSummary(values);
		}

		return { counters, gauges, histograms };
	}

	/**
	 * Export metrics in Prometheus format.
	 */
	toPrometheus(): string {
		const lines: string[] = [];

		// Counters
		for (const [key, value] of this.counters) {
			lines.push(`# TYPE ${key.split("{")[0]} counter`);
			lines.push(`${key} ${value}`);
		}

		// Gauges
		for (const [key, value] of this.gauges) {
			lines.push(`# TYPE ${key.split("{")[0]} gauge`);
			lines.push(`${key} ${value}`);
		}

		// Histograms
		for (const [key, values] of this.histograms) {
			const baseName = key.split("{")[0];
			const tagPart = key.includes("{") ? key.slice(key.indexOf("{")) : "";
			const summary = this.calculateHistogramSummary(values);

			lines.push(`# TYPE ${baseName} summary`);
			if (tagPart) {
				const innerTags = tagPart.slice(1, -1);
				lines.push(`${baseName}{${innerTags},quantile="0.5"} ${summary.p50}`);
				lines.push(`${baseName}{${innerTags},quantile="0.9"} ${summary.p90}`);
				lines.push(`${baseName}{${innerTags},quantile="0.99"} ${summary.p99}`);
				lines.push(`${baseName}_sum${tagPart} ${summary.sum}`);
				lines.push(`${baseName}_count${tagPart} ${summary.count}`);
			} else {
				lines.push(`${baseName}{quantile="0.5"} ${summary.p50}`);
				lines.push(`${baseName}{quantile="0.9"} ${summary.p90}`);
				lines.push(`${baseName}{quantile="0.99"} ${summary.p99}`);
				lines.push(`${baseName}_sum ${summary.sum}`);
				lines.push(`${baseName}_count ${summary.count}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Reset all metrics.
	 */
	reset(): void {
		this.counters.clear();
		this.gauges.clear();
		this.histograms.clear();
	}

	/**
	 * Reset a specific metric.
	 */
	resetMetric(name: string, tags?: Tags): void {
		const key = this.buildKey(name, tags);
		this.counters.delete(key);
		this.gauges.delete(key);
		this.histograms.delete(key);
	}
}

/**
 * Create a new metrics collector instance.
 */
export function createMetricsCollector(
	config?: MetricsCollectorConfig,
): MetricsCollector {
	return new MetricsCollector(config);
}

/**
 * Pre-configured metrics for Slack API operations.
 */
export function createSlackMetrics(prefix = "slack"): {
	collector: MetricsCollector;
	trackApiCall: <T>(method: string, fn: () => Promise<T>) => Promise<T>;
	trackError: (method: string, errorType: string) => void;
	trackRateLimit: (method: string) => void;
	trackMessageSent: (channel: string) => void;
} {
	const collector = createMetricsCollector({ prefix });

	return {
		collector,

		trackApiCall: async <T>(
			method: string,
			fn: () => Promise<T>,
		): Promise<T> => {
			collector.increment("api_calls_total", { method });
			const timer = collector.startTimer("api_latency_ms", { method });
			try {
				const result = await fn();
				collector.increment("api_success_total", { method });
				return result;
			} catch (error) {
				collector.increment("api_errors_total", { method });
				throw error;
			} finally {
				timer.end();
			}
		},

		trackError: (method: string, errorType: string): void => {
			collector.increment("errors_total", { method, error_type: errorType });
		},

		trackRateLimit: (method: string): void => {
			collector.increment("rate_limits_total", { method });
		},

		trackMessageSent: (channel: string): void => {
			collector.increment("messages_sent_total", { channel });
		},
	};
}

export type SlackMetrics = ReturnType<typeof createSlackMetrics>;
