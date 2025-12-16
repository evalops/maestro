import { describe, expect, it } from "vitest";
import {
	compareSlackTimestamps,
	createTimestampGenerator,
	parseSlackTimestamp,
} from "../src/utils/slack-timestamp.js";

describe("createTimestampGenerator", () => {
	it("generates valid Slack timestamp format", () => {
		const generator = createTimestampGenerator();
		const ts = generator.generate();

		expect(ts).toMatch(/^\d+\.\d{6}$/);
	});

	it("generates monotonically increasing timestamps", () => {
		const generator = createTimestampGenerator();
		const timestamps: string[] = [];

		for (let i = 0; i < 100; i++) {
			timestamps.push(generator.generate());
		}

		// Verify each timestamp is greater than or equal to the previous
		for (let i = 1; i < timestamps.length; i++) {
			const cmp = compareSlackTimestamps(timestamps[i - 1], timestamps[i]);
			expect(cmp).toBeLessThanOrEqual(0);
		}
	});

	it("generates unique timestamps even within same millisecond", () => {
		const generator = createTimestampGenerator();
		const timestamps = new Set<string>();

		// Generate many timestamps rapidly
		for (let i = 0; i < 1000; i++) {
			timestamps.add(generator.generate());
		}

		// All should be unique
		expect(timestamps.size).toBe(1000);
	});

	it("reset clears the generator state", () => {
		const generator = createTimestampGenerator();

		// Generate some timestamps
		generator.generate();
		generator.generate();

		// Reset and generate again - should work fine
		generator.reset();
		const ts = generator.generate();

		expect(ts).toMatch(/^\d+\.\d{6}$/);
	});

	it("independent generators have independent state", () => {
		const gen1 = createTimestampGenerator();
		const gen2 = createTimestampGenerator();

		const ts1a = gen1.generate();
		const ts1b = gen1.generate();
		const ts2a = gen2.generate();
		const ts2b = gen2.generate();

		// Both generators should produce valid timestamps
		expect(ts1a).toMatch(/^\d+\.\d{6}$/);
		expect(ts2a).toMatch(/^\d+\.\d{6}$/);

		// Each generator's second timestamp should be >= its first
		expect(compareSlackTimestamps(ts1a, ts1b)).toBeLessThanOrEqual(0);
		expect(compareSlackTimestamps(ts2a, ts2b)).toBeLessThanOrEqual(0);
	});
});

describe("parseSlackTimestamp", () => {
	it("parses a standard timestamp", () => {
		const result = parseSlackTimestamp("1703000000.123456");

		expect(result.seconds).toBe(1703000000);
		expect(result.micros).toBe(123456);
		expect(result.date).toBeInstanceOf(Date);
	});

	it("parses timestamp with zero microseconds", () => {
		const result = parseSlackTimestamp("1703000000.000000");

		expect(result.seconds).toBe(1703000000);
		expect(result.micros).toBe(0);
	});

	it("handles timestamp without decimal", () => {
		const result = parseSlackTimestamp("1703000000");

		expect(result.seconds).toBe(1703000000);
		expect(result.micros).toBe(0);
	});

	it("converts to correct date", () => {
		// 2023-12-19 15:06:40 UTC = 1703000000 seconds
		const result = parseSlackTimestamp("1703000000.000000");

		expect(result.date.getUTCFullYear()).toBe(2023);
		expect(result.date.getUTCMonth()).toBe(11); // December (0-indexed)
		expect(result.date.getUTCDate()).toBe(19);
	});
});

describe("compareSlackTimestamps", () => {
	it("returns negative when a < b", () => {
		expect(compareSlackTimestamps("1000.000000", "2000.000000")).toBeLessThan(
			0,
		);
		expect(compareSlackTimestamps("1000.000000", "1000.000001")).toBeLessThan(
			0,
		);
	});

	it("returns positive when a > b", () => {
		expect(
			compareSlackTimestamps("2000.000000", "1000.000000"),
		).toBeGreaterThan(0);
		expect(
			compareSlackTimestamps("1000.000001", "1000.000000"),
		).toBeGreaterThan(0);
	});

	it("returns zero when equal", () => {
		expect(compareSlackTimestamps("1000.000000", "1000.000000")).toBe(0);
		expect(
			compareSlackTimestamps("1703000000.123456", "1703000000.123456"),
		).toBe(0);
	});

	it("compares correctly across second boundaries", () => {
		expect(compareSlackTimestamps("999.999999", "1000.000000")).toBeLessThan(0);
		expect(compareSlackTimestamps("1000.000000", "999.999999")).toBeGreaterThan(
			0,
		);
	});
});
