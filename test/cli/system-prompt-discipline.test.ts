import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/cli/system-prompt.js";

describe("bundled prompt engineering discipline", () => {
	it("uses a strong agent identity and an engineering-discipline section", () => {
		const prompt = buildSystemPrompt(undefined, []);
		expect(prompt).toContain(
			"You are Maestro, an expert software engineering agent",
		);
		expect(prompt).toContain("# Engineering discipline");
		expect(prompt).toContain("## Following conventions");
		expect(prompt).toContain("Never assume a package is available");
		expect(prompt).toContain("## Doing the task");
	});

	it("adds verification discipline when mutation tools are available", () => {
		const withMutation = buildSystemPrompt(undefined, ["edit", "bash"]);
		expect(withMutation).toContain("## Verifying your work");
		expect(withMutation).toContain("not finished until it is verified");
		expect(withMutation).toContain("unless the user explicitly waives them");
		expect(withMutation.match(/project's validators/g)).toHaveLength(1);

		const readOnly = buildSystemPrompt(undefined, ["read"]);
		expect(readOnly).not.toContain("## Verifying your work");
	});

	it("adds single-in-progress todo discipline only when the todo tool exists", () => {
		const withTodo = buildSystemPrompt(undefined, ["todo"]);
		expect(withTodo).toContain("Keep exactly one item in_progress");

		const withoutTodo = buildSystemPrompt(undefined, ["read", "edit"]);
		expect(withoutTodo).not.toContain("Keep exactly one item in_progress");
	});
});
