import { describe, expect, it } from "vitest";
import { splitForSlack } from "../src/utils/split-for-slack.js";

describe("splitForSlack", () => {
	it("returns single part when under limit", () => {
		const text = "short message";
		expect(splitForSlack(text, { maxLength: 100 })).toEqual([text]);
	});

	it("splits long text and appends continuation suffix", () => {
		const text = "12345678\nabcdefghij\nklmno";
		const parts = splitForSlack(text, { maxLength: 10, suffixPadding: 0 });

		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts.slice(0, -1)) {
			expect(part).toMatch(/\n_\((continued \d+\.\.\.)\)_$/);
		}
		expect(parts.at(-1)).not.toMatch(/\n_\((continued \d+\.\.\.)\)_$/);

		const reconstructed = parts
			.map((p) => p.replace(/\n_\((continued \d+\.\.\.)\)_$/, ""))
			.join("");
		expect(reconstructed).toBe(text);
	});

	it("handles suffix padding larger than maxLength without exceeding limit", () => {
		const text = "1234567890";
		const parts = splitForSlack(text, { maxLength: 4, suffixPadding: 50 });

		expect(parts.join("")).toBe(text);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(4);
		}
	});
});
