import { describe, expect, it } from "vitest";
import {
	STAGE_DISPLAY_LABELS,
	detectStageKind,
	formatWorkingStageLabel,
	normalizeStageLabel,
} from "../src/tui/utils/stage-labels.js";

describe("stage label utilities", () => {
	it("normalizes labels by trimming whitespace without changing case", () => {
		const value = normalizeStageLabel("  Responding  ");
		expect(value).toBe("Responding");
	});

	it("detects stage kind using display labels regardless of whitespace or case", () => {
		expect(detectStageKind(" responding")).toBe("responding");
		expect(detectStageKind("WORKING · search")).toBe("working");
		expect(detectStageKind(` ${STAGE_DISPLAY_LABELS.dreaming}`)).toBe(
			"dreaming",
		);
	});

	it("returns undefined for unknown labels", () => {
		expect(detectStageKind("observing")).toBeUndefined();
	});

	it("formats working labels with optional progress suffix", () => {
		expect(formatWorkingStageLabel("search")).toBe(
			`${STAGE_DISPLAY_LABELS.working} · search`,
		);
		expect(formatWorkingStageLabel("search", 2, 3)).toBe(
			`${STAGE_DISPLAY_LABELS.working} · search (2/3)`,
		);
	});
});
