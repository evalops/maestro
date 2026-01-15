/**
 * Tests for Guardian configuration loader
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_GUARDIAN_CONFIG,
	getConfigSummary,
	getProjectConfigPath,
	getUserConfigPath,
	resolveGuardianConfig,
	validateSecretPatterns,
} from "../../src/guardian/config.js";
import type { GuardianConfig } from "../../src/guardian/types.js";

const joinParts = (...parts: string[]) => parts.join("");

describe("Guardian Config", () => {
	let testDir: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`guardian-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		mkdirSync(join(testDir, ".composer"), { recursive: true });

		// Save original HOME
		originalHome = process.env.HOME;
	});

	afterEach(() => {
		// Restore original HOME
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		}

		// Clean up
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("DEFAULT_GUARDIAN_CONFIG", () => {
		it("should have sensible defaults", () => {
			expect(DEFAULT_GUARDIAN_CONFIG.enabled).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.scanGitOperations).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.scanDestructiveCommands).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.blockOnFindings).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.toolTimeoutMs).toBe(120_000);
			expect(DEFAULT_GUARDIAN_CONFIG.tools.semgrep).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.tools.gitSecrets).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.tools.trufflehog).toBe(true);
			expect(DEFAULT_GUARDIAN_CONFIG.tools.heuristicScan).toBe(true);
		});
	});

	describe("getProjectConfigPath", () => {
		it("should return path under .composer directory", () => {
			const path = getProjectConfigPath("/my/project");
			expect(path).toContain(".composer");
			expect(path).toContain("guardian.json");
			expect(path).toContain("/my/project");
		});

		it("should use cwd when no root provided", () => {
			const path = getProjectConfigPath();
			expect(path).toContain(process.cwd());
		});
	});

	describe("getUserConfigPath", () => {
		it("should return path under home directory", () => {
			const path = getUserConfigPath();
			expect(path).toContain(".composer");
			expect(path).toContain("guardian.json");
		});
	});

	describe("resolveGuardianConfig", () => {
		it("should return defaults when no config files exist", () => {
			const config = resolveGuardianConfig({ root: testDir });

			expect(config.enabled).toBe(DEFAULT_GUARDIAN_CONFIG.enabled);
			expect(config.tools.semgrep).toBe(true);
		});

		it("should load project-level config", () => {
			const projectConfig: GuardianConfig = {
				enabled: false,
				tools: { semgrep: false },
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(projectConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });

			expect(config.enabled).toBe(false);
			expect(config.tools.semgrep).toBe(false);
			// Other tools should still be enabled
			expect(config.tools.gitSecrets).toBe(true);
		});

		it("should merge custom secret patterns", () => {
			const projectConfig: GuardianConfig = {
				customSecretPatterns: ["MY_SECRET_[A-Z]+", "CUSTOM_TOKEN_\\d+"],
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(projectConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });

			expect(config.customSecretPatterns).toContain("MY_SECRET_[A-Z]+");
			expect(config.customSecretPatterns).toContain("CUSTOM_TOKEN_\\d+");
		});

		it("should merge exclude patterns", () => {
			const projectConfig: GuardianConfig = {
				excludePatterns: ["vendor/", "third_party/"],
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(projectConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });

			expect(config.excludePatterns).toContain("vendor/");
			expect(config.excludePatterns).toContain("third_party/");
		});

		it("should allow programmatic config to override file config", () => {
			const fileConfig: GuardianConfig = {
				enabled: false,
				toolTimeoutMs: 60_000,
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(fileConfig),
			);

			const config = resolveGuardianConfig({
				root: testDir,
				config: {
					enabled: true, // Override file config
				},
			});

			expect(config.enabled).toBe(true);
			expect(config.toolTimeoutMs).toBe(60_000); // Still from file
		});

		it("should handle malformed config files gracefully", () => {
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				"{ invalid json }",
			);

			// Should not throw, should return defaults
			const config = resolveGuardianConfig({ root: testDir });
			expect(config.enabled).toBe(true);
		});

		it("should handle missing config files gracefully", () => {
			// No config file created
			const config = resolveGuardianConfig({ root: testDir });
			expect(config).toBeDefined();
			expect(config.enabled).toBe(true);
		});
	});

	describe("validateSecretPatterns", () => {
		it("should validate correct regex patterns", () => {
			const patterns = [
				joinParts("AK", "IA", "[0-9A-Z]{16}"),
				"token_[a-z]+",
				"\\bsecret\\b",
			];
			const result = validateSecretPatterns(patterns);

			expect(result.valid).toHaveLength(3);
			expect(result.invalid).toHaveLength(0);
		});

		it("should identify invalid regex patterns", () => {
			const patterns = ["valid_pattern", "[invalid(", "another_valid"];
			const result = validateSecretPatterns(patterns);

			expect(result.valid).toHaveLength(2);
			expect(result.invalid).toHaveLength(1);
			expect(result.invalid[0]!.pattern).toBe("[invalid(");
			expect(result.invalid[0]!.error).toBeDefined();
		});

		it("should handle empty array", () => {
			const result = validateSecretPatterns([]);

			expect(result.valid).toHaveLength(0);
			expect(result.invalid).toHaveLength(0);
		});
	});

	describe("getConfigSummary", () => {
		it("should generate readable summary", () => {
			const config = resolveGuardianConfig({ root: testDir });
			const summary = getConfigSummary(config);

			expect(summary).toContain("Guardian Configuration:");
			expect(summary).toContain("Enabled: true");
			expect(summary).toContain("Scan Git Operations: true");
			expect(summary).toContain("Scan Destructive Commands: true");
			expect(summary).toContain("Block on Findings: true");
			expect(summary).toContain("Tool Timeout:");
		});

		it("should list enabled tools", () => {
			const config = resolveGuardianConfig({ root: testDir });
			const summary = getConfigSummary(config);

			expect(summary).toContain("Enabled Tools:");
			expect(summary).toContain("semgrep");
		});

		it("should show custom patterns count", () => {
			const fileConfig: GuardianConfig = {
				customSecretPatterns: ["pattern1", "pattern2"],
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(fileConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });
			const summary = getConfigSummary(config);

			expect(summary).toContain("Custom Secret Patterns: 2");
		});

		it("should show custom excludes", () => {
			const fileConfig: GuardianConfig = {
				excludePatterns: ["vendor/", "lib/"],
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(fileConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });
			const summary = getConfigSummary(config);

			expect(summary).toContain("Custom Excludes:");
			expect(summary).toContain("vendor/");
		});
	});

	describe("Config merging", () => {
		it("should properly merge nested tools config", () => {
			const projectConfig: GuardianConfig = {
				tools: {
					semgrep: false,
					// gitSecrets not specified - should remain true from defaults
				},
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(projectConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });

			expect(config.tools.semgrep).toBe(false);
			expect(config.tools.gitSecrets).toBe(true);
			expect(config.tools.trufflehog).toBe(true);
			expect(config.tools.heuristicScan).toBe(true);
		});

		it("should allow disabling all tools", () => {
			const projectConfig: GuardianConfig = {
				tools: {
					semgrep: false,
					gitSecrets: false,
					trufflehog: false,
					heuristicScan: false,
				},
			};
			writeFileSync(
				join(testDir, ".composer", "guardian.json"),
				JSON.stringify(projectConfig),
			);

			const config = resolveGuardianConfig({ root: testDir });

			expect(config.tools.semgrep).toBe(false);
			expect(config.tools.gitSecrets).toBe(false);
			expect(config.tools.trufflehog).toBe(false);
			expect(config.tools.heuristicScan).toBe(false);
		});
	});
});
