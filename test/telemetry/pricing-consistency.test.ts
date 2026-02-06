/**
 * Validates that cost-tracker pricing stays in sync with models.generated.ts.
 *
 * models.generated.ts is auto-generated from the models.dev API and is the
 * source of truth for per-model costs. If this test fails after a model
 * regeneration, update MODEL_PRICING in cost-tracker.ts to match.
 */
import { describe, expect, it } from "vitest";
import { MODELS } from "../../src/models/models.generated.js";
import { costTracker } from "../../src/telemetry/cost-tracker.js";

/** Tolerance for floating-point comparison (5% relative) */
const TOLERANCE = 0.05;

function withinTolerance(actual: number, expected: number): boolean {
	if (expected === 0) return actual === 0;
	return Math.abs(actual - expected) / expected <= TOLERANCE;
}

/** Flatten generated models into a lookup by model ID */
function buildGeneratedLookup(): Map<
	string,
	{ provider: string; input: number; output: number; cacheRead: number }
> {
	const lookup = new Map<
		string,
		{ provider: string; input: number; output: number; cacheRead: number }
	>();
	for (const [provider, models] of Object.entries(MODELS)) {
		for (const [modelId, model] of Object.entries(
			models as Record<
				string,
				{ cost: { input: number; output: number; cacheRead: number } }
			>,
		)) {
			// Prefer direct (non-openrouter) entries when duplicates exist
			if (!lookup.has(modelId) || provider !== "openrouter") {
				lookup.set(modelId, { provider, ...model.cost });
			}
		}
	}
	return lookup;
}

describe("pricing consistency with models.generated.ts", () => {
	const generated = buildGeneratedLookup();

	it("explicit MODEL_PRICING entries match the generated source of truth", () => {
		// Exercise every explicit key in MODEL_PRICING by querying with
		// the exact key. costTracker.getPricing returns the entry directly
		// for exact matches, so this validates the hardcoded values.
		//
		// We get the list of explicit keys by checking which model IDs
		// return non-default pricing on exact match.
		const knownModels = [
			// Anthropic
			"claude-sonnet-4-20250514",
			"claude-opus-4-20250514",
			"claude-opus-4-5-20251101",
			"claude-opus-4-6",
			"claude-3-5-sonnet-20241022",
			"claude-3-5-haiku-20241022",
			"claude-3-opus-20240229",
			"claude-3-sonnet-20240229",
			"claude-3-haiku-20240307",
			// OpenAI
			"gpt-4-turbo",
			"gpt-4o",
			"gpt-4o-mini",
			"gpt-4",
			"o1",
			"o1-mini",
			"o1-preview",
			"o3",
			"o3-mini",
			// Google
			"gemini-1.5-pro",
			"gemini-1.5-flash",
			"gemini-2.0-flash",
			// DeepSeek
			"deepseek-chat",
			"deepseek-r1",
		];

		const mismatches: string[] = [];
		for (const modelId of knownModels) {
			const gen = generated.get(modelId);
			if (!gen) continue; // Model not in generated registry (e.g., overlay-only)

			const pricing = costTracker.getPricing(modelId);
			if (!withinTolerance(pricing.inputPerMillion, gen.input)) {
				mismatches.push(
					`${modelId}: input $${pricing.inputPerMillion}/M in cost-tracker vs $${gen.input}/M in models.generated`,
				);
			}
			if (!withinTolerance(pricing.outputPerMillion, gen.output)) {
				mismatches.push(
					`${modelId}: output $${pricing.outputPerMillion}/M in cost-tracker vs $${gen.output}/M in models.generated`,
				);
			}
		}

		if (mismatches.length > 0) {
			throw new Error(
				`Pricing drift detected — update MODEL_PRICING in cost-tracker.ts:\n${mismatches.map((m) => `  - ${m}`).join("\n")}`,
			);
		}
	});

	it("prefix-related models resolve to their own pricing, not a sibling", () => {
		// Models whose IDs are prefixes of each other must resolve
		// to their own pricing entry, not a longer/shorter sibling.
		const cases: [string, number][] = [
			["gpt-4o", 2.5],
			["gpt-4o-mini", 0.15],
			["o3", 2],
			["o3-mini", 1.1],
			["o1", 15],
			["o1-mini", 1.1],
			["o1-preview", 15],
		];

		for (const [model, expectedInput] of cases) {
			const pricing = costTracker.getPricing(model);
			expect(
				pricing.inputPerMillion,
				`${model} resolved to wrong pricing`,
			).toBe(expectedInput);
		}
	});
});
