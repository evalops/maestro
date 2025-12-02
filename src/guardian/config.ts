/**
 * Guardian configuration loader
 *
 * Loads configuration from (in order of precedence):
 * 1. Programmatic options passed to runGuardian()
 * 2. Project-level: .composer/guardian.json
 * 3. User-level: ~/.composer/guardian.json
 * 4. Default configuration
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import type { GuardianConfig } from "./types.js";

const logger = createLogger("guardian:config");

/** Default Guardian configuration */
export const DEFAULT_GUARDIAN_CONFIG: Required<GuardianConfig> = {
	enabled: true,
	scanGitOperations: true,
	scanDestructiveCommands: true,
	customSecretPatterns: [],
	excludePatterns: [],
	tools: {
		semgrep: true,
		gitSecrets: true,
		trufflehog: true,
		heuristicScan: true,
	},
	toolTimeoutMs: 120_000,
	blockOnFindings: true,
};

/**
 * Load and parse a Guardian config file
 */
function loadConfigFile(path: string): GuardianConfig | null {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
		const config = JSON.parse(content) as GuardianConfig;
		logger.debug("Loaded Guardian config", { path, config });
		return config;
	} catch (error) {
		logger.warn("Failed to load Guardian config", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Get the project-level config file path
 */
export function getProjectConfigPath(root?: string): string {
	const projectRoot = root ? resolve(root) : process.cwd();
	return join(projectRoot, ".composer", "guardian.json");
}

/**
 * Get the user-level config file path
 */
export function getUserConfigPath(): string {
	return join(homedir(), ".composer", "guardian.json");
}

/**
 * Merge multiple configs with later configs taking precedence
 */
function mergeConfigs(...configs: (GuardianConfig | null)[]): GuardianConfig {
	const result: GuardianConfig = { ...DEFAULT_GUARDIAN_CONFIG };

	for (const config of configs) {
		if (!config) continue;

		// Simple scalar properties
		if (config.enabled !== undefined) result.enabled = config.enabled;
		if (config.scanGitOperations !== undefined)
			result.scanGitOperations = config.scanGitOperations;
		if (config.scanDestructiveCommands !== undefined)
			result.scanDestructiveCommands = config.scanDestructiveCommands;
		if (config.toolTimeoutMs !== undefined)
			result.toolTimeoutMs = config.toolTimeoutMs;
		if (config.blockOnFindings !== undefined)
			result.blockOnFindings = config.blockOnFindings;

		// Arrays - merge with defaults
		if (config.customSecretPatterns) {
			result.customSecretPatterns = [
				...(result.customSecretPatterns || []),
				...config.customSecretPatterns,
			];
		}
		if (config.excludePatterns) {
			result.excludePatterns = [
				...(result.excludePatterns || []),
				...config.excludePatterns,
			];
		}

		// Tools - deep merge
		if (config.tools) {
			result.tools = {
				...result.tools,
				...config.tools,
			};
		}
	}

	return result;
}

/**
 * Resolve the effective Guardian configuration
 *
 * Order of precedence (highest to lowest):
 * 1. Programmatic options
 * 2. Project-level config (.composer/guardian.json)
 * 3. User-level config (~/.composer/guardian.json)
 * 4. Default config
 */
export function resolveGuardianConfig(options?: {
	root?: string;
	config?: GuardianConfig;
}): Required<GuardianConfig> {
	const userConfig = loadConfigFile(getUserConfigPath());
	const projectConfig = loadConfigFile(getProjectConfigPath(options?.root));

	const merged = mergeConfigs(
		DEFAULT_GUARDIAN_CONFIG,
		userConfig,
		projectConfig,
		options?.config ?? null,
	);

	// Ensure all required properties are present
	return {
		enabled: merged.enabled ?? DEFAULT_GUARDIAN_CONFIG.enabled,
		scanGitOperations:
			merged.scanGitOperations ?? DEFAULT_GUARDIAN_CONFIG.scanGitOperations,
		scanDestructiveCommands:
			merged.scanDestructiveCommands ??
			DEFAULT_GUARDIAN_CONFIG.scanDestructiveCommands,
		customSecretPatterns:
			merged.customSecretPatterns ??
			DEFAULT_GUARDIAN_CONFIG.customSecretPatterns,
		excludePatterns:
			merged.excludePatterns ?? DEFAULT_GUARDIAN_CONFIG.excludePatterns,
		tools: {
			...DEFAULT_GUARDIAN_CONFIG.tools,
			...merged.tools,
		},
		toolTimeoutMs:
			merged.toolTimeoutMs ?? DEFAULT_GUARDIAN_CONFIG.toolTimeoutMs,
		blockOnFindings:
			merged.blockOnFindings ?? DEFAULT_GUARDIAN_CONFIG.blockOnFindings,
	};
}

/**
 * Validate custom secret patterns
 */
export function validateSecretPatterns(patterns: string[]): {
	valid: string[];
	invalid: Array<{ pattern: string; error: string }>;
} {
	const valid: string[] = [];
	const invalid: Array<{ pattern: string; error: string }> = [];

	for (const pattern of patterns) {
		const compiled = compileUserRegex(pattern);
		if (compiled) {
			valid.push(pattern);
		} else {
			invalid.push({
				pattern,
				error: "Invalid or unsafe regex pattern",
			});
		}
	}

	return { valid, invalid };
}

/**
 * Compile a user-provided regex string with basic safety guards.
 */
function compileUserRegex(pattern: string): RegExp | null {
	if (!pattern || pattern.length > 500) {
		return null;
	}

	try {
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

/**
 * Get a summary of the current Guardian configuration
 */
export function getConfigSummary(config: Required<GuardianConfig>): string {
	const lines: string[] = [];

	lines.push("Guardian Configuration:");
	lines.push(`  Enabled: ${config.enabled}`);
	lines.push(`  Scan Git Operations: ${config.scanGitOperations}`);
	lines.push(`  Scan Destructive Commands: ${config.scanDestructiveCommands}`);
	lines.push(`  Block on Findings: ${config.blockOnFindings}`);
	lines.push(`  Tool Timeout: ${config.toolTimeoutMs}ms`);

	const enabledTools = Object.entries(config.tools)
		.filter(([, enabled]) => enabled)
		.map(([name]) => name);
	const disabledTools = Object.entries(config.tools)
		.filter(([, enabled]) => !enabled)
		.map(([name]) => name);

	lines.push(`  Enabled Tools: ${enabledTools.join(", ") || "none"}`);
	if (disabledTools.length > 0) {
		lines.push(`  Disabled Tools: ${disabledTools.join(", ")}`);
	}

	if (config.customSecretPatterns.length > 0) {
		lines.push(
			`  Custom Secret Patterns: ${config.customSecretPatterns.length}`,
		);
	}

	if (config.excludePatterns.length > 0) {
		lines.push(`  Custom Excludes: ${config.excludePatterns.join(", ")}`);
	}

	return lines.join("\n");
}
