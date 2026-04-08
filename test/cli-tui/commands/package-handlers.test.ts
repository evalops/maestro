import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackageCommandHandler } from "../../../src/cli-tui/commands/package-handlers.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";
import { clearResolvedPackageSourceCache } from "../../../src/packages/index.js";

const tempDirs: string[] = [];
const originalMaestroHome = process.env.MAESTRO_HOME;

function createTempDir(prefix: string): string {
	const tempDir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(tempDir);
	return tempDir;
}

function createContext(
	rawInput: string,
	argumentText = rawInput.replace(/^\/\S+\s*/, ""),
): CommandExecutionContext {
	return {
		command: { name: "package", description: "package" },
		rawInput,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

afterEach(() => {
	if (originalMaestroHome === undefined) {
		delete process.env.MAESTRO_HOME;
	} else {
		process.env.MAESTRO_HOME = originalMaestroHome;
	}
	clearResolvedPackageSourceCache();
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("package command", () => {
	it("adds a configured package to local config by default", async () => {
		const root = createTempDir("maestro-package-command-");
		mkdirSync(join(root, ".maestro"), { recursive: true });

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package add ./vendor/pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining('Added configured package "./vendor/pack"'),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("scope: local"),
		);
		expect(
			readFileSync(join(root, ".maestro", "config.local.toml"), "utf-8"),
		).toContain("../vendor/pack");
	});

	it("removes a configured package and reports fallback scope", async () => {
		const root = createTempDir("maestro-package-command-");
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);
		writeFileSync(
			join(root, ".maestro", "config.local.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package remove ./vendor/pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining('Removed configured package "./vendor/pack"'),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("fallback: still configured in project"),
		);
		expect(
			readFileSync(join(root, ".maestro", "config.local.toml"), "utf-8"),
		).toBe("");
	});

	it("lists configured packages from project config", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "vendor", "pack");
		mkdirSync(join(packageDir, "skills", "package-skill"), {
			recursive: true,
		});
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/listed-package",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = [{ source = "../vendor/pack", skills = ["package-skill"] }]\n',
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package list"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Configured Maestro Packages:"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("@test/listed-package"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Filters: skills=package-skill"),
		);
	});

	it("lists configured git packages in command output", async () => {
		const root = createTempDir("maestro-package-command-");
		process.env.MAESTRO_HOME = join(root, ".maestro-home");
		const packageDir = join(root, "vendor", "git-pack");
		mkdirSync(join(packageDir, "skills", "git-skill"), { recursive: true });
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/git-package",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		createCommittedGitRepo(packageDir);
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			`packages = ["git:${packageDir}"]\n`,
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package list"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("@test/git-package"),
		);
	});

	it("inspects a valid package from a quoted local path", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "my package");
		mkdirSync(join(packageDir, "skills", "review-skill"), { recursive: true });
		mkdirSync(join(packageDir, "prompts", "release-note"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/my-package",
				version: "1.2.3",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
					prompts: ["./prompts"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const requestRender = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender,
		});

		await handler(createContext('/plugin "./my package"'));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Maestro Package Inspection:"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Name: @test/my-package"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Skills: 1 (review-skill)"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Prompts: 1 (release-note)"),
		);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("reports validation success for a valid local package", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "pack");
		mkdirSync(join(packageDir, "extensions", "my-extension"), {
			recursive: true,
		});
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/validated-package",
				keywords: ["maestro-package"],
				maestro: {
					extensions: ["./extensions"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package validate ./pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Package validation passed."),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Extensions: 1"),
		);
	});

	it("reports missing maestro-package keyword during validation", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "pack");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/not-maestro",
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package validate ./pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining('Missing "maestro-package" keyword.'),
		);
	});

	it("reports missing manifest paths during validation", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "pack");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/missing-dirs",
				keywords: ["maestro-package"],
				maestro: {
					themes: ["./themes"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package validate ./pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("themes path does not exist: ./themes"),
		);
	});

	it("inspects a git package source", async () => {
		const root = createTempDir("maestro-package-command-");
		process.env.MAESTRO_HOME = join(root, ".maestro-home");
		const packageDir = join(root, "git-source");
		mkdirSync(join(packageDir, "skills", "git-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/inspect-git-package",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		createCommittedGitRepo(packageDir);
		const ctx = createContext(`/package inspect git:${packageDir}`);
		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(ctx);

		expect(ctx.showError).not.toHaveBeenCalled();
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Maestro Package Inspection:"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Name: @test/inspect-git-package"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Type: git"),
		);
	});

	it("refreshes a cached git package source", async () => {
		const root = createTempDir("maestro-package-command-");
		process.env.MAESTRO_HOME = join(root, ".maestro-home");
		const packageDir = join(root, "git-refresh-source");
		mkdirSync(join(packageDir, "skills", "git-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "git-skill", "SKILL.md"),
			"# Git Skill\n",
			"utf-8",
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/refresh-git-package",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		createCommittedGitRepo(packageDir);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext(`/package inspect git:${packageDir}`));

		mkdirSync(join(packageDir, "skills", "deploy-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "deploy-skill", "SKILL.md"),
			"# Deploy Skill\n",
			"utf-8",
		);
		commitGitRepoChanges(packageDir, "add deploy skill");

		await handler(createContext(`/package refresh git:${packageDir}`));
		await handler(createContext(`/package inspect git:${packageDir}`));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Package refresh completed."),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Skills: 2 (deploy-skill, git-skill)"),
		);
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
	commitGitRepoChanges(dir, "initial");
}

function commitGitRepoChanges(dir: string, message: string): void {
	execFileSync("git", ["add", "."], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["commit", "-m", message], {
		cwd: dir,
		stdio: "ignore",
	});
}
