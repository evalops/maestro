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
	/** The CLI overrides applied on top of TOML config */
	cliOverrides: Partial<ComposerConfig>;
	/** Whether a profile was explicitly activated */
	profileActive: boolean;
	/**
	 * The explicit user CLI profile selection (`--profile`), if any.
	 *
	 * Only the user-controlled `--profile` flag is recorded here. A profile
	 * derived from the merged config (`config.profile`) must NOT be included
	 * because it can be set by a repo-controlled `.maestro/config.toml` and
	 * would then be honored as user intent by append-system trust resolution,
	 * bypassing the rule that only user-controlled selection may grant trust.
	 * When this is undefined, the trust layer re-derives the effective profile
	 * from user-controlled config sources (global config, MAESTRO_PROFILE,
	 * proven-untracked local config, cached selection) on its own.
	 */
	explicitProfileName?: string;
	/**
	 * User-controlled CLI overrides built from `--config` and direct CLI flags.
	 *
	 * This must stay separate from the merged config because repo-controlled
	 * config may also influence the final shape. Callers that need user intent
	 * provenance, such as append-system trust resolution, should consume this
	 * explicit override object instead of inspecting `config`.
	 */
	explicitCliOverrides: Partial<ComposerConfig>;
}

let runtimeOwnedMaestroProfile: {
	value: string;
	previous: string | undefined;
} | null = null;

function setRuntimeProfileEnv(profile: string): void {
	const previous = runtimeOwnedMaestroProfile
		? runtimeOwnedMaestroProfile.previous
		: process.env.MAESTRO_PROFILE;
	process.env.MAESTRO_PROFILE = profile;
	runtimeOwnedMaestroProfile = { value: profile, previous };
}

function restoreRuntimeProfileEnvIfOwned(): void {
	if (!runtimeOwnedMaestroProfile) {
		return;
	}
	const { value, previous } = runtimeOwnedMaestroProfile;
	if (process.env.MAESTRO_PROFILE === value) {
		if (previous === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_PROFILE");
		} else {
			process.env.MAESTRO_PROFILE = previous;
		}
	}
	runtimeOwnedMaestroProfile = null;
}

export function buildCliConfigOverrides(args: Args): Partial<ComposerConfig> {
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

	return cliOverrides;
}

/**
 * Load runtime configuration from TOML files and CLI args.
 *
 * @param args - Parsed CLI arguments
 * @param cwd - Current working directory (defaults to process.cwd())
 */
export function loadRuntimeConfig(args: Args, cwd?: string): RuntimeConfig {
	const workspaceDir = cwd ?? process.cwd();
	const cliOverrides = buildCliConfigOverrides(args);
	const overrideProfile =
		typeof cliOverrides.profile === "string" ? cliOverrides.profile : undefined;

	const cliProfile = args.profile ?? overrideProfile;
	if (cliProfile) {
		setRuntimeProfileEnv(cliProfile);
	} else {
		restoreRuntimeProfileEnvIfOwned();
	}

	// Load config with profile and overrides
	const config = loadConfig(workspaceDir, args.profile, cliOverrides);

	return {
		config,
		cliOverrides,
		profileActive: !!args.profile || !!config.profile,
		explicitProfileName: args.profile,
		explicitCliOverrides: cliOverrides,
	};
}

/**
 * Apply runtime config to environment variables for compatibility
 * with existing code that reads from process.env.
 */
export function applyConfigToEnv(config: ComposerConfig): void {
	// Only set env vars if they're not already set (lower precedence)
	if (config.model && !process.env.MAESTRO_MODEL) {
		process.env.MAESTRO_MODEL = config.model;
	}
	if (config.model_provider && !process.env.MAESTRO_MODEL_PROVIDER) {
		process.env.MAESTRO_MODEL_PROVIDER = config.model_provider;
	}
	if (config.approval_policy && !process.env.MAESTRO_APPROVAL_POLICY) {
		process.env.MAESTRO_APPROVAL_POLICY = config.approval_policy;
	}
	if (config.sandbox_mode && !process.env.MAESTRO_SANDBOX_MODE) {
		process.env.MAESTRO_SANDBOX_MODE = config.sandbox_mode;
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
