import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills } from "../../src/skills/loader.js";
import { scaffoldSkillWithBody } from "../../src/skills/scaffolder.js";

describe("skills/scaffolder", () => {
	let workspaceDir: string;
	let baseDir: string;

	beforeEach(() => {
		workspaceDir = join(
			tmpdir(),
			`skill-scaffolder-test-${Date.now()}-${Math.random()}`,
		);
		baseDir = join(workspaceDir, ".maestro", "skills");
		mkdirSync(baseDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(workspaceDir)) {
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	describe("scaffoldSkillWithBody", () => {
		it("writes SKILL.md with frontmatter and body, returns paths", () => {
			const result = scaffoldSkillWithBody(baseDir, "incident-guidelines", {
				description: "Repo-specific incident guidelines.",
				body: "## Runbook\n\nLocation: docs/runbooks/.\n",
			});

			expect(result.name).toBe("incident-guidelines");
			expect(result.directory).toBe(join(baseDir, "incident-guidelines"));
			expect(result.skillMdPath).toBe(
				join(baseDir, "incident-guidelines", "SKILL.md"),
			);
			expect(result.files).toEqual(["SKILL.md"]);
			expect(existsSync(result.skillMdPath)).toBe(true);

			const content = readFileSync(result.skillMdPath, "utf-8");
			expect(content).toContain("---");
			expect(content).toContain('name: "incident-guidelines"');
			expect(content).toContain(
				'description: "Repo-specific incident guidelines."',
			);
			expect(content).toContain("## Runbook");
			expect(content).toContain("Location: docs/runbooks/.");
		});

		it("emits allowed-tools and builtin-tools lists when supplied", () => {
			const result = scaffoldSkillWithBody(baseDir, "scaffold-test", {
				description: "Test skill",
				body: "body",
				allowedTools: ["Bash(grep:*)", "Read"],
				builtinTools: ["read", "list"],
			});

			const content = readFileSync(result.skillMdPath, "utf-8");
			expect(content).toContain("allowed-tools:");
			expect(content).toContain('  - "Bash(grep:*)"');
			expect(content).toContain('  - "Read"');
			expect(content).toContain("builtin-tools:");
			expect(content).toContain('  - "read"');
			expect(content).toContain('  - "list"');
		});

		it("nests metadata under metadata frontmatter and keeps the skill loadable", () => {
			const result = scaffoldSkillWithBody(baseDir, "metadata-test", {
				description: "Test skill",
				body: "body",
				metadata: {
					"user-invocable": "false",
					owner: "platform-team",
				},
			});

			const content = readFileSync(result.skillMdPath, "utf-8");
			expect(content).toContain("metadata:");
			expect(content).toContain('  "user-invocable": "false"');
			expect(content).toContain('  "owner": "platform-team"');

			const { skills, errors } = loadSkills(workspaceDir, {
				includeSystem: false,
			});
			expect(errors).toEqual([]);
			expect(skills).toHaveLength(1);
			expect(skills[0]?.metadata).toEqual({
				"user-invocable": "false",
				owner: "platform-team",
			});
		});

		it("allows camelCase metadata keys used by bundled skills", () => {
			const result = scaffoldSkillWithBody(baseDir, "camel-meta", {
				description: "Test skill",
				body: "body",
				metadata: {
					artifactSchema: "evalops.maestro.skill.test.v1",
				},
			});

			const content = readFileSync(result.skillMdPath, "utf-8");
			expect(content).toContain(
				'  "artifactSchema": "evalops.maestro.skill.test.v1"',
			);
		});

		it("quotes the name so YAML-typing-bait values stay strings", () => {
			// Without quoting, valid kebab names like "true", "false", "null",
			// "yes", "no", "off" would be parsed by js-yaml as booleans/null
			// and loadSkills would reject the scaffolded skill.
			const result = scaffoldSkillWithBody(baseDir, "true", {
				description: "ok",
				body: "body",
			});

			const content = readFileSync(result.skillMdPath, "utf-8");
			expect(content).toContain('name: "true"');

			const { skills, errors } = loadSkills(workspaceDir, {
				includeSystem: false,
			});
			expect(errors).toEqual([]);
			expect(skills).toHaveLength(1);
			expect(skills[0]?.name).toBe("true");
		});

		it("quotes YAML strings so special characters cannot escape", () => {
			const result = scaffoldSkillWithBody(baseDir, "quote-test", {
				description: 'Has "quotes" and \\backslashes\\',
				body: "body",
			});

			const content = readFileSync(result.skillMdPath, "utf-8");
			expect(content).toContain(
				'description: "Has \\"quotes\\" and \\\\backslashes\\\\"',
			);
		});

		it("rejects skill names that don't match the lowercase-kebab pattern", () => {
			for (const bad of [
				"With Spaces",
				"UPPER",
				"-leading",
				"trailing-",
				"double--hyphen",
				"under_score",
				"",
			]) {
				expect(() =>
					scaffoldSkillWithBody(baseDir, bad, {
						description: "Test skill",
						body: "body",
					}),
				).toThrow(/lowercase letters, numbers, and single hyphens/);
			}
		});

		it("rejects skill names that exceed the 64-character limit", () => {
			const tooLong = "a".repeat(65);
			expect(() =>
				scaffoldSkillWithBody(baseDir, tooLong, {
					description: "Test skill",
					body: "body",
				}),
			).toThrow(/64-character limit/);
		});

		it("rejects descriptions exceeding the 1024-character cap (matching the loader)", () => {
			const longDescription = "a".repeat(1025);
			expect(() =>
				scaffoldSkillWithBody(baseDir, "long-desc", {
					description: longDescription,
					body: "body",
				}),
			).toThrow(/1024-character limit/);
		});

		it("rejects empty descriptions and empty bodies", () => {
			expect(() =>
				scaffoldSkillWithBody(baseDir, "blank-desc", {
					description: "   ",
					body: "body",
				}),
			).toThrow(/description is required/);

			expect(() =>
				scaffoldSkillWithBody(baseDir, "blank-body", {
					description: "ok",
					body: "   ",
				}),
			).toThrow(/body is required/);
		});

		it("rejects pre-existing skill directories unless force is set", () => {
			scaffoldSkillWithBody(baseDir, "existing", {
				description: "First write",
				body: "First body",
			});

			expect(() =>
				scaffoldSkillWithBody(baseDir, "existing", {
					description: "Second write",
					body: "Second body",
				}),
			).toThrow(/already exists/);

			const overwritten = scaffoldSkillWithBody(baseDir, "existing", {
				description: "Second write",
				body: "Second body",
				force: true,
			});
			const content = readFileSync(overwritten.skillMdPath, "utf-8");
			expect(content).toContain("Second body");
			expect(content).not.toContain("First body");
		});

		it("rejects empty or whitespace-only allowed-tools / builtin-tools entries", () => {
			expect(() =>
				scaffoldSkillWithBody(baseDir, "bad-tools-1", {
					description: "ok",
					body: "body",
					allowedTools: ["Read", ""],
				}),
			).toThrow(/allowed-tools.*non-empty/);

			expect(() =>
				scaffoldSkillWithBody(baseDir, "bad-tools-2", {
					description: "ok",
					body: "body",
					builtinTools: [" ", "list"],
				}),
			).toThrow(/builtin-tools.*non-empty/);
		});

		it("rejects metadata keys that don't match the frontmatter key pattern", () => {
			expect(() =>
				scaffoldSkillWithBody(baseDir, "bad-meta", {
					description: "ok",
					body: "body",
					metadata: { "Has Space": "value" },
				}),
			).toThrow(/frontmatter key/);
			expect(existsSync(join(baseDir, "bad-meta"))).toBe(false);

			expect(() =>
				scaffoldSkillWithBody(baseDir, "bad-meta-2", {
					description: "ok",
					body: "body",
					metadata: { "1-starts-with-digit": "value" },
				}),
			).toThrow(/frontmatter key/);
		});
	});
});
