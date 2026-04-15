import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPrompt, loadPrompts } from "../../src/commands/catalog.js";
import { clearResolvedPackageSourceCache } from "../../src/packages/index.js";

describe("commands/prompts frontmatter", () => {
	const originalHome = process.env.HOME;
	let homeDir: string;
	let workspaceDir: string;

	beforeEach(() => {
		homeDir = join(tmpdir(), `composer-prompts-home-${Date.now()}`);
		workspaceDir = join(tmpdir(), `composer-prompts-workspace-${Date.now()}`);
		process.env.HOME = homeDir;
		mkdirSync(join(homeDir, ".maestro", "prompts"), { recursive: true });
		mkdirSync(join(workspaceDir, ".maestro", "prompts"), { recursive: true });
		clearResolvedPackageSourceCache();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		clearResolvedPackageSourceCache();
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	it("supports name override and aliases", () => {
		writeFileSync(
			join(homeDir, ".maestro", "prompts", "review.md"),
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

	it("loads prompts from configured packages relative to project config", () => {
		const packageDir = join(workspaceDir, "vendor", "prompt-pack");
		const promptDir = join(packageDir, "prompts", "release-pack");
		mkdirSync(promptDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/prompt-pack",
				keywords: ["maestro-package"],
				maestro: {
					prompts: ["./prompts"],
				},
			}),
		);
		writeFileSync(
			join(promptDir, "prompt.md"),
			`---
name: package-release
description: Prompt loaded from a package
---

Draft the release note.
`,
		);
		writeFileSync(
			join(workspaceDir, ".maestro", "config.toml"),
			'packages = ["../vendor/prompt-pack"]\n',
		);

		const prompts = loadPrompts(workspaceDir);

		expect(findPrompt(prompts, "package-release")?.sourceType).toBe("project");
		expect(findPrompt(prompts, "package-release")?.description).toBe(
			"Prompt loaded from a package",
		);
	});

	it("loads prompts from configured git packages", () => {
		const repoDir = join(workspaceDir, "vendor", "prompt-pack-git");
		const promptDir = join(repoDir, "prompts", "release-pack");
		mkdirSync(promptDir, { recursive: true });
		writeFileSync(
			join(repoDir, "package.json"),
			JSON.stringify({
				name: "@test/prompt-pack-git",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: {
					prompts: ["./prompts"],
				},
			}),
		);
		writeFileSync(
			join(promptDir, "prompt.md"),
			`---
name: git-release
description: Prompt loaded from a git package
---

Draft the git-based release note.
`,
		);
		createCommittedGitRepo(repoDir);
		writeFileSync(
			join(workspaceDir, ".maestro", "config.toml"),
			`packages = ["git:${repoDir}"]\n`,
		);

		const prompts = loadPrompts(workspaceDir);

		expect(findPrompt(prompts, "git-release")?.sourceType).toBe("project");
		expect(findPrompt(prompts, "git-release")?.description).toBe(
			"Prompt loaded from a git package",
		);
	});

	it("reuses cached prompt catalogs until prompt files change", () => {
		const promptPath = join(homeDir, ".maestro", "prompts", "review.md");
		writeFileSync(
			promptPath,
			`---
description: Initial description
---

Review the PR.
`,
		);

		const first = loadPrompts(workspaceDir);
		const second = loadPrompts(workspaceDir);

		expect(second).toBe(first);
		expect(first[0]?.description).toBe("Initial description");

		writeFileSync(
			promptPath,
			`---
description: Updated description
---

Review the PR.
`,
		);
		const updatedTime = new Date(statSync(promptPath).mtimeMs + 10_000);
		utimesSync(promptPath, updatedTime, updatedTime);

		const third = loadPrompts(workspaceDir);
		expect(third).not.toBe(first);
		expect(third[0]?.description).toBe("Updated description");
	});
});

function createCommittedGitRepo(dir: string): void {
	execFileSync("git", ["init", "--initial-branch=main"], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.email", "maestro@example.com"], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Maestro Tests"], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["add", "."], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["commit", "-m", "initial"], {
		cwd: dir,
		stdio: "ignore",
	});
}
