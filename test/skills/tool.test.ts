import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillTool } from "../../src/skills/tool.js";

/**
 * Extract text content from tool result.
 */
function getResultText(result: { content: { type: string; text?: string }[] }) {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

describe("skills/tool", () => {
	let testDir: string;
	let skillsDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `composer-skills-tool-test-${Date.now()}`);
		skillsDir = join(testDir, ".maestro", "skills");
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	function createTestSkill(name: string, description: string, content: string) {
		const dir = join(skillsDir, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---
name: ${name}
description: ${description}
---

${content}
`,
		);
	}

	describe("createSkillTool", () => {
		it("creates a valid tool definition", () => {
			const tool = createSkillTool(testDir, { includeSystem: false });

			expect(tool.name).toBe("Skill");
			expect(tool.description).toContain("specialized skill");
			expect(tool.parameters).toBeDefined();
		});
	});

	describe("execute - list", () => {
		it("returns message when no skills available", async () => {
			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-1", { skill: "list" });
			const text = getResultText(result);

			expect(text).toContain("No skills available");
			expect(text).toContain(".maestro/skills/");
		});

		it("lists available skills", async () => {
			createTestSkill("skill-a", "First skill", "Content A");
			createTestSkill("skill-b", "Second skill", "Content B");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-2", { skill: "list" });
			const text = getResultText(result);

			expect(text).toContain("Available Skills (2)");
			expect(text).toContain("skill-a");
			expect(text).toContain("skill-b");
			expect(text).toContain("First skill");
			expect(text).toContain("Second skill");
		});
	});

	describe("execute - load skill", () => {
		it("loads skill by exact name", async () => {
			createTestSkill("my-skill", "Test skill", "# Instructions\n\nDo this.");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-3", { skill: "my-skill" });
			const text = getResultText(result);

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Skill: my-skill");
			expect(text).toContain("> Test skill");
			expect(text).toContain("# Instructions");
			expect(text).toContain("Do this.");
		});

		it("loads skill case-insensitively", async () => {
			createTestSkill("camelcase", "Test", "Content");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-4", { skill: "CamelCase" });
			const text = getResultText(result);

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Skill: camelcase");
		});

		it("returns error for unknown skill", async () => {
			createTestSkill("known", "Known skill", "Content");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-5", { skill: "unknown" });
			const text = getResultText(result);

			expect(result.isError).toBe(true);
			expect(text).toContain('Skill "unknown" not found');
			expect(text).toContain("known");
		});

		it("returns error for empty skill name", async () => {
			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-6", { skill: "" });
			const text = getResultText(result);

			expect(result.isError).toBe(true);
			expect(text).toContain("skill name is required");
		});
	});

	describe("execute - search", () => {
		it("finds skill by partial match when unique", async () => {
			createTestSkill("react-testing", "Testing React components", "Content");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-7", { skill: "react" });
			const text = getResultText(result);

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Skill: react-testing");
		});

		it("shows multiple matches when ambiguous", async () => {
			createTestSkill("react-testing", "Testing React", "Content");
			createTestSkill("react-components", "Building React", "Content");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-8", { skill: "react" });
			const text = getResultText(result);

			expect(result.isError).toBeUndefined();
			expect(text).toContain("Multiple skills match");
			expect(text).toContain("react-testing");
			expect(text).toContain("react-components");
		});
	});

	describe("execute - args substitution", () => {
		it("substitutes args in skill content", async () => {
			const dir = join(skillsDir, "with-args");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---
name: with-args
description: Skill with arguments
---

# Setup for {{project}}

Run the following command:

\`\`\`bash
cd {{project}} && npm install
\`\`\`
`,
			);

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-9", {
				skill: "with-args",
				args: { project: "my-app" },
			});
			const text = getResultText(result);

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Setup for my-app");
			expect(text).toContain("cd my-app && npm install");
			expect(text).not.toContain("{{project}}");
		});
	});

	describe("bundled resources", () => {
		it("includes resource paths in skill output", async () => {
			const dir = join(skillsDir, "with-resources");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---
name: with-resources
description: Skill with resources
---

Use the bundled scripts.
`,
			);
			writeFileSync(join(dir, "setup.sh"), "#!/bin/bash\necho done");
			writeFileSync(join(dir, "config.json"), '{"key": "value"}');

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-10", {
				skill: "with-resources",
			});
			const text = getResultText(result);

			expect(text).toContain("## Bundled Resources");
			expect(text).toContain("setup.sh");
			expect(text).toContain("(script)");
			expect(text).toContain("config.json");
		});
	});
});
