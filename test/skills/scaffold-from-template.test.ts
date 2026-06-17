import { describe, expect, it } from "vitest";
import {
	scaffoldOptionsForTemplateName,
	scaffoldOptionsFromTemplate,
} from "../../src/skills/scaffold-from-template.js";
import type { SkillTemplate } from "../../src/skills/skill-templates.js";

function makeTemplate(overrides: Partial<SkillTemplate> = {}): SkillTemplate {
	return {
		name: "demo",
		description: "Demo template",
		body: "# Demo body",
		tags: ["demo"],
		...overrides,
	};
}

describe("skills/scaffold-from-template", () => {
	describe("scaffoldOptionsFromTemplate", () => {
		it("returns name + scaffolder options with the template defaults", () => {
			const result = scaffoldOptionsFromTemplate(makeTemplate());
			expect(result.name).toBe("demo");
			expect(result.options.description).toBe("Demo template");
			expect(result.options.body).toBe("# Demo body");
			expect(result.options.allowedTools).toBeUndefined();
			expect(result.options.builtinTools).toBeUndefined();
			expect(result.options.metadata).toBeUndefined();
			expect(result.options.force).toBeUndefined();
		});

		it("passes through allowedTools / builtinTools / metadata when the template carries them", () => {
			const result = scaffoldOptionsFromTemplate(
				makeTemplate({
					allowedTools: ["read", "search"],
					builtinTools: ["bash"],
					metadata: { ownership: "platform" },
				}),
			);
			expect(result.options.allowedTools).toEqual(["read", "search"]);
			expect(result.options.builtinTools).toEqual(["bash"]);
			expect(result.options.metadata).toEqual({ ownership: "platform" });
		});

		it("lets overrides replace description + body", () => {
			const result = scaffoldOptionsFromTemplate(makeTemplate(), {
				description: "Custom",
				body: "# Custom body",
			});
			expect(result.options.description).toBe("Custom");
			expect(result.options.body).toBe("# Custom body");
		});

		it("lets overrides replace allowedTools + builtinTools", () => {
			const result = scaffoldOptionsFromTemplate(
				makeTemplate({ allowedTools: ["read"], builtinTools: ["bash"] }),
				{
					allowedTools: ["write"],
					builtinTools: ["read"],
				},
			);
			expect(result.options.allowedTools).toEqual(["write"]);
			expect(result.options.builtinTools).toEqual(["read"]);
		});

		it("merges metadata (override keys win)", () => {
			const result = scaffoldOptionsFromTemplate(
				makeTemplate({ metadata: { ownership: "platform", base: "yes" } }),
				{
					metadata: { ownership: "edge", extra: "splice" },
				},
			);
			expect(result.options.metadata).toEqual({
				ownership: "edge",
				base: "yes",
				extra: "splice",
			});
		});

		it("preserves force when supplied", () => {
			const result = scaffoldOptionsFromTemplate(makeTemplate(), {
				force: true,
			});
			expect(result.options.force).toBe(true);
		});

		it("throws when neither template nor override supplies a description", () => {
			expect(() =>
				scaffoldOptionsFromTemplate(makeTemplate({ description: "" })),
			).toThrow(/description is required/);
		});

		it("throws when neither template nor override supplies a body", () => {
			expect(() =>
				scaffoldOptionsFromTemplate(makeTemplate({ body: "" })),
			).toThrow(/body is required/);
		});

		it("accepts blank template description when override supplies one", () => {
			const result = scaffoldOptionsFromTemplate(
				makeTemplate({ description: "" }),
				{ description: "Supplied" },
			);
			expect(result.options.description).toBe("Supplied");
		});

		it("does not leak `tags` into ScaffoldSkillOptions", () => {
			const result = scaffoldOptionsFromTemplate(
				makeTemplate({ tags: ["review", "anchor"] }),
			);
			expect("tags" in result.options).toBe(false);
		});
	});

	describe("scaffoldOptionsForTemplateName", () => {
		it("resolves a known template name from the canonical registry", () => {
			const result = scaffoldOptionsForTemplateName("review");
			expect(result.name).toBe("review");
			expect(result.options.body).toContain("Review skill");
		});

		it("throws for an unknown template name", () => {
			expect(() => scaffoldOptionsForTemplateName("ghost")).toThrow(
				/no template named "ghost"/,
			);
		});

		it("forwards overrides through to the underlying converter", () => {
			const result = scaffoldOptionsForTemplateName("review", {
				force: true,
				metadata: { owner: "self" },
			});
			expect(result.options.force).toBe(true);
			expect(result.options.metadata).toMatchObject({ owner: "self" });
		});
	});
});
