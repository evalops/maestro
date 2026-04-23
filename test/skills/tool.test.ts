import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSkillsDownstreamForTests } from "../../src/skills/service-client.js";
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
		resetSkillsDownstreamForTests();
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		vi.unstubAllGlobals();
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

		it("includes skills from the configured skills service", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						skills: [
							{
								id: "remote-1",
								workspaceId: "workspace-1",
								name: "incident-review",
								description: "Review incident reports",
								scope: "SKILL_SCOPE_WORKSPACE",
								content: "Summarize impact and remediation.",
								currentVersion: 3,
								tags: ["ops", "incidents"],
							},
						],
						total: 1,
					}),
					{ status: 200 },
				),
			);
			vi.stubGlobal("fetch", fetchMock);

			const tool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService: {
					baseUrl: "https://skills.test/",
					maxAttempts: 1,
					timeoutMs: 500,
					token: "skills-token",
					workspaceId: "workspace-1",
				},
			});
			const result = await tool.execute("test-service-list", { skill: "list" });
			const text = getResultText(result);

			expect(text).toContain("Available Skills (1)");
			expect(text).toContain("incident-review");
			expect(text).toContain("(service)");
			expect(text).toContain("[ops, incidents]");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("https://skills.test/skills.v1.SkillService/List");
			expect(init.headers).toMatchObject({
				Authorization: "Bearer skills-token",
				"Connect-Protocol-Version": "1",
				"Content-Type": "application/json",
				"X-Surface": "maestro",
			});
			expect(JSON.parse(String(init.body))).toMatchObject({
				workspaceId: "workspace-1",
				limit: 100,
				offset: 0,
			});
		});
	});

	describe("execute - load skill", () => {
		it("loads skill by exact name", async () => {
			createTestSkill("my-skill", "Test skill", "# Instructions\n\nDo this.");

			const tool = createSkillTool(testDir, { includeSystem: false });
			const result = await tool.execute("test-3", { skill: "my-skill" });
			const text = getResultText(result);
			const skillMetadata = (
				result.details as
					| {
							skillMetadata?: {
								name: string;
								hash: string;
								source: string;
							};
					  }
					| undefined
			)?.skillMetadata;

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Skill: my-skill");
			expect(text).toContain("> Test skill");
			expect(text).toContain("# Instructions");
			expect(text).toContain("Do this.");
			expect(skillMetadata).toMatchObject({
				name: "my-skill",
				source: "project",
			});
			expect(skillMetadata?.hash).toMatch(/^[a-f0-9]{64}$/u);
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

		it("loads skill instructions from the configured skills service", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						skills: [
							{
								id: "remote-1",
								workspaceId: "workspace-1",
								name: "incident-review",
								description: "Review incident reports",
								scope: "SKILL_SCOPE_WORKSPACE",
								content: "Summarize impact and remediation.",
							},
						],
						total: 1,
					}),
					{ status: 200 },
				),
			);
			vi.stubGlobal("fetch", fetchMock);

			const tool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService: {
					baseUrl: "https://skills.test",
					maxAttempts: 1,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});
			const result = await tool.execute("test-service-load", {
				skill: "incident-review",
			});
			const text = getResultText(result);
			const skillMetadata = (
				result.details as
					| {
							skillMetadata?: {
								name: string;
								artifactId?: string;
								version?: string;
								source: string;
								scope?: string;
							};
					  }
					| undefined
			)?.skillMetadata;

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Skill: incident-review");
			expect(text).toContain("> Review incident reports");
			expect(text).toContain("Summarize impact and remediation.");
			expect(skillMetadata).toMatchObject({
				name: "incident-review",
				artifactId: "remote-1",
				source: "service",
				scope: "workspace",
			});
		});

		it("falls back to local skills when the optional skills service fails", async () => {
			createTestSkill("local-only", "Local skill", "Local instructions.");
			const fetchMock = vi
				.fn()
				.mockRejectedValue(new Error("connection refused"));
			vi.stubGlobal("fetch", fetchMock);

			const tool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService: {
					baseUrl: "https://skills.test",
					maxAttempts: 1,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});
			const result = await tool.execute("test-service-fallback", {
				skill: "local-only",
			});
			const text = getResultText(result);

			expect(result.isError).toBeUndefined();
			expect(text).toContain("# Skill: local-only");
			expect(text).toContain("Local instructions.");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("reports an error when the required skills service fails", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValue(new Error("connection refused"));
			vi.stubGlobal("fetch", fetchMock);

			const tool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService: {
					baseUrl: "https://skills.test",
					maxAttempts: 1,
					required: true,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});
			const result = await tool.execute("test-service-required", {
				skill: "list",
			});
			const text = getResultText(result);

			expect(result.isError).toBe(true);
			expect(text).toContain("Skills service unavailable");
		});

		it("retries after a required skills service failure", async () => {
			createTestSkill("local-only", "Local skill", "Local instructions.");
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							skills: [],
							total: 0,
						}),
						{ status: 200 },
					),
				);
			vi.stubGlobal("fetch", fetchMock);

			const tool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService: {
					baseUrl: "https://skills.test",
					maxAttempts: 1,
					required: true,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
			});

			const firstResult = await tool.execute("test-service-required-retry-1", {
				skill: "list",
			});
			const secondResult = await tool.execute("test-service-required-retry-2", {
				skill: "list",
			});
			const firstText = getResultText(firstResult);
			const secondText = getResultText(secondResult);

			expect(firstResult.isError).toBe(true);
			expect(firstText).toContain("Skills service unavailable");
			expect(secondResult.isError).toBeUndefined();
			expect(secondText).toContain("local-only");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("opens the configured circuit after optional skills service failures", async () => {
			createTestSkill("local-only", "Local skill", "Local instructions.");
			const fetchMock = vi.fn(
				async () => new Response("unavailable", { status: 503 }),
			);
			vi.stubGlobal("fetch", fetchMock);
			const skillsService = {
				baseUrl: "https://skills.test",
				circuitFailureThreshold: 1,
				circuitResetTimeoutMs: 60_000,
				circuitSuccessThreshold: 1,
				maxAttempts: 1,
				timeoutMs: 500,
				workspaceId: "workspace-1",
			};

			const firstTool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService,
			});
			const secondTool = createSkillTool(testDir, {
				includeSystem: false,
				skillsService,
			});

			const firstResult = await firstTool.execute("test-service-circuit-1", {
				skill: "list",
			});
			const secondResult = await secondTool.execute("test-service-circuit-2", {
				skill: "list",
			});

			expect(firstResult.isError).toBeUndefined();
			expect(secondResult.isError).toBeUndefined();
			expect(getResultText(firstResult)).toContain("local-only");
			expect(getResultText(secondResult)).toContain("local-only");
			expect(fetchMock).toHaveBeenCalledTimes(1);
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
