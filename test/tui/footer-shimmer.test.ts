import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStaticStageBadge } from "../../src/cli-tui/utils/footer-utils.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";

const ORIGINAL = {
	shimmer: process.env.COMPOSER_TUI_SHIMMER,
	noColor: process.env.NO_COLOR,
	composerNoColor: process.env.COMPOSER_NO_COLOR,
	forceColor: process.env.FORCE_COLOR,
};

function resetEnv() {
	process.env.COMPOSER_TUI_SHIMMER = ORIGINAL.shimmer;
	process.env.NO_COLOR = ORIGINAL.noColor;
	process.env.COMPOSER_NO_COLOR = ORIGINAL.composerNoColor;
	process.env.FORCE_COLOR = ORIGINAL.forceColor;
}

describe("footer stage shimmer", () => {
	beforeEach(resetEnv);
	afterEach(resetEnv);

	it("keeps colored badge when shimmer is off", () => {
		process.env.COMPOSER_TUI_SHIMMER = "off";
		process.env.FORCE_COLOR = "1";
		const out = renderStaticStageBadge("Responding");
		expect(stripAnsiSequences(out).toLowerCase()).toContain("responding");
	});

	it("adds more ANSI escapes when shimmer is on", () => {
		process.env.COMPOSER_TUI_SHIMMER = "on";
		Reflect.deleteProperty(process.env, "NO_COLOR");
		Reflect.deleteProperty(process.env, "COMPOSER_NO_COLOR");
		process.env.FORCE_COLOR = "1";
		const shimmering = renderStaticStageBadge("Responding");
		process.env.COMPOSER_TUI_SHIMMER = "off";
		const staticBadge = renderStaticStageBadge("Responding");
		expect(countEscapes(shimmering)).toBeGreaterThan(countEscapes(staticBadge));
		expect(stripAnsiSequences(shimmering).toLowerCase()).toContain(
			"responding",
		);
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
