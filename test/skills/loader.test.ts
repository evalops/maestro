import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findSkill,
	formatSkillForInjection,
	formatSkillListItem,
	getSkillsSummary,
	loadSkills,
	searchSkills,
} from "../../src/skills/loader.js";

describe("skills/loader", () => {
	let testDir: string;
	let skillsDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `composer-skills-test-${Date.now()}`);
		skillsDir = join(testDir, ".composer", "skills");
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("loadSkills", () => {
		it("returns empty array when no skills directory exists", () => {
			const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
			const { skills } = loadSkills(emptyDir);
			expect(skills).toEqual([]);
		});

		it("returns empty array when skills directory is empty", () => {
			const { skills } = loadSkills(testDir);
			expect(skills).toEqual([]);
		});

		it("loads a valid skill with frontmatter", () => {
			const skillDir = join(skillsDir, "test-skill");
			mkdirSync(skillDir, { recursive: true });

			const skillContent = `---
name: test-skill
description: A test skill for testing
tags:
  - testing
  - example
author: Test Author
version: 1.0.0
triggers:
  - run tests
  - test code
---

# Test Skill Instructions

This is the skill content.

## Steps

1. First step
2. Second step
`;

			writeFileSync(join(skillDir, "SKILL.md"), skillContent);

			const { skills } = loadSkills(testDir);

			expect(skills).toHaveLength(1);
			expect(skills[0]!.name).toBe("test-skill");
			expect(skills[0]!.description).toBe("A test skill for testing");
			expect(skills[0]!.tags).toEqual(["testing", "example"]);
			expect(skills[0]!.author).toBe("Test Author");
			expect(skills[0]!.version).toBe("1.0.0");
			expect(skills[0]!.triggers).toEqual(["run tests", "test code"]);
			expect(skills[0]!.sourceType).toBe("project");
			expect(skills[0]!.content).toContain("# Test Skill Instructions");
		});

		it("discovers bundled resources", () => {
			const skillDir = join(skillsDir, "with-resources");
			mkdirSync(skillDir, { recursive: true });

			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: with-resources
description: Skill with bundled resources
---

Use the bundled scripts.
`,
			);

			writeFileSync(join(skillDir, "setup.sh"), "#!/bin/bash\necho hello");
			writeFileSync(join(skillDir, "template.hbs"), "<div>{{content}}</div>");
			writeFileSync(join(skillDir, "reference.md"), "# Reference docs");

			const { skills } = loadSkills(testDir);

			expect(skills).toHaveLength(1);
			expect(skills[0]!.resources).toHaveLength(3);

			const resourceNames = skills[0]!.resources.map((r) => r.name).sort();
			expect(resourceNames).toEqual([
				"reference.md",
				"setup.sh",
				"template.hbs",
			]);

			const scriptResource = skills[0]!.resources.find(
				(r) => r.name === "setup.sh",
			);
			expect(scriptResource?.type).toBe("script");

			const templateResource = skills[0]!.resources.find(
				(r) => r.name === "template.hbs",
			);
			expect(templateResource?.type).toBe("template");

			const referenceResource = skills[0]!.resources.find(
				(r) => r.name === "reference.md",
			);
			expect(referenceResource?.type).toBe("reference");
		});

		it("skips directories without SKILL.md", () => {
			const validDir = join(skillsDir, "valid");
			const invalidDir = join(skillsDir, "invalid");

			mkdirSync(validDir, { recursive: true });
			mkdirSync(invalidDir, { recursive: true });

			writeFileSync(
				join(validDir, "SKILL.md"),
				`---
name: valid
description: Valid skill
---

Content.
`,
			);

			writeFileSync(join(invalidDir, "README.md"), "# Not a skill");

			const { skills } = loadSkills(testDir);

			expect(skills).toHaveLength(1);
			expect(skills[0]!.name).toBe("valid");
		});

		it("skips skills with missing required fields", () => {
			const noNameDir = join(skillsDir, "no-name");
			const noDescDir = join(skillsDir, "no-desc");
			const validDir = join(skillsDir, "valid");

			mkdirSync(noNameDir, { recursive: true });
			mkdirSync(noDescDir, { recursive: true });
			mkdirSync(validDir, { recursive: true });

			// Missing name
			writeFileSync(
				join(noNameDir, "SKILL.md"),
				`---
description: Has description but no name
---

Content.
`,
			);

			// Missing description
			writeFileSync(
				join(noDescDir, "SKILL.md"),
				`---
name: has-name
---

Content.
`,
			);

			// Valid
			writeFileSync(
				join(validDir, "SKILL.md"),
				`---
name: valid
description: Has both
---

Content.
`,
			);

			const { skills } = loadSkills(testDir);

			expect(skills).toHaveLength(1);
			expect(skills[0]!.name).toBe("valid");
		});

		it("loads multiple skills", () => {
			for (let i = 1; i <= 3; i++) {
				const dir = join(skillsDir, `skill-${i}`);
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "SKILL.md"),
					`---
name: skill-${i}
description: Skill number ${i}
---

Content for skill ${i}.
`,
				);
			}

			const { skills } = loadSkills(testDir);

			expect(skills).toHaveLength(3);
			const names = skills.map((s) => s.name).sort();
			expect(names).toEqual(["skill-1", "skill-2", "skill-3"]);
		});
	});

	describe("findSkill", () => {
		it("finds skill by exact name (case-insensitive)", () => {
			const skillDir = join(skillsDir, "my-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: my-skill
description: Test
---

Content.
`,
			);

			const { skills } = loadSkills(testDir);

			expect(findSkill(skills, "My-Skill")).toBeDefined();
			expect(findSkill(skills, "my-skill")).toBeDefined();
			expect(findSkill(skills, "MY-SKILL")).toBeDefined();
			expect(findSkill(skills, "other")).toBeUndefined();
		});
	});

	describe("searchSkills", () => {
		it("searches by name, description, tags, and triggers", () => {
			const skillDir = join(skillsDir, "react-testing");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: react-testing
description: Testing React components with Jest
tags:
  - frontend
  - testing
triggers:
  - test react
  - unit test
---

Content.
`,
			);

			const { skills } = loadSkills(testDir);

			expect(searchSkills(skills, "react")).toHaveLength(1);
			expect(searchSkills(skills, "jest")).toHaveLength(1);
			expect(searchSkills(skills, "frontend")).toHaveLength(1);
			expect(searchSkills(skills, "unit test")).toHaveLength(1);
			expect(searchSkills(skills, "python")).toHaveLength(0);
		});
	});

	describe("formatSkillListItem", () => {
		it("formats skill for list display", () => {
			const skillDir = join(skillsDir, "format-test");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: format-test
description: Test formatting
tags:
  - tag1
  - tag2
---

Content.
`,
			);

			const { skills } = loadSkills(testDir);
			const formatted = formatSkillListItem(skills[0]!);

			expect(formatted).toContain("format-test");
			expect(formatted).toContain("(project)");
			expect(formatted).toContain("tag1");
			expect(formatted).toContain("Test formatting");
		});
	});

	describe("formatSkillForInjection", () => {
		it("formats skill content for conversation injection", () => {
			const skillDir = join(skillsDir, "inject-test");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: inject-test
description: Test injection
tags:
  - test
---

## Workflow

1. Step one
2. Step two
`,
			);

			writeFileSync(join(skillDir, "helper.sh"), "#!/bin/bash");

			const { skills } = loadSkills(testDir);
			const formatted = formatSkillForInjection(skills[0]!);

			expect(formatted).toContain("# Skill: inject-test");
			expect(formatted).toContain("> Test injection");
			expect(formatted).toContain("**Tags:** test");
			expect(formatted).toContain("## Bundled Resources");
			expect(formatted).toContain("helper.sh");
			expect(formatted).toContain("## Instructions");
			expect(formatted).toContain("## Workflow");
		});
	});

	describe("getSkillsSummary", () => {
		it("returns empty string when no skills", () => {
			expect(getSkillsSummary([])).toBe("");
		});

		it("formats skills summary for system prompt", () => {
			const skillDir = join(skillsDir, "summary-test");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: summary-test
description: Test summary
tags:
  - example
triggers:
  - do something
---

Content.
`,
			);

			const { skills } = loadSkills(testDir);
			const summary = getSkillsSummary(skills);

			expect(summary).toContain("## Available Skills");
			expect(summary).toContain("**summary-test**");
			expect(summary).toContain("[example]");
			expect(summary).toContain("Test summary");
			expect(summary).toContain("Triggers: do something");
		});
	});
});
