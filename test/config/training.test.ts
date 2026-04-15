import { beforeEach, describe, expect, it } from "vitest";

import {
	getTrainingHeaders,
	getTrainingStatus,
	optIntoTraining,
	optOutOfTraining,
	parseTrainingFlag,
	resetTrainingRuntimeOverride,
	setTrainingRuntimeOverride,
} from "../../src/training.js";

describe("training module", () => {
	beforeEach(() => {
		resetTrainingRuntimeOverride();
	});

	describe("parseTrainingFlag", () => {
		it("recognizes truthy values", () => {
			expect(parseTrainingFlag("true")).toBe(true);
			expect(parseTrainingFlag("YES")).toBe(true);
			expect(parseTrainingFlag("On")).toBe(true);
		});

		it("recognizes falsy values", () => {
			expect(parseTrainingFlag("false")).toBe(false);
			expect(parseTrainingFlag("NO")).toBe(false);
			expect(parseTrainingFlag("off")).toBe(false);
		});

		it("falls back to provider defaults for invalid values", () => {
			expect(parseTrainingFlag("maybe")).toBeNull();
			expect(parseTrainingFlag(undefined)).toBeNull();
		});
	});

	it("opt-out overrides headers and status", () => {
		optOutOfTraining("tests");
		expect(getTrainingHeaders()).toEqual({
			"X-Data-Collection-Opt-Out": "true",
		});
		expect(getTrainingStatus()).toMatchObject({
			preference: "opted-out",
			runtimeOverride: "opted-out",
			overrideReason: "tests",
		});
	});

	it("opt-in override sets header false", () => {
		optIntoTraining("tests");
		expect(getTrainingHeaders()).toEqual({
			"X-Data-Collection-Opt-Out": "false",
		});
		expect(getTrainingStatus()).toMatchObject({
			preference: "opted-in",
			runtimeOverride: "opted-in",
		});
	});

	it("reset clears overrides and reason", () => {
		setTrainingRuntimeOverride(true, "override");
		resetTrainingRuntimeOverride();
		const status = getTrainingStatus();
		expect(status.runtimeOverride).toBeUndefined();
		expect(status.overrideReason).toBeUndefined();
	});
});
