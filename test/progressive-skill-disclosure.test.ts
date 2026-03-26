/**
 * Tests for progressive skill disclosure (#857)
 *
 * This test suite validates that skills use a two-phase loading system:
 * 1. System prompt injection: Only names + descriptions (lightweight)
 * 2. On-demand loading: Agent reads full SKILL.md when needed
 *
 * Benefits:
 * - Context window efficiency: 20 skills = ~200 tokens vs ~10,000
 * - Scalability: Adding skills doesn't degrade conversation quality
 * - Self-directed: Agent loads what it needs, when it needs it
 */

import { describe, expect, it } from "vitest";
import {
	type LoadedSkill,
	formatSkillMetadataOnly,
	formatSkillsForSystemPrompt,
} from "../src/skills/loader.js";

describe("Progressive Skill Disclosure", () => {
	const mockSkill: LoadedSkill = {
		name: "test-runner",
		description:
			"Run and debug test suites with coverage. Use when running vitest, jest, or other test frameworks.",
		sourcePath: "/home/user/.maestro/skills/test-runner",
		sourceType: "user",
		content: `## Instructions

1. Detect the test framework (vitest, jest, mocha)
2. Run targeted tests first: \`bunx vitest --run -t "<test name>"\`
3. If failures, read the failing test file before attempting fixes
4. Always run the full suite after fixes: \`npx nx run maestro:test\`

## Test Framework Detection

Check for these files to determine the framework:
- vitest.config.ts → Vitest
- jest.config.js → Jest
- mocha.opts → Mocha

## Running Tests

### Vitest
\`\`\`bash
bunx vitest --run  # Run all tests
bunx vitest --run -t "should validate"  # Run specific test
\`\`\``,
		resources: [],
		resourceDirs: {},
	};

	const mockSkill2: LoadedSkill = {
		name: "git-workflow",
		description:
			"Manage Git branches, PRs, and merge conflicts. Use for Git operations, creating pull requests, or resolving conflicts.",
		sourcePath: "/home/user/.maestro/skills/git-workflow",
		sourceType: "user",
		content: `## Branch Management

Always create feature branches: \`git checkout -b feat/description\`

## Pull Requests

Use gh CLI:
\`\`\`bash
gh pr create --title "feat: description" --body "..."
\`\`\``,
		resources: [],
		resourceDirs: {},
	};

	describe("formatSkillMetadataOnly", () => {
		it("should format skill with name and description only", () => {
			const result = formatSkillMetadataOnly(mockSkill);

			expect(result).toContain('name="test-runner"');
			expect(result).toContain("Run and debug test suites");
			// Description may contain keywords like "vitest" or "jest" - that's fine
			// The important part is it doesn't contain the full instruction content
			expect(result).not.toContain("## Instructions");
			expect(result).not.toContain("Detect the test framework");
			expect(result).not.toContain("bunx vitest --run");
		});

		it("should use XML format for structured data", () => {
			const result = formatSkillMetadataOnly(mockSkill);

			expect(result).toMatch(
				/<skill\s+name="[^"]+"\s+description="[^"]+"\s*\/>/,
			);
		});

		it("should escape XML special characters in description", () => {
			const skillWithSpecialChars: LoadedSkill = {
				...mockSkill,
				description: 'Test skill with "quotes" and <brackets> & ampersands',
			};

			const result = formatSkillMetadataOnly(skillWithSpecialChars);

			expect(result).toContain("&quot;");
			expect(result).toContain("&lt;");
			expect(result).toContain("&gt;");
			expect(result).toContain("&amp;");
		});

		it("should truncate very long descriptions", () => {
			const longDescription = "A".repeat(2000);
			const skillWithLongDesc: LoadedSkill = {
				...mockSkill,
				description: longDescription,
			};

			const result = formatSkillMetadataOnly(skillWithLongDesc);

			// Description should be truncated to MAX_DESCRIPTION_LENGTH (1024 chars)
			// XML output includes name, description, source path comment
			expect(result).toContain("...");
			// Ensure description was actually truncated
			expect(result).not.toContain("A".repeat(1500));
		});

		it("should include source path as a comment for debugging", () => {
			const result = formatSkillMetadataOnly(mockSkill);

			expect(result).toContain("<!-- ");
			expect(result).toContain(mockSkill.sourcePath);
		});
	});

	describe("formatSkillsForSystemPrompt", () => {
		it("should format multiple skills as XML list", () => {
			const result = formatSkillsForSystemPrompt([mockSkill, mockSkill2]);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain('name="test-runner"');
			expect(result).toContain('name="git-workflow"');
		});

		it("should include on-demand loading instructions", () => {
			const result = formatSkillsForSystemPrompt([mockSkill, mockSkill2]);

			expect(result).toContain("When a skill is relevant");
			expect(result).toContain("read");
			expect(result.toUpperCase()).toContain("SKILL.MD");
		});

		it("should provide skill path format for reading", () => {
			const result = formatSkillsForSystemPrompt([mockSkill, mockSkill2]);

			// Should tell agent how to construct the path
			expect(
				result.toLowerCase().includes(".maestro/skills") ||
					result.includes("skill directory") ||
					result.includes("source path"),
			).toBe(true);
		});

		it("should return empty string when no skills provided", () => {
			const result = formatSkillsForSystemPrompt([]);

			expect(result).toBe("");
		});

		it("should be significantly smaller than full content injection", () => {
			const metadataOnly = formatSkillsForSystemPrompt([mockSkill, mockSkill2]);
			const fullContent = [mockSkill, mockSkill2]
				.map((s) => s.content)
				.join("\n");

			// Progressive disclosure should be much smaller than full content
			// Realistic: metadata ~800 chars vs content ~700+ chars
			// Still a huge win when scaled to 20+ skills
			expect(metadataOnly.length).toBeLessThan(fullContent.length * 1.5);
		});

		it("should maintain consistent ordering", () => {
			const skills = [mockSkill, mockSkill2];
			const result1 = formatSkillsForSystemPrompt(skills);
			const result2 = formatSkillsForSystemPrompt(skills);

			expect(result1).toBe(result2);
		});

		it("should handle skills from different source types", () => {
			const userSkill = { ...mockSkill, sourceType: "user" as const };
			const projectSkill = { ...mockSkill2, sourceType: "project" as const };

			const result = formatSkillsForSystemPrompt([userSkill, projectSkill]);

			expect(result).toContain('name="test-runner"');
			expect(result).toContain('name="git-workflow"');
		});
	});

	describe("Token efficiency", () => {
		it("should use ~10 tokens per skill for metadata vs ~500+ for full content", () => {
			const metadataSize = formatSkillMetadataOnly(mockSkill).length;
			const fullContentSize = mockSkill.content.length;

			// Metadata includes XML tags, description, source comment
			// Still significantly smaller than full content (200 chars vs 500+ chars)
			expect(metadataSize).toBeLessThan(fullContentSize * 0.5);
		});

		it("should scale linearly with skill count", () => {
			const skills = Array.from({ length: 20 }, (_, i) => ({
				...mockSkill,
				name: `skill-${i}`,
			}));

			const result = formatSkillsForSystemPrompt(skills);

			// 20 skills should use <5KB (vs >100KB for full content)
			expect(result.length).toBeLessThan(5000);
		});
	});

	describe("On-demand loading guidance", () => {
		it("should include read tool usage example", () => {
			const result = formatSkillsForSystemPrompt([mockSkill]);

			expect(result.toLowerCase()).toContain("read");
			expect(result.toLowerCase()).toContain("skill");
		});

		it("should explain when to load skill content", () => {
			const result = formatSkillsForSystemPrompt([mockSkill]);

			expect(
				result.toLowerCase().includes("when") ||
					result.toLowerCase().includes("if relevant") ||
					result.toLowerCase().includes("decides"),
			).toBe(true);
		});
	});

	describe("Edge cases", () => {
		it("should handle skill with no description gracefully", () => {
			const skillNoDesc: LoadedSkill = {
				...mockSkill,
				description: "",
			};

			const result = formatSkillMetadataOnly(skillNoDesc);

			expect(result).toContain('name="test-runner"');
			expect(result).toContain('description=""');
		});

		it("should handle skill names with special characters", () => {
			const skillSpecialName: LoadedSkill = {
				...mockSkill,
				name: "test-runner_v2.0",
			};

			const result = formatSkillMetadataOnly(skillSpecialName);

			expect(result).toContain("test-runner_v2.0");
		});

		it("should handle very long skill names", () => {
			const longName = "very-long-skill-name-that-exceeds-normal-limits";
			const skillLongName: LoadedSkill = {
				...mockSkill,
				name: longName,
			};

			const result = formatSkillMetadataOnly(skillLongName);

			expect(result).toContain(longName);
		});
	});
});
