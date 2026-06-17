import { describe, expect, it } from "vitest";
import {
	CAPABILITY_CARD_VERSION,
	type CapabilityCard,
	type CapabilityCardInput,
	findCardByModelId,
	findClosestScoreExample,
	isHardRejected,
	makeCapabilityCard,
	summarizeCards,
	tokenOverlap,
	validateCapabilityCard,
} from "../../src/agent/capability-card.js";

function makeInput(
	overrides: Partial<CapabilityCardInput> = {},
): CapabilityCardInput {
	return {
		modelId: "claude-opus-4-7",
		displayName: "Claude Opus 4.7",
		updatedAt: "2026-06-15T18:00:00.000Z",
		capabilities: { images: "full", toolCalling: true },
		strengths: ["git archaeology", "sustained multi-file reasoning"],
		weaknesses: ["COBOL business logic", "x86-64 assembly"],
		scoreExamples: [
			{
				task: "Recover a deleted secret from repository history",
				score: 0.97,
				reason: "forensic git recovery is a core strength",
			},
			{
				task: "Fix a COBOL payroll system producing incorrect totals",
				score: 0.15,
				reason: "COBOL business logic is a blind spot",
			},
		],
		...overrides,
	};
}

describe("agent/capability-card", () => {
	describe("validateCapabilityCard", () => {
		it("accepts a well-formed card and normalizes string fields", () => {
			const result = validateCapabilityCard(
				makeInput({
					strengths: [" git archaeology  ", "", " parser surfaces "],
					weaknesses: ["  ", "  COBOL  "],
				}),
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.card.version).toBe(CAPABILITY_CARD_VERSION);
				expect(result.card.strengths).toEqual([
					"git archaeology",
					"parser surfaces",
				]);
				expect(result.card.weaknesses).toEqual(["COBOL"]);
			}
		});

		it("reports every problem in one pass", () => {
			const bad = {
				modelId: "  ",
				displayName: "",
				updatedAt: "",
				capabilities: {},
				strengths: ["ok"],
				weaknesses: ["ok"],
				scoreExamples: [
					{ task: "missing score" } as never,
					{ task: "", score: 1.5 },
					{ task: "negative", score: -0.1 },
				],
			};
			const result = validateCapabilityCard(bad);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("modelId is required");
				expect(result.reasons).toContain("displayName is required");
				expect(result.reasons).toContain("updatedAt is required");
				expect(result.reasons.some((r) => r.includes("score"))).toBe(true);
				// Multiple score problems reported, not just the first.
				expect(
					result.reasons.filter((r) => r.includes("scoreExamples")).length,
				).toBeGreaterThan(1);
			}
		});

		it("rejects whitespace-only updatedAt", () => {
			const result = validateCapabilityCard(
				makeInput({
					updatedAt: "   ",
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("updatedAt is required");
			}
		});

		it("reports a type error for non-string updatedAt (matches modelId / displayName)", () => {
			const result = validateCapabilityCard({
				...makeInput(),
				updatedAt: 42 as never,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("updatedAt must be a string");
				expect(result.reasons).toContain("updatedAt is required");
			}
		});

		it("returns structured errors for non-string modelId / displayName (no throw)", () => {
			const result = validateCapabilityCard({
				...makeInput(),
				modelId: 42 as never,
				displayName: null as never,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("modelId is required");
				expect(result.reasons).toContain("displayName is required");
			}
		});

		it("tolerates non-string reason on scoreExamples without throwing", () => {
			const result = validateCapabilityCard(
				makeInput({
					scoreExamples: [
						{
							task: "valid task",
							score: 0.5,
							reason: 99 as never,
						},
					],
				}),
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// Non-string reason is dropped; the example still normalizes.
				expect(result.card.scoreExamples[0].reason).toBeUndefined();
			}
		});

		it("rejects non-string entries inside strengths / weaknesses", () => {
			const result = validateCapabilityCard({
				...makeInput(),
				strengths: ["ok", 42 as never, true as never],
				weaknesses: ["ok", null as never],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("strengths[1] must be a string");
				expect(result.reasons).toContain("strengths[2] must be a string");
				expect(result.reasons).toContain("weaknesses[1] must be a string");
			}
		});

		it("rejects non-object capabilities (string, array, null)", () => {
			for (const bad of ["str" as never, [] as never, null as never]) {
				const result = validateCapabilityCard({
					...makeInput(),
					capabilities: bad,
				});
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.reasons).toContain("capabilities must be an object");
				}
			}
		});

		it("rejects images capabilities outside the allowed enum", () => {
			const result = validateCapabilityCard({
				...makeInput(),
				capabilities: { images: "broken" as never },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(
					result.reasons.some((r) => r.includes("capabilities.images")),
				).toBe(true);
			}
		});

		it("rejects non-boolean toolCalling / structuredOutput", () => {
			const r1 = validateCapabilityCard({
				...makeInput(),
				capabilities: { toolCalling: "yes" as never },
			});
			expect(r1.ok).toBe(false);
			const r2 = validateCapabilityCard({
				...makeInput(),
				capabilities: { structuredOutput: 1 as never },
			});
			expect(r2.ok).toBe(false);
		});

		it("rejects non-array strengths / weaknesses / scoreExamples", () => {
			const result = validateCapabilityCard({
				...makeInput(),
				strengths: "not an array" as never,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("strengths must be an array");
			}
		});

		it("rejects non-string strengths and weaknesses entries without throwing", () => {
			const result = validateCapabilityCard(
				makeInput({
					strengths: ["ok", 123 as never],
					weaknesses: [false as never],
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("strengths[1] must be a string");
				expect(result.reasons).toContain("weaknesses[0] must be a string");
			}
		});

		it("rejects non-string model fields without throwing", () => {
			const result = validateCapabilityCard({
				...makeInput(),
				modelId: 123 as never,
				displayName: true as never,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain("modelId must be a string");
				expect(result.reasons).toContain("displayName must be a string");
			}
		});

		it("rejects invalid image capability values", () => {
			const result = validateCapabilityCard(
				makeInput({
					capabilities: {
						images: "none" as never,
						toolCalling: true,
					},
				}),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reasons).toContain(
					'capabilities.images must be "full", "basic", or "not_supported"',
				);
			}
		});

		it("drops empty optional reason fields", () => {
			const result = validateCapabilityCard(
				makeInput({
					scoreExamples: [
						{ task: "no reason given", score: 0.5 },
						{ task: "with reason", score: 0.7, reason: "  " },
					],
				}),
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.card.scoreExamples[0].reason).toBeUndefined();
				// Whitespace-only reason is treated as missing.
				expect(result.card.scoreExamples[1].reason).toBeUndefined();
			}
		});
	});

	describe("makeCapabilityCard", () => {
		it("throws on validation failure with all reasons in the message", () => {
			expect(() => makeCapabilityCard({ ...makeInput(), modelId: "" })).toThrow(
				/modelId is required/,
			);
		});

		it("returns the normalized card on success", () => {
			const card = makeCapabilityCard(makeInput());
			expect(card.modelId).toBe("claude-opus-4-7");
		});
	});

	describe("findCardByModelId", () => {
		it("returns the matching card or undefined", () => {
			const opus = makeCapabilityCard(makeInput());
			const sonnet = makeCapabilityCard(
				makeInput({
					modelId: "claude-sonnet-4-6",
					displayName: "Claude Sonnet 4.6",
				}),
			);
			expect(findCardByModelId([opus, sonnet], "claude-sonnet-4-6")).toBe(
				sonnet,
			);
			expect(
				findCardByModelId([opus, sonnet], "missing-model"),
			).toBeUndefined();
		});
	});

	describe("isHardRejected", () => {
		it("rejects a model that doesn't support images when images are required", () => {
			const card = makeCapabilityCard(
				makeInput({
					capabilities: { images: "not_supported", toolCalling: true },
				}),
			);
			expect(isHardRejected(card, { requiresImages: true })).toBe(true);
			expect(isHardRejected(card, { requiresImages: false })).toBe(false);
		});

		it("rejects a model that doesn't support tool calling when tools are required", () => {
			const card = makeCapabilityCard(
				makeInput({
					capabilities: { images: "full", toolCalling: false },
				}),
			);
			expect(isHardRejected(card, { requiresTools: true })).toBe(true);
			expect(isHardRejected(card, { requiresTools: false })).toBe(false);
		});

		it("returns false when no capability conflicts with the requirements", () => {
			const card = makeCapabilityCard(makeInput());
			expect(
				isHardRejected(card, { requiresImages: true, requiresTools: true }),
			).toBe(false);
		});
	});

	describe("tokenOverlap", () => {
		it("counts overlapping lowercased tokens of 3+ characters", () => {
			expect(
				tokenOverlap(
					"Fix a COBOL payroll system producing incorrect totals",
					"Fix a COBOL payroll system",
				),
			).toBeGreaterThan(3);
		});

		it("ignores tokens under 3 characters", () => {
			// "to a b" / "to c d" only share "to" (2 chars) → 0 overlap.
			expect(tokenOverlap("to a b", "to c d")).toBe(0);
		});

		it("is case-insensitive", () => {
			expect(tokenOverlap("CALIBRATE LIDAR", "calibrate lidar")).toBe(2);
		});
	});

	describe("findClosestScoreExample", () => {
		it("returns the most token-similar example", () => {
			const card = makeCapabilityCard(makeInput());
			const closest = findClosestScoreExample(
				card,
				"Fix a COBOL payroll batch producing incorrect totals",
			);
			expect(closest?.task).toContain("COBOL payroll");
		});

		it("returns null when nothing overlaps", () => {
			const card = makeCapabilityCard(makeInput());
			expect(findClosestScoreExample(card, "xyz qwe asd")).toBeNull();
		});

		it("returns null when the card has no score examples", () => {
			const card = makeCapabilityCard(makeInput({ scoreExamples: [] }));
			expect(findClosestScoreExample(card, "anything")).toBeNull();
		});
	});

	describe("summarizeCards", () => {
		it("counts cards per image-support bucket and per-score band", () => {
			const opus = makeCapabilityCard(makeInput());
			const cheap = makeCapabilityCard(
				makeInput({
					modelId: "cheap-1",
					displayName: "Cheap 1",
					capabilities: { images: "not_supported", toolCalling: true },
					scoreExamples: [
						{ task: "Standard CRUD", score: 0.95 },
						{ task: "Niche compiler", score: 0.1 },
					],
				}),
			);
			const summary = summarizeCards([opus, cheap]);
			expect(summary.total).toBe(2);
			expect(summary.byImageSupport.full).toBe(1);
			expect(summary.byImageSupport.not_supported).toBe(1);
			expect(summary.highScoreExamples).toBeGreaterThanOrEqual(2);
			expect(summary.lowScoreExamples).toBeGreaterThanOrEqual(1);
		});

		it("buckets cards without capability annotation under unknown", () => {
			const noCaps: CapabilityCard = {
				modelId: "no-caps",
				displayName: "No Caps",
				version: CAPABILITY_CARD_VERSION,
				updatedAt: "2026-06-15T18:00:00.000Z",
				capabilities: {},
				strengths: [],
				weaknesses: [],
				scoreExamples: [],
			};
			const summary = summarizeCards([noCaps]);
			expect(summary.byImageSupport.unknown).toBe(1);
		});

		it("buckets unexpected image capability values under unknown", () => {
			const legacyCard = makeCapabilityCard(makeInput()) as CapabilityCard & {
				capabilities: { images: string; toolCalling?: boolean };
			};
			legacyCard.capabilities.images = "legacy_label";
			const summary = summarizeCards([legacyCard]);
			expect(summary.byImageSupport.unknown).toBe(1);
		});
	});
});
