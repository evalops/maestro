import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readBooleanEnv,
	readNonNegativeInt,
	readPositiveInt,
	readThresholdEnv,
} from "../../src/utils/env-parser.js";

describe("readBooleanEnv", () => {
	const TEST_VAR = "TEST_BOOL_VAR";

	beforeEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	it("returns fallback when env var is not set", () => {
		expect(readBooleanEnv(TEST_VAR)).toBe(false);
		expect(readBooleanEnv(TEST_VAR, true)).toBe(true);
	});

	it("returns fallback for empty string", () => {
		process.env[TEST_VAR] = "";
		expect(readBooleanEnv(TEST_VAR, true)).toBe(true);
	});

	it.each(["1", "true", "yes", "on", "TRUE", "True", "YES", "ON", "  true  "])(
		'parses "%s" as true',
		(value) => {
			process.env[TEST_VAR] = value;
			expect(readBooleanEnv(TEST_VAR)).toBe(true);
		},
	);

	it.each([
		"0",
		"false",
		"no",
		"off",
		"FALSE",
		"False",
		"NO",
		"OFF",
		"  false  ",
	])('parses "%s" as false', (value) => {
		process.env[TEST_VAR] = value;
		expect(readBooleanEnv(TEST_VAR, true)).toBe(false);
	});

	it("returns fallback for unrecognized values", () => {
		process.env[TEST_VAR] = "maybe";
		expect(readBooleanEnv(TEST_VAR)).toBe(false);
		expect(readBooleanEnv(TEST_VAR, true)).toBe(true);
	});

	it("returns fallback for numeric strings other than 0/1", () => {
		process.env[TEST_VAR] = "2";
		expect(readBooleanEnv(TEST_VAR, true)).toBe(true);
	});
});

describe("readNonNegativeInt", () => {
	const TEST_VAR = "TEST_NON_NEG_INT";

	beforeEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	it("returns fallback when env var is not set", () => {
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(42);
	});

	it("returns fallback for empty string", () => {
		process.env[TEST_VAR] = "";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(42);
	});

	it("parses valid non-negative integers", () => {
		process.env[TEST_VAR] = "0";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(0);

		process.env[TEST_VAR] = "100";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(100);

		process.env[TEST_VAR] = "999999";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(999999);
	});

	it("returns fallback for negative integers", () => {
		process.env[TEST_VAR] = "-1";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(42);

		process.env[TEST_VAR] = "-100";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(42);
	});

	it("returns fallback for non-numeric strings", () => {
		process.env[TEST_VAR] = "abc";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(42);

		process.env[TEST_VAR] = "12abc";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(12); // parseInt behavior
	});

	it("returns fallback for floating point strings", () => {
		process.env[TEST_VAR] = "3.14";
		expect(readNonNegativeInt(TEST_VAR, 42)).toBe(3); // parseInt truncates
	});
});

describe("readThresholdEnv", () => {
	const TEST_VAR = "TEST_THRESHOLD";

	beforeEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	it("returns fallback when env var is not set", () => {
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(50);
	});

	it("returns fallback for empty string", () => {
		process.env[TEST_VAR] = "";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(50);
	});

	it("parses valid positive thresholds", () => {
		process.env[TEST_VAR] = "1";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(1);

		process.env[TEST_VAR] = "100";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(100);
	});

	it("returns Infinity for zero (disable threshold)", () => {
		process.env[TEST_VAR] = "0";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(Number.POSITIVE_INFINITY);
	});

	it("returns Infinity for negative values (disable threshold)", () => {
		process.env[TEST_VAR] = "-1";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(Number.POSITIVE_INFINITY);

		process.env[TEST_VAR] = "-100";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(Number.POSITIVE_INFINITY);
	});

	it("returns fallback for non-numeric strings", () => {
		process.env[TEST_VAR] = "abc";
		expect(readThresholdEnv(TEST_VAR, 50)).toBe(50);
	});
});

describe("readPositiveInt", () => {
	const TEST_VAR = "TEST_POSITIVE_INT";

	beforeEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
	});

	it("returns fallback when env var is not set", () => {
		expect(readPositiveInt(TEST_VAR, 10)).toBe(10);
	});

	it("returns fallback for empty string", () => {
		process.env[TEST_VAR] = "";
		expect(readPositiveInt(TEST_VAR, 10)).toBe(10);
	});

	it("parses valid positive integers (default minimum 1)", () => {
		process.env[TEST_VAR] = "1";
		expect(readPositiveInt(TEST_VAR, 10)).toBe(1);

		process.env[TEST_VAR] = "100";
		expect(readPositiveInt(TEST_VAR, 10)).toBe(100);
	});

	it("returns fallback for zero (below default minimum)", () => {
		process.env[TEST_VAR] = "0";
		expect(readPositiveInt(TEST_VAR, 10)).toBe(10);
	});

	it("returns fallback for negative integers", () => {
		process.env[TEST_VAR] = "-5";
		expect(readPositiveInt(TEST_VAR, 10)).toBe(10);
	});

	it("respects custom minimum", () => {
		process.env[TEST_VAR] = "5";
		expect(readPositiveInt(TEST_VAR, 10, 10)).toBe(10); // 5 < 10, use fallback

		process.env[TEST_VAR] = "15";
		expect(readPositiveInt(TEST_VAR, 10, 10)).toBe(15); // 15 >= 10, use value
	});

	it("allows zero with minimum 0", () => {
		process.env[TEST_VAR] = "0";
		expect(readPositiveInt(TEST_VAR, 10, 0)).toBe(0);
	});

	it("returns fallback for non-numeric strings", () => {
		process.env[TEST_VAR] = "abc";
		expect(readPositiveInt(TEST_VAR, 10)).toBe(10);
	});
});
