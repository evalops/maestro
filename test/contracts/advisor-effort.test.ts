import { parseAdvisorEffortSignal } from "@evalops/contracts";
import { describe, expect, it } from "vitest";

describe("parseAdvisorEffortSignal", () => {
	it("extracts the final effort signal and revisit condition", () => {
		expect(
			parseAdvisorEffortSignal(
				[
					"Summary: ship the small fix.",
					"Effort: S (<1h)",
					"Effort: M (1-3h after tests)",
					"Revisit-if: integration tests reveal a protocol mismatch",
				].join("\n"),
			),
		).toEqual({
			size: "M",
			justification: "1-3h after tests",
			revisitIf: "integration tests reveal a protocol mismatch",
		});
	});

	it("does not carry a stale revisit condition onto a later effort signal", () => {
		expect(
			parseAdvisorEffortSignal(
				[
					"Effort: L (needs protocol work)",
					"Revisit-if: hosted runtime scope changes",
					"Correction: the contract already exists.",
					"Effort: S (<1h)",
				].join("\n"),
			),
		).toEqual({
			size: "S",
			justification: "<1h",
		});
	});

	it("supports dash-separated justification", () => {
		expect(parseAdvisorEffortSignal("Effort: XL - decompose first")).toEqual({
			size: "XL",
			justification: "decompose first",
		});
	});

	it("normalizes lowercase size values to canonical uppercase", () => {
		expect(parseAdvisorEffortSignal("effort: xl (>2d)")).toEqual({
			size: "XL",
			justification: ">2d",
		});
	});

	it("returns null when no signal is present", () => {
		expect(parseAdvisorEffortSignal("No estimate here.")).toBeNull();
	});
});
