/**
 * Tests for Maestro Packages - distributable extension bundles (#861)
 *
 * This test suite validates the package system for discovering, loading,
 * and filtering extensions, skills, prompts, and themes from:
 * - Local filesystem paths
 * - Git repositories
 * - npm packages (future)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearResolvedPackageSourceCache,
	discoverPackage,
	filterResources,
	isValidMaestroPackage,
	loadPackage,
	loadPackageResources,
	matchesAnyPattern,
	parsePackageSource,
	parsePackageSpec,
	refreshPackageSourceSync,
} from "../../src/packages/index.js";

describe("Maestro Packages", () => {
	let testDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = join(process.cwd(), ".test-packages");
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
		clearResolvedPackageSourceCache();
	});

	afterEach(() => {
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		clearResolvedPackageSourceCache();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Package Discovery", () => {
		it("should discover local package with maestro manifest", () => {
			// Create test package
			const pkgDir = join(testDir, "test-package");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/maestro-devtools",
					keywords: ["maestro-package"],
					maestro: {
						extensions: ["./extensions"],
						skills: ["./skills"],
					},
				}),
			);

			const discovered = discoverPackage(pkgDir);
			expect(discovered).not.toBeNull();
			expect(discovered?.isMaestroPackage).toBe(true);
			expect(discovered?.packageJson.name).toBe("@test/maestro-devtools");
			expect(discovered?.packageJson.maestro?.extensions).toEqual([
				"./extensions",
			]);
			expect(discovered?.errors).toBeUndefined();
		});

		it("should skip packages without maestro-package keyword", () => {
			const pkgDir = join(testDir, "regular-package");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/regular-lib",
					keywords: ["library"],
				}),
			);

			const discovered = discoverPackage(pkgDir);
			expect(discovered).not.toBeNull();
			expect(discovered?.isMaestroPackage).toBe(false);
		});

		it("should validate package.json maestro section schema", () => {
			const pkgDir = join(testDir, "invalid-package");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/invalid",
					keywords: ["maestro-package"],
					maestro: {
						extensions: "not-an-array", // Invalid
					},
				}),
			);

			const discovered = discoverPackage(pkgDir);
			expect(discovered).not.toBeNull();
			expect(discovered?.errors).toBeDefined();
			expect(discovered?.errors?.[0]).toContain("must be an array");
		});
	});

	describe("Package Source Resolution", () => {
		it("should resolve local filesystem paths", () => {
			const source = parsePackageSource("local:./packages/test", testDir);
			expect(source.type).toBe("local");
			expect(source).toMatchObject({
				type: "local",
				path: join(testDir, "packages/test"),
			});
		});

		it("should resolve git repository URLs", () => {
			const source = parsePackageSource("git:github.com/user/repo");
			expect(source.type).toBe("git");
			expect(source).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
			});
		});

		it("should handle git URLs with branch/tag specifiers", () => {
			const source = parsePackageSource("git:github.com/user/repo@v1.0.0");
			expect(source).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "v1.0.0",
			});
		});

		it("should reject invalid source formats", () => {
			expect(() => parsePackageSource("invalid::source")).toThrow(
				"Invalid package source format",
			);
		});

		it("should load git repositories from a local path", async () => {
			const pkgDir = join(testDir, "git-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\nReview package loaded from git.\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/git-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: {
						skills: ["./skills"],
					},
				}),
			);
			createCommittedGitRepo(pkgDir);

			const pkg = await loadPackage(`git:${pkgDir}`);
			const resources = loadPackageResources(pkg);

			expect(pkg.source.type).toBe("git");
			expect(pkg.path).not.toBe(pkgDir);
			expect(resources.skills).toHaveLength(1);
			expect(resources.skills[0]).toContain("review-skill");
		});

		it("should refresh cached git repositories when the source changes", async () => {
			const pkgDir = join(testDir, "git-refresh-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/git-refresh-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: {
						skills: ["./skills"],
					},
				}),
			);
			createCommittedGitRepo(pkgDir);

			const sourceSpec = `git:${pkgDir}`;
			const initialPackage = await loadPackage(sourceSpec);
			expect(loadPackageResources(initialPackage).skills).toHaveLength(1);

			mkdirSync(join(pkgDir, "skills", "deploy-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "deploy-skill", "SKILL.md"),
				"# Deploy Skill\n",
			);
			commitGitRepoChanges(pkgDir, "add deploy skill");

			const stalePackage = await loadPackage(sourceSpec);
			expect(loadPackageResources(stalePackage).skills).toHaveLength(1);

			refreshPackageSourceSync(parsePackageSource(sourceSpec));
			const refreshedPackage = await loadPackage(sourceSpec);
			const refreshedResources = loadPackageResources(refreshedPackage);
			expect(refreshedResources.skills).toHaveLength(2);
			expect(
				refreshedResources.skills.some((path) => path.includes("deploy-skill")),
			).toBe(true);
		});
	});

	describe("Resource Loading", () => {
		it("should load extensions from package", async () => {
			const pkgDir = join(testDir, "ext-package");
			mkdirSync(join(pkgDir, "extensions", "test-ext"), { recursive: true });
			writeFileSync(
				join(pkgDir, "extensions", "test-ext", "extension.ts"),
				"export const extension = { name: 'test' };",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/extensions",
					keywords: ["maestro-package"],
					maestro: {
						extensions: ["./extensions"],
					},
				}),
			);

			const pkg = await loadPackage(`local:${pkgDir}`);
			const resources = loadPackageResources(pkg);

			expect(resources.extensions).toHaveLength(1);
			expect(resources.extensions[0]).toContain("test-ext");
		});

		it("should load skills from package", async () => {
			const pkgDir = join(testDir, "skill-package");
			mkdirSync(join(pkgDir, "skills", "test-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "test-skill", "SKILL.md"),
				"# Test Skill\nTest skill content",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/skills",
					keywords: ["maestro-package"],
					maestro: {
						skills: ["./skills"],
					},
				}),
			);

			const pkg = await loadPackage(`local:${pkgDir}`);
			const resources = loadPackageResources(pkg);

			expect(resources.skills).toHaveLength(1);
			expect(resources.skills[0]).toContain("test-skill");
		});

		it("should load multiple resource types from one package", async () => {
			const pkgDir = join(testDir, "multi-package");
			mkdirSync(join(pkgDir, "extensions", "ext1"), { recursive: true });
			mkdirSync(join(pkgDir, "skills", "skill1"), { recursive: true });
			mkdirSync(join(pkgDir, "prompts", "prompt1"), { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/multi",
					keywords: ["maestro-package"],
					maestro: {
						extensions: ["./extensions"],
						skills: ["./skills"],
						prompts: ["./prompts"],
					},
				}),
			);

			const pkg = await loadPackage(`local:${pkgDir}`);
			const resources = loadPackageResources(pkg);

			expect(resources.extensions).toHaveLength(1);
			expect(resources.skills).toHaveLength(1);
			expect(resources.prompts).toHaveLength(1);
		});
	});

	describe("Resource Filtering", () => {
		it("should apply glob patterns to filter resources", () => {
			const resources = [
				"test-ext1",
				"test-ext2",
				"test-disabled",
				"other-ext",
			];
			const patterns = ["test-*", "!test-disabled"];

			const filtered = filterResources(resources, patterns);

			expect(filtered).toContain("test-ext1");
			expect(filtered).toContain("test-ext2");
			expect(filtered).not.toContain("test-disabled");
			expect(filtered).not.toContain("other-ext");
		});

		it("should support wildcard to include all resources", () => {
			const resources = ["skill1", "skill2", "skill3"];
			const patterns = ["*"];

			const filtered = filterResources(resources, patterns);

			expect(filtered).toHaveLength(3);
			expect(filtered).toEqual(resources);
		});

		it("should support exclusion patterns with ! prefix", () => {
			const resources = ["current-v1", "current-v2", "deprecated-v1"];
			const patterns = ["!deprecated-*"];

			const filtered = filterResources(resources, patterns);

			expect(filtered).toContain("current-v1");
			expect(filtered).toContain("current-v2");
			expect(filtered).not.toContain("deprecated-v1");
		});

		it("should apply exclusion patterns in matchesAnyPattern", () => {
			expect(matchesAnyPattern("test-ext1", ["test-*", "!test-disabled"])).toBe(
				true,
			);
			expect(
				matchesAnyPattern("test-disabled", ["test-*", "!test-disabled"]),
			).toBe(false);
			expect(matchesAnyPattern("deprecated-v1", ["!deprecated-*"])).toBe(false);
			expect(matchesAnyPattern("current-v1", ["!deprecated-*"])).toBe(true);
		});

		it("should filter per resource type independently", async () => {
			const pkgDir = join(testDir, "filter-package");
			mkdirSync(join(pkgDir, "extensions", "ext1"), { recursive: true });
			mkdirSync(join(pkgDir, "extensions", "ext2"), { recursive: true });
			mkdirSync(join(pkgDir, "skills", "skill1"), { recursive: true });
			mkdirSync(join(pkgDir, "skills", "skill2"), { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/filter",
					keywords: ["maestro-package"],
					maestro: {
						extensions: ["./extensions"],
						skills: ["./skills"],
					},
				}),
			);

			const pkg = await loadPackage({
				source: `local:${pkgDir}`,
				extensions: ["ext1"],
				skills: ["skill2"],
			});
			const resources = loadPackageResources(pkg);

			expect(resources.extensions).toHaveLength(1);
			expect(resources.extensions[0]).toContain("ext1");
			expect(resources.skills).toHaveLength(1);
			expect(resources.skills[0]).toContain("skill2");
		});
	});

	describe("matchesAnyPattern", () => {
		it("should match with inclusion patterns", () => {
			expect(matchesAnyPattern("test-ext1", ["test-*"])).toBe(true);
			expect(matchesAnyPattern("other-ext", ["test-*"])).toBe(false);
		});

		it("should handle wildcard pattern", () => {
			expect(matchesAnyPattern("anything", ["*"])).toBe(true);
		});

		it("should handle exclusion patterns correctly", () => {
			// Bugbot fix: exclusions should work properly
			expect(matchesAnyPattern("test-bar", ["test-*", "!test-bar"])).toBe(
				false,
			);
			expect(matchesAnyPattern("test-foo", ["test-*", "!test-bar"])).toBe(true);
		});

		it("should handle only exclusion patterns", () => {
			expect(matchesAnyPattern("deprecated-v1", ["!deprecated-*"])).toBe(false);
			expect(matchesAnyPattern("current-v1", ["!deprecated-*"])).toBe(true);
		});

		it("should handle multiple inclusions and exclusions", () => {
			const patterns = ["test-*", "demo-*", "!test-disabled", "!demo-old"];

			expect(matchesAnyPattern("test-new", patterns)).toBe(true);
			expect(matchesAnyPattern("test-disabled", patterns)).toBe(false);
			expect(matchesAnyPattern("demo-new", patterns)).toBe(true);
			expect(matchesAnyPattern("demo-old", patterns)).toBe(false);
			expect(matchesAnyPattern("other", patterns)).toBe(false);
		});
	});

	describe("Package Configuration", () => {
		it("should parse string-form package specs", () => {
			const [source1, filters1] = parsePackageSpec("local:./packages/my-pack");
			expect(source1).toBe("local:./packages/my-pack");
			expect(filters1).toBeUndefined();

			const [source2, filters2] = parsePackageSpec("git:github.com/user/repo");
			expect(source2).toBe("git:github.com/user/repo");
			expect(filters2).toBeUndefined();
		});

		it("should parse object-form package specs with filters", () => {
			const [source, filters] = parsePackageSpec({
				source: "local:./pkg",
				extensions: ["ext1"],
			});

			expect(source).toBe("local:./pkg");
			expect(filters).toBeDefined();
			expect(filters?.extensions).toEqual(["ext1"]);
		});

		it("should support shorthand without source prefix", () => {
			const source1 = parsePackageSource("./packages/my-pack", testDir);
			expect(source1.type).toBe("local");

			const source2 = parsePackageSource("github.com/user/repo");
			expect(source2.type).toBe("git");
		});
	});

	describe("Error Handling", () => {
		it("should handle missing package directories gracefully", async () => {
			const nonExistentPath = join(testDir, "nonexistent");

			await expect(loadPackage(`local:${nonExistentPath}`)).rejects.toThrow(
				"No valid package found",
			);
		});

		it("should handle malformed package.json", () => {
			const pkgDir = join(testDir, "bad-json");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(join(pkgDir, "package.json"), "{ invalid json");

			const discovered = discoverPackage(pkgDir);
			expect(discovered).toBeNull();
		});

		it("should handle missing maestro section gracefully", async () => {
			const pkgDir = join(testDir, "no-maestro");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/no-maestro",
					keywords: ["maestro-package"],
					// No maestro section
				}),
			);

			await expect(loadPackage(`local:${pkgDir}`)).rejects.toThrow(
				"missing 'maestro' section",
			);
		});

		it("should handle package without maestro-package keyword", async () => {
			const pkgDir = join(testDir, "no-keyword");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/no-keyword",
					maestro: {
						skills: ["./skills"],
					},
				}),
			);

			await expect(loadPackage(`local:${pkgDir}`)).rejects.toThrow(
				"missing 'maestro-package' keyword",
			);
		});
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
