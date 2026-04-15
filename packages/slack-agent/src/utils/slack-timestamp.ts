/**
 * Slack Timestamp Generator
 *
 * Generates unique, monotonically increasing Slack-style timestamps.
 * Timestamps are formatted as "{seconds}.{microseconds}" with microseconds
 * padded to 6 digits.
 *
 * Uses a counter to ensure uniqueness even when multiple timestamps are
 * generated within the same millisecond.
 */

export interface TimestampGenerator {
	/** Generate a unique Slack-style timestamp */
	generate(): string;
	/** Reset the generator state (useful for testing) */
	reset(): void;
}

/**
 * Create a Slack timestamp generator.
 *
 * The generator maintains internal state to ensure uniqueness even when
 * called multiple times within the same millisecond.
 *
 * @example
 * const generator = createTimestampGenerator();
 * const ts1 = generator.generate(); // "1703000000.000000"
 * const ts2 = generator.generate(); // "1703000000.000001"
 */
export function createTimestampGenerator(): TimestampGenerator {
	let lastTsMs = 0;
	let counter = 0;

	return {
		generate(): string {
			const now = Date.now();
			if (now === lastTsMs) {
				counter++;
			} else {
				lastTsMs = now;
				counter = 0;
			}
			const seconds = Math.floor(now / 1000);
			const micros = (now % 1000) * 1000 + counter;
			return `${seconds}.${micros.toString().padStart(6, "0")}`;
		},

		reset(): void {
			lastTsMs = 0;
			counter = 0;
		},
	};
}

/**
 * Parse a Slack timestamp into its components
 */
export function parseSlackTimestamp(ts: string): {
	seconds: number;
	micros: number;
	date: Date;
} {
	const [secondsStr, microsStr = "0"] = ts.split(".");
	const seconds = Number.parseInt(secondsStr!, 10);
	const micros = Number.parseInt(microsStr, 10);
	const date = new Date(seconds * 1000 + Math.floor(micros / 1000));
	return { seconds, micros, date };
}

/**
 * Compare two Slack timestamps
 * @returns negative if a < b, positive if a > b, 0 if equal
 */
export function compareSlackTimestamps(a: string, b: string): number {
	const parsedA = parseSlackTimestamp(a);
	const parsedB = parseSlackTimestamp(b);
	if (parsedA.seconds !== parsedB.seconds) {
		return parsedA.seconds - parsedB.seconds;
	}
	return parsedA.micros - parsedB.micros;
}
