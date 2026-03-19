import { describe, expect, it } from "vitest";
import {
	ValidationError,
	parseIntSafe,
	requireInRange,
	requireNonEmpty,
	requireOneOf,
	sanitizeString,
	sanitizeSurrogates,
} from "../../src/utils/validation.js";

describe("requireNonEmpty", () => {
	it("does not throw for non-empty string", () => {
		requireNonEmpty("hello", "field");
		requireNonEmpty(" x ", "field");
	});

	it("throws ValidationError for undefined", () => {
		expect(() => requireNonEmpty(undefined, "field")).toThrow(ValidationError);
		expect(() => requireNonEmpty(undefined, "field")).toThrow(
			/field is required and cannot be empty/,
		);
	});

	it("throws ValidationError for null", () => {
		expect(() => requireNonEmpty(null, "field")).toThrow(ValidationError);
	});

	it("throws ValidationError for empty string", () => {
		expect(() => requireNonEmpty("", "field")).toThrow(ValidationError);
	});

	it("throws ValidationError for whitespace-only string", () => {
		expect(() => requireNonEmpty("   ", "field")).toThrow(ValidationError);
		expect(() => requireNonEmpty("\t\n", "field")).toThrow(ValidationError);
	});
});

describe("requireInRange", () => {
	it("does not throw when value is within range", () => {
		requireInRange(5, 0, 10, "value");
		requireInRange(0, 0, 10, "value");
		requireInRange(10, 0, 10, "value");
	});

	it("throws when value is below min", () => {
		expect(() => requireInRange(-1, 0, 10, "value")).toThrow(ValidationError);
		expect(() => requireInRange(-1, 0, 10, "value")).toThrow(
			/value must be between 0 and 10/,
		);
	});

	it("throws when value is above max", () => {
		expect(() => requireInRange(11, 0, 10, "value")).toThrow(ValidationError);
	});
});

describe("requireOneOf", () => {
	it("does not throw when value is in allowed list", () => {
		requireOneOf("a", ["a", "b", "c"], "choice");
		requireOneOf(2, [1, 2, 3], "num");
	});

	it("throws when value is not in allowed list", () => {
		expect(() => requireOneOf("x", ["a", "b"], "choice")).toThrow(
			ValidationError,
		);
		expect(() => requireOneOf("x", ["a", "b"], "choice")).toThrow(
			/choice must be one of: a, b/,
		);
	});
});

describe("parseIntSafe", () => {
	it("returns integer for valid number", () => {
		expect(parseIntSafe(42, "n")).toBe(42);
		expect(parseIntSafe("42", "n")).toBe(42);
	});

	it("accepts trimmed string", () => {
		expect(parseIntSafe("  42  ", "n")).toBe(42);
	});

	it("throws for string with trailing non-digits", () => {
		expect(() => parseIntSafe("42x", "n")).toThrow(ValidationError);
		expect(() => parseIntSafe("42x", "n")).toThrow(/valid integer/);
	});

	it("throws for string with leading non-digits", () => {
		expect(() => parseIntSafe("x42", "n")).toThrow(ValidationError);
	});

	it("respects min and max options", () => {
		expect(parseIntSafe("5", "n", { min: 0, max: 10 })).toBe(5);
		expect(() => parseIntSafe("5", "n", { min: 10 })).toThrow(ValidationError);
		expect(() => parseIntSafe("5", "n", { max: 3 })).toThrow(ValidationError);
	});
});

describe("sanitizeString", () => {
	it("removes null and control characters", () => {
		expect(sanitizeString("a\u0000b\u0007c")).toBe("abc");
		expect(sanitizeString("x\u001fy")).toBe("xy");
	});

	it("keeps tab and newline", () => {
		expect(sanitizeString("a\tb\nc")).toBe("a\tb\nc");
	});

	it("truncates to maxLength", () => {
		expect(sanitizeString("abcd", { maxLength: 2 })).toBe("ab");
	});
});

describe("sanitizeSurrogates", () => {
	it("preserves valid emoji (paired surrogates)", () => {
		expect(sanitizeSurrogates("Hello 🙈 World")).toBe("Hello 🙈 World");
	});

	it("removes unpaired high surrogate", () => {
		const unpaired = String.fromCharCode(0xd83d);
		expect(sanitizeSurrogates(`Text ${unpaired} here`)).toBe("Text  here");
	});

	it("removes unpaired low surrogate", () => {
		const unpaired = String.fromCharCode(0xde08);
		expect(sanitizeSurrogates(`Text ${unpaired} here`)).toBe("Text  here");
	});
});
