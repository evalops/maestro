import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStaticStageBadge } from "../src/tui/utils/footer-utils.js";

const ORIGINAL = {
	shimmer: process.env.COMPOSER_TUI_SHIMMER,
	noColor: process.env.NO_COLOR,
	composerNoColor: process.env.COMPOSER_NO_COLOR,
};

function resetEnv() {
	process.env.COMPOSER_TUI_SHIMMER = ORIGINAL.shimmer;
	process.env.NO_COLOR = ORIGINAL.noColor;
	process.env.COMPOSER_NO_COLOR = ORIGINAL.composerNoColor;
}

describe("footer stage shimmer", () => {
	beforeEach(resetEnv);
	afterEach(resetEnv);

	it("reduces ANSI escapes when shimmer is off", () => {
		process.env.COMPOSER_TUI_SHIMMER = "off";
		const out = renderStaticStageBadge("Responding");
		const escapes = countEscapes(out);
		expect(escapes).toBeLessThanOrEqual(2);
	});

	it("adds multiple ANSI escapes when shimmer is on", () => {
		process.env.COMPOSER_TUI_SHIMMER = "on";
		process.env.NO_COLOR = undefined;
		process.env.COMPOSER_NO_COLOR = undefined;
		const out = renderStaticStageBadge("Responding");
		const escapes = countEscapes(out);
		expect(escapes).toBeGreaterThan(2);
		expect(out.toLowerCase()).toContain("responding");
	});
});

function countEscapes(value: string): number {
	let count = 0;
	for (let i = 0; i < value.length - 1; i++) {
		if (value.charCodeAt(i) === 27 && value[i + 1] === "[") {
			count++;
		}
	}
	return count;
}
