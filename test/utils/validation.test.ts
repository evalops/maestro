import { describe, expect, it } from "vitest";
import {
	ValidationError,
	requireInRange,
	requireNonEmpty,
	requireOneOf,
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
