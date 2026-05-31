import { formatDelegation } from "@evalops/contracts";
import { describe, expect, it } from "vitest";

describe("formatDelegation", () => {
	it("formats every delegation section in a stable order", () => {
		const prompt = formatDelegation({
			goal: "Fix the broken workflow.",
			context: "The caller saw CI fail on main.",
			task: "Inspect the failing test and patch the narrow cause.",
			evidence: ["test/agent/workflow.test.ts", "CI run 123"],
			validation: "Run the focused workflow test.",
			stoppingCondition: "Stop after the test passes and summarize the patch.",
		});

		expect(prompt).toBe(
			[
				"## Goal",
				"Fix the broken workflow.",
				"",
				"## Context",
				"The caller saw CI fail on main.",
				"",
				"## Task",
				"Inspect the failing test and patch the narrow cause.",
				"",
				"## Evidence",
				"- test/agent/workflow.test.ts",
				"- CI run 123",
				"",
				"## Validation",
				"Run the focused workflow test.",
				"",
				"## Stopping Condition",
				"Stop after the test passes and summarize the patch.",
			].join("\n"),
		);
	});

	it("fills empty fields with explicit placeholders", () => {
		expect(
			formatDelegation({
				goal: "  ",
				context: "",
				task: "",
				evidence: ["", "  "],
				validation: "",
				stoppingCondition: "",
			}),
		).toContain("- No specific evidence provided.");
	});

	it("escapes nested top-level headings inside delegated content", () => {
		const prompt = formatDelegation({
			goal: "Keep six headings\n## nested goal heading",
			context: "Context",
			task: "Task",
			evidence: ["Memory context:\n## Learned from prior work\n- add tests"],
			validation: "Validation",
			stoppingCondition: "Stop",
		});

		expect(prompt.match(/^## /gm)).toHaveLength(6);
		expect(prompt).toContain("\\## nested goal heading");
		expect(prompt).toContain("  \\## Learned from prior work");
	});
});
