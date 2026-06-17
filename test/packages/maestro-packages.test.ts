/**
 * Tests for Maestro Packages - distributable extension bundles (#861)
 *
 * This test suite validates the package system for discovering, loading,
 * and filtering extensions, skills, prompts, and themes from:
 * - Local filesystem paths
 * - Git repositories
 * - npm packages
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConfiguredPackageSpecToConfig } from "../../src/config/index.js";
import {
	clearResolvedPackageSourceCache,
	discoverPackage,
	filterResources,
	getCachedRemotePackageSourcePath,
	isValidMaestroPackage,
	loadConfiguredPackageResources,
	loadPackage,
	loadPackageResources,
	matchesAnyPattern,
	parsePackageSource,
	parsePackageSpec,
	refreshConfiguredRemotePackages,
	refreshPackageSourceSync,
} from "../../src/packages/index.js";
import {
	clearConfiguredRemotePackageAutoSyncState,
	pruneUnconfiguredRemotePackageCaches,
} from "../../src/packages/maintenance.js";
import {
	clearConfiguredPackageRuntimeContext,
	setConfiguredPackageRuntimeContext,
} from "../../src/packages/runtime.js";
import { normalizeGitCloneUrl } from "../../src/packages/sources.js";

async function waitForCondition(
	check: () => boolean,
	timeoutMs = 2000,
	intervalMs = 25,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (check()) {
			return;
		}
		await new Promise((resolvePromise) =>
			setTimeout(resolvePromise, intervalMs),
		);
	}

	throw new Error("Timed out waiting for package auto-sync to finish.");
}

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
		clearConfiguredRemotePackageAutoSyncState();
		clearConfiguredPackageRuntimeContext();
	});

	afterEach(() => {
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		clearResolvedPackageSourceCache();
		clearConfiguredRemotePackageAutoSyncState();
		clearConfiguredPackageRuntimeContext();
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

		it("should handle git refs that contain slashes", () => {
			const source = parsePackageSource("git:github.com/user/repo@feature/foo");
			expect(source).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "feature/foo",
			});
		});

		it("should handle git refs that contain plus signs", () => {
			const source = parsePackageSource(
				"git:github.com/user/repo@v1.0.0+maestro.1",
			);
			expect(source).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "v1.0.0+maestro.1",
			});
		});

		it("should accept git refs with git-valid punctuation", () => {
			expect(
				parsePackageSource("git:github.com/user/repo@release%2026"),
			).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "release%2026",
			});
			expect(
				parsePackageSource("git:github.com/user/repo@build=prod"),
			).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "build=prod",
			});
			expect(
				parsePackageSource("git:github.com/user/repo@release,candidate"),
			).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "release,candidate",
			});
		});

		it("should accept git revision expressions that checkout supports", () => {
			expect(
				parsePackageSource("git:github.com/user/repo@main~1"),
			).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "main~1",
			});
			expect(
				parsePackageSource("git:github.com/user/repo@v1.0.0^"),
			).toMatchObject({
				type: "git",
				url: "github.com/user/repo",
				ref: "v1.0.0^",
			});
		});

		it("should parse bare native git:// URLs without stripping the scheme", () => {
			const prefixed = parsePackageSource(
				"git:git://git.kernel.org/pub/scm/git/git.git",
			);
			const bare = parsePackageSource(
				"git://git.kernel.org/pub/scm/git/git.git",
			);
			for (const source of [prefixed, bare]) {
				expect(source).toMatchObject({
					type: "git",
					url: "git://git.kernel.org/pub/scm/git/git.git",
				});
				expect(normalizeGitCloneUrl(source.url)).toBe(
					"git://git.kernel.org/pub/scm/git/git.git",
				);
			}
		});

		it("should preserve relative local git repositories", () => {
			expect(parsePackageSource("git:repo.git")).toMatchObject({
				type: "git",
				url: "repo.git",
			});
			expect(parsePackageSource("repo.git")).toMatchObject({
				type: "git",
				url: "repo.git",
			});
			expect(normalizeGitCloneUrl("repo.git")).toBe("repo.git");
			expect(normalizeGitCloneUrl("sub/repo.git")).toBe("sub/repo.git");
			expect(normalizeGitCloneUrl("vendor.v1/repo.git")).toBe(
				"vendor.v1/repo.git",
			);
			expect(normalizeGitCloneUrl("vendor/repo:v1.git")).toBe(
				"vendor/repo:v1.git",
			);
			expect(parsePackageSource("git:foo/bar:baz.git")).toMatchObject({
				type: "git",
				url: "foo/bar:baz.git",
			});
			expect(normalizeGitCloneUrl("foo/bar::baz.git")).toBe("foo/bar::baz.git");
		});

		it("should preserve scp-style remotes whose path starts with digits", () => {
			expect(normalizeGitCloneUrl("git.example.com:2222/repo.git")).toBe(
				"git.example.com:2222/repo.git",
			);
		});

		it("should parse scp-style git URLs without treating the host separator as a ref", () => {
			const source = parsePackageSource("git:git@github.com:user/repo.git");
			expect(source).toMatchObject({
				type: "git",
				url: "git@github.com:user/repo.git",
			});
			expect(source.ref).toBeUndefined();
		});

		it("should parse refs on scp-style git URLs", () => {
			const source = parsePackageSource("git:github.com:user/repo.git@v1.0.0");
			expect(source).toMatchObject({
				type: "git",
				url: "github.com:user/repo.git",
				ref: "v1.0.0",
			});
		});

		it("should parse slash refs on scp-style git URLs with userinfo", () => {
			const source = parsePackageSource(
				"git:git@github.com:user/repo.git@feature/foo",
			);
			expect(source).toMatchObject({
				type: "git",
				url: "git@github.com:user/repo.git",
				ref: "feature/foo",
			});
		});

		it("should parse ssh git URLs without treating userinfo as a ref", () => {
			const source = parsePackageSource(
				"git:ssh://git@github.com/user/repo.git",
			);
			expect(source).toMatchObject({
				type: "git",
				url: "ssh://git@github.com/user/repo.git",
			});
			expect(source.ref).toBeUndefined();
		});

		it("should treat scoped package names ending in .git as npm sources", () => {
			expect(parsePackageSource("@scope/pkg.git")).toMatchObject({
				type: "npm",
				name: "@scope/pkg.git",
			});
			expect(parsePackageSource("@scope/pkg.git@1.2.3")).toMatchObject({
				type: "npm",
				name: "@scope/pkg.git",
				version: "1.2.3",
			});
		});

		it("should reject invalid source formats", () => {
			expect(() => parsePackageSource("invalid::source")).toThrow(
				"Invalid package source format",
			);
		});

		it("should reject unsafe git transport helpers before clone", () => {
			for (const source of [
				parsePackageSource("git:ext::sh -c 'touch /tmp/pwned'"),
				parsePackageSource("git:9p::payload"),
			]) {
				expect(() => refreshPackageSourceSync(source)).toThrow(
					"Unsupported git package source URL",
				);
			}
		});

		it("should allow IPv6 literal git URLs that git clone accepts", () => {
			const sshSource = parsePackageSource(
				"git:ssh://git@[2001:db8::1]/user/repo.git",
			);
			expect(sshSource).toMatchObject({
				type: "git",
				url: "ssh://git@[2001:db8::1]/user/repo.git",
			});
			expect(normalizeGitCloneUrl(sshSource.url)).toBe(
				"ssh://git@[2001:db8::1]/user/repo.git",
			);

			const httpsSource = parsePackageSource(
				"git:https://[2001:db8::1]/user/repo.git",
			);
			expect(httpsSource).toMatchObject({
				type: "git",
				url: "https://[2001:db8::1]/user/repo.git",
			});
			expect(normalizeGitCloneUrl(httpsSource.url)).toBe(
				"https://[2001:db8::1]/user/repo.git",
			);
		});

		it("should reject unsupported git URL schemes before clone", () => {
			const source = parsePackageSource("git:file:///tmp/package-repo");

			expect(() => refreshPackageSourceSync(source)).toThrow(
				"Unsupported git package source URL scheme: file",
			);
		});

		it("should strip npm-style git-plus prefixes before git clone", () => {
			expect(normalizeGitCloneUrl("git+https://github.com/user/repo.git")).toBe(
				"https://github.com/user/repo.git",
			);
			expect(
				normalizeGitCloneUrl("git+ssh://git@github.com/user/repo.git"),
			).toBe("ssh://git@github.com/user/repo.git");
		});

		it("should allow native git protocol URLs that git clone accepts", () => {
			const source = parsePackageSource(
				"git:git://git.kernel.org/pub/scm/git/git.git",
			);
			expect(source).toMatchObject({
				type: "git",
				url: "git://git.kernel.org/pub/scm/git/git.git",
			});
			expect(normalizeGitCloneUrl(source.url)).toBe(
				"git://git.kernel.org/pub/scm/git/git.git",
			);
		});

		it("should allow scp-style git URLs that git clone accepts", () => {
			expect(normalizeGitCloneUrl("github.com:user/repo.git")).toBe(
				"github.com:user/repo.git",
			);
			expect(
				normalizeGitCloneUrl("token@github.com:acme/private-repo.git"),
			).toBe("token@github.com:acme/private-repo.git");
			expect(normalizeGitCloneUrl("github-work:team/skills.git")).toBe(
				"github-work:team/skills.git",
			);
			expect(normalizeGitCloneUrl("git@github-work:team/skills.git")).toBe(
				"git@github-work:team/skills.git",
			);
		});

		it("should preserve parsed dotted git paths outside the shorthand allowlist", () => {
			const gistSource = parsePackageSource(
				"git:gist.github.com/user/repo.git",
			);
			expect(gistSource).toMatchObject({
				type: "git",
				url: "gist.github.com/user/repo.git",
			});
			expect(normalizeGitCloneUrl(gistSource.url)).toBe(
				"gist.github.com/user/repo.git",
			);

			const codebergSource = parsePackageSource("codeberg.org:user/repo.git");
			expect(codebergSource).toMatchObject({
				type: "git",
				url: "codeberg.org:user/repo.git",
			});
			expect(normalizeGitCloneUrl(codebergSource.url)).toBe(
				"codeberg.org:user/repo.git",
			);
		});

		it("should allow self-hosted scp-style git remotes", () => {
			const source = parsePackageSource(
				"git:deploy@git.example.com:team/skills.git",
			);
			expect(source).toMatchObject({
				type: "git",
				url: "deploy@git.example.com:team/skills.git",
			});
			expect(normalizeGitCloneUrl(source.url)).toBe(
				"deploy@git.example.com:team/skills.git",
			);
		});

		it("should allow absolute Windows paths as local git sources", () => {
			expect(normalizeGitCloneUrl("C:\\repo\\package")).toBe(
				"C:\\repo\\package",
			);
		});

		it("should reject unsafe git refs", () => {
			expect(() =>
				parsePackageSource("git:github.com/user/repo@-upload-pack=sh"),
			).toThrow("Invalid git package ref");
			expect(() =>
				parsePackageSource("git:github.com/user/repo@main;touch-pwned"),
			).toThrow("Invalid git package ref");
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

		it("should load npm packages from a local source path", async () => {
			const pkgDir = join(testDir, "npm-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\nLoaded through npm.\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/npm-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: {
						skills: ["./skills"],
					},
				}),
			);

			const pkg = await loadPackage(`npm:${pkgDir}`);
			const resources = loadPackageResources(pkg);

			expect(pkg.source.type).toBe("npm");
			expect(pkg.path).toContain("node_modules");
			expect(pkg.name).toBe("@test/npm-package");
			expect(resources.skills).toHaveLength(1);
			expect(resources.skills[0]).toContain("review-skill");
		});

		it("should refresh cached npm package tarballs when the source changes", async () => {
			const pkgDir = join(testDir, "npm-refresh-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/npm-refresh-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: {
						skills: ["./skills"],
					},
				}),
			);

			const tarballName = execFileSync("npm", ["pack", "--silent"], {
				cwd: pkgDir,
				encoding: "utf8",
			}).trim();
			const tarballPath = join(pkgDir, tarballName);
			const sourceSpec = `npm:${tarballPath}`;

			const initialPackage = await loadPackage(sourceSpec);
			expect(loadPackageResources(initialPackage).skills).toHaveLength(1);

			mkdirSync(join(pkgDir, "skills", "deploy-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "deploy-skill", "SKILL.md"),
				"# Deploy Skill\n",
			);
			execFileSync("npm", ["pack", "--silent"], {
				cwd: pkgDir,
				encoding: "utf8",
			});

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

		it("automatically refreshes configured remote package caches in the background", async () => {
			const pkgDir = join(testDir, "configured-git-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/configured-git-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: {
						skills: ["./skills"],
					},
				}),
			);
			createCommittedGitRepo(pkgDir);

			trustWorkspaceViaGlobalConfig(testDir);
			addConfiguredPackageSpecToConfig({
				workspaceDir: testDir,
				scope: "local",
				spec: `git:${pkgDir}`,
			});

			const initialResources = loadConfiguredPackageResources(testDir);
			expect(initialResources.skills.project).toHaveLength(1);

			mkdirSync(join(pkgDir, "skills", "deploy-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "deploy-skill", "SKILL.md"),
				"# Deploy Skill\n",
			);
			commitGitRepoChanges(pkgDir, "add deploy skill");

			clearConfiguredRemotePackageAutoSyncState(testDir);
			loadConfiguredPackageResources(testDir);

			await waitForCondition(() =>
				loadConfiguredPackageResources(testDir).skills.project.some((path) =>
					path.includes("deploy-skill"),
				),
			);

			const refreshedResources = loadConfiguredPackageResources(testDir);
			expect(refreshedResources.skills.project).toHaveLength(2);
			expect(
				refreshedResources.skills.project.some((path) =>
					path.includes("deploy-skill"),
				),
			).toBe(true);
		});

		it("does not remote-refresh project package entries denied by the active profile", async () => {
			const pkgDir = join(testDir, "profile-denied-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/profile-denied-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: { skills: ["./skills"] },
				}),
			);
			createCommittedGitRepo(pkgDir);

			// Globally trusted, but the "locked" profile downgrades trust.
			trustWorkspaceViaGlobalConfig(testDir, { locked: "untrusted" });
			addConfiguredPackageSpecToConfig({
				workspaceDir: testDir,
				scope: "project",
				spec: `git:${pkgDir}`,
			});

			// Without the denying profile the remote entry is a refresh target.
			const trustedRefresh = await refreshConfiguredRemotePackages(testDir);
			expect(trustedRefresh.remoteCount).toBe(1);

			// With the denying profile active, the same untrusted project entry
			// must not be fetched/refreshed, mirroring the gated load.
			const deniedRefresh = await refreshConfiguredRemotePackages(testDir, {
				profileName: "locked",
			});
			expect(deniedRefresh.remoteCount).toBe(0);
		});

		it("re-runs auto-sync when trust context changes", async () => {
			const pkgDir = join(testDir, "profile-switch-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/profile-switch-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: { skills: ["./skills"] },
				}),
			);
			createCommittedGitRepo(pkgDir);

			trustWorkspaceViaGlobalConfig(testDir, { locked: "untrusted" });
			addConfiguredPackageSpecToConfig({
				workspaceDir: testDir,
				scope: "project",
				spec: `git:${pkgDir}`,
			});

			refreshPackageSourceSync(parsePackageSource(`git:${pkgDir}`, testDir));

			mkdirSync(join(pkgDir, "skills", "deploy-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "deploy-skill", "SKILL.md"),
				"# Deploy Skill\n",
			);
			commitGitRepoChanges(pkgDir, "add deploy skill");

			clearConfiguredRemotePackageAutoSyncState(testDir);
			const deniedResources = loadConfiguredPackageResources(testDir, {
				profileName: "locked",
			});
			expect(deniedResources.skills.project).toHaveLength(0);

			loadConfiguredPackageResources(testDir);

			await waitForCondition(() =>
				loadConfiguredPackageResources(testDir).skills.project.some((path) =>
					path.includes("deploy-skill"),
				),
			);

			const refreshedResources = loadConfiguredPackageResources(testDir);
			expect(refreshedResources.skills.project).toHaveLength(2);
		});

		it("uses runtime package profile context when explicit options are omitted", () => {
			const pkgDir = join(testDir, "runtime-profile-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/runtime-profile-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: { skills: ["./skills"] },
				}),
			);
			mkdirSync(process.env.MAESTRO_HOME!, { recursive: true });
			writeFileSync(
				join(process.env.MAESTRO_HOME!, "config.toml"),
				`[profiles.trusted-packages.projects.${JSON.stringify(resolve(testDir))}]\ntrust_level = "trusted"\n`,
			);
			mkdirSync(join(testDir, ".maestro"), { recursive: true });
			writeFileSync(
				join(testDir, ".maestro", "config.toml"),
				'packages = ["../runtime-profile-package"]\n',
			);

			expect(
				loadConfiguredPackageResources(testDir).skills.project,
			).toHaveLength(0);

			setConfiguredPackageRuntimeContext(testDir, {
				profileName: "trusted-packages",
			});

			expect(loadConfiguredPackageResources(testDir).skills.project).toEqual(
				expect.arrayContaining([join(pkgDir, "skills", "review-skill")]),
			);
		});

		it("uses runtime package profile context when refreshing configured remotes", async () => {
			const pkgDir = join(testDir, "runtime-refresh-package");
			mkdirSync(join(pkgDir, "skills", "review-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@test/runtime-refresh-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: { skills: ["./skills"] },
				}),
			);
			createCommittedGitRepo(pkgDir);
			mkdirSync(process.env.MAESTRO_HOME!, { recursive: true });
			writeFileSync(
				join(process.env.MAESTRO_HOME!, "config.toml"),
				`[profiles.trusted-packages.projects.${JSON.stringify(resolve(testDir))}]\ntrust_level = "trusted"\n`,
			);
			mkdirSync(join(testDir, ".maestro"), { recursive: true });
			writeFileSync(
				join(testDir, ".maestro", "config.toml"),
				`packages = ["git:${pkgDir}"]\n`,
			);

			expect((await refreshConfiguredRemotePackages(testDir)).remoteCount).toBe(
				0,
			);

			setConfiguredPackageRuntimeContext(testDir, {
				profileName: "trusted-packages",
			});

			await expect(
				refreshConfiguredRemotePackages(testDir),
			).resolves.toMatchObject({
				remoteCount: 1,
				refreshed: [
					{
						source: `git:${pkgDir}`,
						sourceType: "git",
						scopes: ["project"],
						error: null,
					},
				],
			});
		});

		it("uses runtime package profile context when pruning configured remote caches", () => {
			const referencedRepo = join(testDir, "runtime-prune-package");
			mkdirSync(join(referencedRepo, "skills", "review-skill"), {
				recursive: true,
			});
			writeFileSync(
				join(referencedRepo, "skills", "review-skill", "SKILL.md"),
				"# Review Skill\n",
			);
			writeFileSync(
				join(referencedRepo, "package.json"),
				JSON.stringify({
					name: "@test/runtime-prune-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: { skills: ["./skills"] },
				}),
			);
			createCommittedGitRepo(referencedRepo);

			const orphanRepo = join(testDir, "runtime-prune-orphan-package");
			mkdirSync(join(orphanRepo, "skills", "orphan-skill"), {
				recursive: true,
			});
			writeFileSync(
				join(orphanRepo, "skills", "orphan-skill", "SKILL.md"),
				"# Orphan Skill\n",
			);
			writeFileSync(
				join(orphanRepo, "package.json"),
				JSON.stringify({
					name: "@test/runtime-prune-orphan-package",
					version: "1.0.0",
					keywords: ["maestro-package"],
					maestro: { skills: ["./skills"] },
				}),
			);
			createCommittedGitRepo(orphanRepo);

			mkdirSync(process.env.MAESTRO_HOME!, { recursive: true });
			writeFileSync(
				join(process.env.MAESTRO_HOME!, "config.toml"),
				`[profiles.trusted-packages.projects.${JSON.stringify(resolve(testDir))}]\ntrust_level = "trusted"\n`,
			);
			mkdirSync(join(testDir, ".maestro"), { recursive: true });
			writeFileSync(
				join(testDir, ".maestro", "config.toml"),
				`packages = ["git:${referencedRepo}"]\n`,
			);

			refreshPackageSourceSync(
				parsePackageSource(`git:${referencedRepo}`, testDir),
			);
			refreshPackageSourceSync(
				parsePackageSource(`git:${orphanRepo}`, testDir),
			);

			setConfiguredPackageRuntimeContext(testDir, {
				profileName: "trusted-packages",
			});

			expect(pruneUnconfiguredRemotePackageCaches(testDir)).toMatchObject({
				referencedCount: 1,
				removedCount: 1,
			});
			expect(
				existsSync(
					getCachedRemotePackageSourcePath(
						parsePackageSource(`git:${referencedRepo}`, testDir),
					),
				),
			).toBe(true);
			expect(
				existsSync(
					getCachedRemotePackageSourcePath(
						parsePackageSource(`git:${orphanRepo}`, testDir),
					),
				),
			).toBe(false);
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

function trustWorkspaceViaGlobalConfig(
	workspaceDir: string,
	profiles?: Record<string, "trusted" | "untrusted">,
): void {
	const home = process.env.MAESTRO_HOME;
	if (!home) {
		throw new Error("MAESTRO_HOME must be set before trusting a workspace");
	}
	mkdirSync(home, { recursive: true });
	const quotedDir = JSON.stringify(resolve(workspaceDir));
	let config = `[projects.${quotedDir}]\ntrust_level = "trusted"\n`;
	for (const [profile, level] of Object.entries(profiles ?? {})) {
		config += `\n[profiles.${profile}.projects.${quotedDir}]\ntrust_level = "${level}"\n`;
	}
	writeFileSync(join(home, "config.toml"), config);
}

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
