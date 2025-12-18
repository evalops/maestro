import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPrompt, loadPrompts } from "../../src/commands/catalog.js";

describe("commands/prompts frontmatter", () => {
	const originalHome = process.env.HOME;
	let homeDir: string;
	let workspaceDir: string;

	beforeEach(() => {
		homeDir = join(tmpdir(), `composer-prompts-home-${Date.now()}`);
		workspaceDir = join(tmpdir(), `composer-prompts-workspace-${Date.now()}`);
		process.env.HOME = homeDir;
		mkdirSync(join(homeDir, ".composer", "prompts"), { recursive: true });
		mkdirSync(join(workspaceDir, ".composer", "prompts"), { recursive: true });
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	it("supports name override and aliases", () => {
		writeFileSync(
			join(homeDir, ".composer", "prompts", "review.md"),
			`---
name: pr-review
description: Review the current PR
aliases:
  - reviewpr
  - prr
---

Review the PR.
`,
		);

		const prompts = loadPrompts(workspaceDir);
		expect(prompts.map((p) => p.name)).toContain("pr-review");

		expect(findPrompt(prompts, "pr-review")?.name).toBe("pr-review");
		expect(findPrompt(prompts, "reviewpr")?.name).toBe("pr-review");
		expect(findPrompt(prompts, "prr")?.name).toBe("pr-review");
	});
});
