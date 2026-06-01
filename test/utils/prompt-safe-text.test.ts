import { describe, expect, it } from "vitest";
import { promptSafeText } from "../../src/utils/prompt-safe-text.js";

describe("promptSafeText", () => {
	it("collapses whitespace and omits empty text", () => {
		expect(promptSafeText("  Search\n\n\tacross   records  ")).toBe(
			"Search across records",
		);
		expect(promptSafeText(" \n\t ")).toBeNull();
		expect(promptSafeText(undefined)).toBeNull();
	});

	it("truncates incrementally to the requested character length", () => {
		expect(promptSafeText("one   two three", 5)).toBe("one t");
		expect(promptSafeText("🙂🙂🙂", 2)).toBe("🙂🙂");
	});

	it("does not leave a trailing separator when truncation lands after whitespace", () => {
		expect(promptSafeText("a b c", 4)).toBe("a b");
		expect(promptSafeText("a b", 2)).toBe("a");
	});

	it("bounds whitespace-only inspection by the requested character length", () => {
		expect(promptSafeText(`${" ".repeat(100)}hidden`, 8)).toBeNull();
	});
});
