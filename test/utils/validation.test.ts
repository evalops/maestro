import { describe, expect, it } from "vitest";
import {
	ValidationError,
	isNotNull,
	isPlainObject,
	isValidEmail,
	isValidUrl,
	parseIntSafe,
	requireInRange,
	requireNonEmpty,
	requireOneOf,
	sanitizeCommandArg,
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

describe("isValidEmail", () => {
	it("returns true for valid email", () => {
		expect(isValidEmail("a@b.co")).toBe(true);
		expect(isValidEmail("user@example.com")).toBe(true);
	});
	it("returns false for invalid email", () => {
		expect(isValidEmail("")).toBe(false);
		expect(isValidEmail("no-at")).toBe(false);
		expect(isValidEmail("@nodomain")).toBe(false);
		expect(isValidEmail("no-tld.")).toBe(false);
	});
});

describe("isValidUrl", () => {
	it("returns true for valid URL", () => {
		expect(isValidUrl("https://example.com")).toBe(true);
		expect(isValidUrl("file:///tmp/foo")).toBe(true);
	});
	it("returns false for invalid URL", () => {
		expect(isValidUrl("")).toBe(false);
		expect(isValidUrl("not a url")).toBe(false);
	});
});

describe("sanitizeCommandArg", () => {
	it("strips shell metacharacters", () => {
		expect(sanitizeCommandArg("a;b|c")).toBe("abc");
		expect(sanitizeCommandArg("$x`")).toBe("x");
		expect(sanitizeCommandArg("(x)")).toBe("x");
	});
	it("leaves safe characters", () => {
		expect(sanitizeCommandArg("hello-world")).toBe("hello-world");
	});
});

describe("isPlainObject", () => {
	it("returns true for plain object", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject({ a: 1 })).toBe(true);
	});
	it("returns false for non-plain values", () => {
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject(new Date())).toBe(false);
	});
});

describe("isNotNull", () => {
	it("returns true for non-null values", () => {
		expect(isNotNull(0)).toBe(true);
		expect(isNotNull("")).toBe(true);
	});
	it("returns false for null and undefined", () => {
		expect(isNotNull(null)).toBe(false);
		expect(isNotNull(undefined)).toBe(false);
	});
});
