import { describe, expect, it } from "vitest";
import { composeSkill } from "../../src/skills/composer.js";
import type { LoadedSkill } from "../../src/skills/loader.js";

function makeSkill(overrides: Partial<LoadedSkill>): LoadedSkill {
	return {
		name: "stub",
		description: "stub description",
		content: "stub content",
		contentSha:
			"0000000000000000000000000000000000000000000000000000000000000000",
		sourcePath: "/tmp/stub",
		sourceType: "project",
		resources: [],
		resourceDirs: {},
		...overrides,
	};
}

describe("skills/composer", () => {
	describe("composeSkill", () => {
		it("splices review-guidelines content into the review skill when present", () => {
			const review = makeSkill({
				name: "review",
				description: "Review the current diff",
				content: "Run through the diff and flag issues.",
			});
			const guidelines = makeSkill({
				name: "review-guidelines",
				description: "Repo-specific review guidelines",
				content:
					"- No new uses of `any`.\n- Prefer composition over inheritance.",
			});

			const composed = composeSkill(review, [review, guidelines]);

			expect(composed.name).toBe("review");
			expect(composed.sourceType).toBe(review.sourceType);
			expect(composed.content).toContain(review.content);
			expect(composed.content).toContain(
				"## Repository-specific review guidelines",
			);
			expect(composed.content).toContain("- No new uses of `any`.");
		});

		it("returns the review skill unchanged when no review-guidelines exists", () => {
			const review = makeSkill({
				name: "review",
				content: "Run through the diff and flag issues.",
			});

			const composed = composeSkill(review, [review]);

			expect(composed).toBe(review);
			expect(composed.content).not.toContain(
				"## Repository-specific review guidelines",
			);
		});

		it("passes through skills with no registered composer", () => {
			const other = makeSkill({
				name: "pr-review",
				content: "Different procedure than the review skill.",
			});
			const guidelines = makeSkill({
				name: "review-guidelines",
				content: "guidelines body",
			});

			const composed = composeSkill(other, [other, guidelines]);

			expect(composed).toBe(other);
		});

		it("preserves identity fields so telemetry keys on the parent skill", () => {
			const review = makeSkill({
				name: "review",
				sourceType: "system",
				sourcePath: "/system/skills/review",
				content: "Base review content.",
			});
			const guidelines = makeSkill({
				name: "review-guidelines",
				sourceType: "project",
				content: "Repo guidelines.",
			});

			const composed = composeSkill(review, [review, guidelines]);

			expect(composed.name).toBe(review.name);
			expect(composed.sourceType).toBe(review.sourceType);
			expect(composed.sourcePath).toBe(review.sourcePath);
		});

		it("attributes the guidelines source so the agent sees provenance", () => {
			const review = makeSkill({
				name: "review",
				content: "Base review content.",
			});
			const guidelines = makeSkill({
				name: "review-guidelines",
				sourceType: "project",
				content: "Repo guidelines.",
			});

			const composed = composeSkill(review, [review, guidelines]);

			expect(composed.content).toContain("`project`");
			expect(composed.content).toContain("review-guidelines");
		});
	});
});
