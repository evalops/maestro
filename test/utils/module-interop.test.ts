import { describe, expect, it } from "vitest";
import { resolveDefaultExport } from "../../src/utils/module-interop.js";

describe("resolveDefaultExport", () => {
	it("returns value when it is not a default-export wrapper", () => {
		expect(resolveDefaultExport(42)).toBe(42);
		expect(resolveDefaultExport("hi")).toBe("hi");
		expect(resolveDefaultExport(null)).toBe(null);
	});

	it("returns .default when value is { default: X }", () => {
		expect(resolveDefaultExport({ default: 1 })).toBe(1);
		expect(resolveDefaultExport({ default: "x" })).toBe("x");
	});

	it("returns fallback when moduleValue is undefined", () => {
		expect(resolveDefaultExport(undefined, 0)).toBe(0);
		expect(resolveDefaultExport(undefined, "fallback")).toBe("fallback");
	});

	it("throws when moduleValue and fallback are undefined", () => {
		expect(() => resolveDefaultExport(undefined)).toThrow(
			/Module default export not available/,
		);
	});

	it("returns wrapper when .default is undefined (interop shape)", () => {
		const wrapper = { default: undefined };
		expect(resolveDefaultExport(wrapper)).toBe(wrapper);
	});
});
