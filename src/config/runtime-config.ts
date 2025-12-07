/**
 * Runtime Configuration
 *
 * Loads and applies configuration from TOML config files and CLI overrides.
 * This module bridges the gap between the TOML config system and the
 * existing CLI argument parsing.
 */

import type { Args } from "../cli/args.js";
import {
	type ComposerConfig,
	applyCliOverride,
	loadConfig,
	parseCliOverride,
} from "./toml-config.js";

/**
 * Resolved runtime configuration combining CLI args and TOML config.
 */
export interface RuntimeConfig {
	/** The loaded TOML config */
	config: ComposerConfig;
	/** Whether a profile was explicitly activated */
	profileActive: boolean;
	/** The active profile name if any */
	profileName?: string;
}

/**
 * Load runtime configuration from TOML files and CLI args.
 *
 * @param args - Parsed CLI arguments
 * @param cwd - Current working directory (defaults to process.cwd())
 */
export function loadRuntimeConfig(args: Args, cwd?: string): RuntimeConfig {
	const workspaceDir = cwd ?? process.cwd();

	// Build CLI overrides from --config flags
	let cliOverrides: Partial<ComposerConfig> = {};

	if (args.configOverrides) {
		for (const override of args.configOverrides) {
			const parsed = parseCliOverride(override);
			if (parsed) {
				cliOverrides = applyCliOverride(
					cliOverrides as ComposerConfig,
					parsed.key,
					parsed.value,
				);
			}
		}
	}

	// Apply direct CLI args as overrides
	if (args.model) {
		cliOverrides.model = args.model;
	}
	if (args.provider) {
		cliOverrides.model_provider = args.provider;
	}
	if (args.sandbox) {
		cliOverrides.sandbox_mode = args.sandbox as ComposerConfig["sandbox_mode"];
	}
	if (args.safeMode) {
		cliOverrides.approval_policy = "untrusted";
	}

	// Load config with profile and overrides
	const config = loadConfig(workspaceDir, args.profile, cliOverrides);

	return {
		config,
		profileActive: !!args.profile || !!config.profile,
		profileName: args.profile ?? config.profile,
	};
}

/**
 * Apply runtime config to environment variables for compatibility
 * with existing code that reads from process.env.
 */
export function applyConfigToEnv(config: ComposerConfig): void {
	// Only set env vars if they're not already set (lower precedence)
	if (config.model && !process.env.COMPOSER_MODEL) {
		process.env.COMPOSER_MODEL = config.model;
	}
	if (config.model_provider && !process.env.COMPOSER_MODEL_PROVIDER) {
		process.env.COMPOSER_MODEL_PROVIDER = config.model_provider;
	}
	if (config.approval_policy && !process.env.COMPOSER_APPROVAL_POLICY) {
		process.env.COMPOSER_APPROVAL_POLICY = config.approval_policy;
	}
	if (config.sandbox_mode && !process.env.COMPOSER_SANDBOX_MODE) {
		process.env.COMPOSER_SANDBOX_MODE = config.sandbox_mode;
	}
}

/**
 * Get approval mode from config.
 */
export function getApprovalModeFromConfig(
	config: ComposerConfig,
): "auto" | "prompt" | "fail" | undefined {
	switch (config.approval_policy) {
		case "never":
			return "auto";
		case "on-request":
			return "auto";
		case "on-failure":
			return "prompt";
		case "untrusted":
			return "prompt";
		default:
			return undefined;
	}
}
