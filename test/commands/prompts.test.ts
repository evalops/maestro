import { describe, expect, it } from "vitest";
import {
	type PromptDefinition,
	parsePromptArgs,
	renderPrompt,
	validatePromptArgs,
} from "../../src/commands/prompts.js";

describe("prompts", () => {
	describe("parsePromptArgs", () => {
		it("parses positional arguments", () => {
			const result = parsePromptArgs("foo bar baz");
			expect(result.positional).toEqual(["foo", "bar", "baz"]);
			expect(result.named).toEqual({});
		});

		it("parses named arguments", () => {
			const result = parsePromptArgs("FILE=main.ts FOCUS=security");
			expect(result.positional).toEqual([]);
			expect(result.named).toEqual({ FILE: "main.ts", FOCUS: "security" });
		});

		it("parses mixed positional and named arguments", () => {
			const result = parsePromptArgs("arg1 FILE=main.ts arg2 FOCUS=security");
			expect(result.positional).toEqual(["arg1", "arg2"]);
			expect(result.named).toEqual({ FILE: "main.ts", FOCUS: "security" });
		});

		it("handles quoted values with spaces", () => {
			const result = parsePromptArgs('TITLE="Fix the bug" FILE=main.ts');
			expect(result.named).toEqual({ TITLE: "Fix the bug", FILE: "main.ts" });
		});

		it("handles single-quoted values", () => {
			const result = parsePromptArgs("TITLE='Fix the bug'");
			expect(result.named).toEqual({ TITLE: "Fix the bug" });
		});

		it("handles empty string", () => {
			const result = parsePromptArgs("");
			expect(result.positional).toEqual([]);
			expect(result.named).toEqual({});
		});
	});

	describe("validatePromptArgs", () => {
		const createPrompt = (namedPlaceholders: string[]): PromptDefinition => ({
			name: "test",
			body: "test body",
			sourcePath: "/test/prompt.md",
			sourceType: "user",
			namedPlaceholders,
			hasPositionalPlaceholders: false,
		});

		it("returns null when all required args are provided", () => {
			const prompt = createPrompt(["FILE", "FOCUS"]);
			const args = {
				positional: [],
				named: { FILE: "main.ts", FOCUS: "security" },
			};
			expect(validatePromptArgs(prompt, args)).toBeNull();
		});

		it("returns error when required args are missing", () => {
			const prompt = createPrompt(["FILE", "FOCUS"]);
			const args = { positional: [], named: { FILE: "main.ts" } };
			const result = validatePromptArgs(prompt, args);
			expect(result).toContain("FOCUS");
		});

		it("returns null when no placeholders required", () => {
			const prompt = createPrompt([]);
			const args = { positional: [], named: {} };
			expect(validatePromptArgs(prompt, args)).toBeNull();
		});
	});

	describe("renderPrompt", () => {
		const createPrompt = (
			body: string,
			hasPositional = false,
		): PromptDefinition => ({
			name: "test",
			body,
			sourcePath: "/test/prompt.md",
			sourceType: "user",
			namedPlaceholders: [],
			hasPositionalPlaceholders: hasPositional,
		});

		it("substitutes named placeholders", () => {
			const prompt = createPrompt("Review $FILE focusing on $FOCUS");
			const args = {
				positional: [],
				named: { FILE: "main.ts", FOCUS: "security" },
			};
			expect(renderPrompt(prompt, args)).toBe(
				"Review main.ts focusing on security",
			);
		});

		it("substitutes positional placeholders", () => {
			const prompt = createPrompt("Args: $1, $2, $3", true);
			const args = { positional: ["foo", "bar", "baz"], named: {} };
			expect(renderPrompt(prompt, args)).toBe("Args: foo, bar, baz");
		});

		it("substitutes $ARGUMENTS placeholder", () => {
			const prompt = createPrompt("All args: $ARGUMENTS", true);
			const args = { positional: ["foo", "bar", "baz"], named: {} };
			expect(renderPrompt(prompt, args)).toBe("All args: foo bar baz");
		});

		it("handles $$ escape sequence", () => {
			const prompt = createPrompt("Cost is $$100");
			const args = { positional: [], named: {} };
			expect(renderPrompt(prompt, args)).toBe("Cost is $100");
		});

		it("leaves unmatched positional placeholders empty", () => {
			const prompt = createPrompt("Args: $1, $2, $3", true);
			const args = { positional: ["foo"], named: {} };
			expect(renderPrompt(prompt, args)).toBe("Args: foo, , ");
		});

		it("handles complex mixed substitution", () => {
			const prompt = createPrompt(
				"Review $FILE for $1 issues. Focus: $FOCUS. All: $ARGUMENTS. Cost: $$50",
				true,
			);
			const args = {
				positional: ["security", "performance"],
				named: { FILE: "app.ts", FOCUS: "auth" },
			};
			expect(renderPrompt(prompt, args)).toBe(
				"Review app.ts for security issues. Focus: auth. All: security performance. Cost: $50",
			);
		});
	});
});
