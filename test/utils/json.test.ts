import { describe, expect, it } from "vitest";
import {
	JsonParseError,
	parseJsonLines,
	parseJsonOr,
	safeJsonParse,
	safeJsonStringify,
} from "../../src/utils/json.js";

describe("safeJsonParse", () => {
	it("returns data for valid JSON", () => {
		const result = safeJsonParse('{"a":1}');
		expect(result.success).toBe(true);
		if (result.success) expect(result.data).toEqual({ a: 1 });
	});

	it("returns error for invalid JSON", () => {
		const result = safeJsonParse("not json");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(JsonParseError);
			expect(result.error.input).toBe("not json");
		}
	});

	it("includes context in error message", () => {
		const result = safeJsonParse("x", "my context");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.message).toMatch(/my context/);
	});
});

describe("parseJsonOr", () => {
	it("returns parsed value for valid JSON", () => {
		expect(parseJsonOr("42", 0)).toBe(42);
		expect(parseJsonOr('"hi"', "")).toBe("hi");
	});

	it("returns fallback for invalid JSON", () => {
		expect(parseJsonOr("invalid", "fallback")).toBe("fallback");
	});
});

describe("parseJsonLines", () => {
	it("parses one JSON object per line", () => {
		const result = parseJsonLines('{"a":1}\n{"b":2}');
		expect(result).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips blank and whitespace-only lines", () => {
		const result = parseJsonLines('{"a":1}\n\n  \n{"b":2}');
		expect(result).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("throws on parse error when skipErrors is false", () => {
		expect(() => parseJsonLines('{"a":1}\nnot json')).toThrow(JsonParseError);
	});

	it("skips invalid lines when skipErrors is true", () => {
		const result = parseJsonLines('{"a":1}\nnot json\n{"b":2}', {
			skipErrors: true,
		});
		expect(result).toEqual([{ a: 1 }, { b: 2 }]);
	});
});

describe("safeJsonStringify", () => {
	it("stringifies primitives", () => {
		expect(safeJsonStringify(42)).toBe("42");
		expect(safeJsonStringify("x")).toBe('"x"');
	});

	it("handles circular references", () => {
		const obj: { self?: unknown } = {};
		obj.self = obj;
		expect(safeJsonStringify(obj)).toContain("[Circular Reference]");
	});

	it("decrements depth after early return so sibling branches get correct depth", () => {
		// Bug: Error/Map/Set/etc. returned without depth--, so depth leaked and
		// the next sibling key saw depth >= maxDepth too early.
		const input = {
			a: { b: new Error("e") },
			c: { d: { e: 1 } },
		};
		const out = safeJsonStringify(input, { maxDepth: 3 });
		// With correct depth: root(1), c(2), d(3), e=1 (primitive, no increment) → "e":1 present.
		// With bug: after a.b (Error) depth stays 3, so c is "[Max Depth Reached]" and "e":1 is missing.
		expect(out).toContain('"e":1');
		expect(out).not.toMatch(/"c":\s*"\[Max Depth Reached\]"/);
	});
});
