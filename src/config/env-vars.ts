/**
 * Environment Variable Configuration
 *
 * Centralized configuration for all MAESTRO_* environment variables.
 * Inspired by Claude Code's CLAUDE_CODE_* variables.
 *
 * Environment variables provide runtime configuration without modifying
 * config files. They have higher precedence than config files but lower
 * than CLI flags.
 *
 * ## Supported Variables
 *
 * ### Core Settings
 * - MAESTRO_MODEL - Override the default model
 * - MAESTRO_MODEL_PROVIDER - Override the model provider
 * - MAESTRO_PROFILE - Select a config profile
 * - MAESTRO_APPROVAL_POLICY - Set approval policy (untrusted|on-failure|on-request|never)
 * - MAESTRO_SANDBOX_MODE - Set sandbox mode (read-only|workspace-write|danger-full-access)
 *
 * ### Behavior Controls
 * - MAESTRO_MAX_OUTPUT_TOKENS - Maximum tokens for model output
 * - MAESTRO_DISABLE_TELEMETRY - Disable telemetry (1 to disable)
 * - MAESTRO_DISABLE_TERMINAL_TITLE - Don't update terminal title (1 to disable)
 * - MAESTRO_DISABLE_ANIMATIONS - Disable TUI animations (1 to disable)
 * - MAESTRO_CONTEXT_FIREWALL_BLOCKING - Enable/disable blocking of sensitive content in tool args (default: 1)
 *
 * ### Subagent Configuration
 * - MAESTRO_SUBAGENT_MODEL - Model to use for subagents
 * - MAESTRO_ORACLE_MODEL - Model to use for the Oracle tool
 *
 * ### API Configuration
 * - MAESTRO_API_KEY_HELPER_TTL_MS - Cache TTL for API key helpers
 * - MAESTRO_SKIP_AUTH - Skip authentication (for testing)
 * - MAESTRO_IDENTITY_URL - Override EvalOps identity base URL
 * - MAESTRO_PLATFORM_BASE_URL - Shared EvalOps Platform base URL for core services
 *
 * ### Network Configuration
 * - MAESTRO_HTTP_PROXY - HTTP proxy URL
 * - MAESTRO_HTTPS_PROXY - HTTPS proxy URL
 * - MAESTRO_SOCKS_PROXY - SOCKS proxy URL
 * - MAESTRO_NO_PROXY - Comma-separated list of hosts to bypass proxy
 *
 * ### Debug Configuration
 * - MAESTRO_DEBUG - Enable debug logging (1 to enable)
 * - MAESTRO_LOG_LEVEL - Set log level (debug|info|warn|error)
 * - MAESTRO_USAGE_FILE - Path to write usage data
 *
 * ### Session Configuration
 * - MAESTRO_NO_SESSION - Disable session persistence (1 to disable)
 * - MAESTRO_SESSION_DIR - Custom session storage directory
 * - MAESTRO_SESSION_SCOPE - Scope sessions by auth subject (auth|true|1)
 * - MAESTRO_MULTI_USER - Alias for MAESTRO_SESSION_SCOPE
 * - MAESTRO_MEMORY_BASE - Durable memory service base URL
 * - MAESTRO_MEMORY_ACCESS_TOKEN - Override bearer token for durable memory service
 * - MAESTRO_MEMORY_TEAM_ID - Optional team scope for durable memory service
 * - MAESTRO_SHARED_MEMORY_BASE - Shared memory base URL (Cloudflare Durable Objects worker)
 * - MAESTRO_SHARED_MEMORY_API_KEY - API key for shared memory service
 * - MAESTRO_SHARED_MEMORY_SESSION_ID - Override session ID for shared memory sync
 *
 * ### Feature Flags
 * - MAESTRO_ENABLE_* - Enable specific features
 * - MAESTRO_DISABLE_* - Disable specific features
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("config:env");

/**
 * All recognized MAESTRO_* environment variables.
 */
export const ENV_VARS = {
	// Core settings
	MODEL: "MAESTRO_MODEL",
	MODEL_PROVIDER: "MAESTRO_MODEL_PROVIDER",
	PROFILE: "MAESTRO_PROFILE",
	APPROVAL_POLICY: "MAESTRO_APPROVAL_POLICY",
	SANDBOX_MODE: "MAESTRO_SANDBOX_MODE",

	// Behavior controls
	MAX_OUTPUT_TOKENS: "MAESTRO_MAX_OUTPUT_TOKENS",
	DISABLE_TELEMETRY: "MAESTRO_DISABLE_TELEMETRY",
	DISABLE_TERMINAL_TITLE: "MAESTRO_DISABLE_TERMINAL_TITLE",
	DISABLE_ANIMATIONS: "MAESTRO_DISABLE_ANIMATIONS",
	SAFE_MODE: "MAESTRO_SAFE_MODE",
	CONTEXT_FIREWALL_BLOCKING: "MAESTRO_CONTEXT_FIREWALL_BLOCKING",

	// Subagent configuration
	SUBAGENT_MODEL: "MAESTRO_SUBAGENT_MODEL",
	ORACLE_MODEL: "MAESTRO_ORACLE_MODEL",
	SWARM_MODE: "MAESTRO_SWARM_MODE",
	SWARM_ID: "MAESTRO_SWARM_ID",
	TEAMMATE_ID: "MAESTRO_TEAMMATE_ID",

	// API configuration
	API_KEY_HELPER_TTL_MS: "MAESTRO_API_KEY_HELPER_TTL_MS",
	SKIP_AUTH: "MAESTRO_SKIP_AUTH",
	SKIP_BEDROCK_AUTH: "MAESTRO_SKIP_BEDROCK_AUTH",
	SKIP_VERTEX_AUTH: "MAESTRO_SKIP_VERTEX_AUTH",
	IDENTITY_URL: "MAESTRO_IDENTITY_URL",
	PLATFORM_BASE_URL: "MAESTRO_PLATFORM_BASE_URL",

	// Network configuration
	HTTP_PROXY: "MAESTRO_HTTP_PROXY",
	HTTPS_PROXY: "MAESTRO_HTTPS_PROXY",
	SOCKS_PROXY: "MAESTRO_SOCKS_PROXY",
	NO_PROXY: "MAESTRO_NO_PROXY",

	// Debug configuration
	DEBUG: "MAESTRO_DEBUG",
	LOG_LEVEL: "MAESTRO_LOG_LEVEL",
	USAGE_FILE: "MAESTRO_USAGE_FILE",

	// Session configuration
	NO_SESSION: "MAESTRO_NO_SESSION",
	SESSION_DIR: "MAESTRO_SESSION_DIR",
	SESSION_SCOPE: "MAESTRO_SESSION_SCOPE",
	MULTI_USER: "MAESTRO_MULTI_USER",
	MEMORY_BASE: "MAESTRO_MEMORY_BASE",
	MEMORY_ACCESS_TOKEN: "MAESTRO_MEMORY_ACCESS_TOKEN",
	MEMORY_TEAM_ID: "MAESTRO_MEMORY_TEAM_ID",
	SHARED_MEMORY_BASE: "MAESTRO_SHARED_MEMORY_BASE",
	SHARED_MEMORY_API_KEY: "MAESTRO_SHARED_MEMORY_API_KEY",
	SHARED_MEMORY_SESSION_ID: "MAESTRO_SHARED_MEMORY_SESSION_ID",
} as const;

export type EnvVarName = (typeof ENV_VARS)[keyof typeof ENV_VARS];

/**
 * Get a string environment variable.
 */
export function getEnvString(name: EnvVarName): string | undefined {
	return process.env[name]?.trim() || undefined;
}

/**
 * Get an integer environment variable.
 */
export function getEnvInt(name: EnvVarName): number | undefined {
	const value = process.env[name];
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Get a boolean environment variable.
 * Treats "1", "true", "yes" as true; "0", "false", "no", "" as false.
 */
export function getEnvBool(name: EnvVarName): boolean | undefined {
	const value = process.env[name]?.toLowerCase().trim();
	if (!value) return undefined;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off", ""].includes(value)) return false;
	return undefined;
}

/**
 * Get a list environment variable (comma-separated).
 */
export function getEnvList(name: EnvVarName): string[] | undefined {
	const value = process.env[name];
	if (!value) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Check if a feature flag is enabled.
 * Checks MAESTRO_ENABLE_<feature> env var.
 */
export function isFeatureEnabled(feature: string): boolean {
	const envName = `MAESTRO_ENABLE_${feature.toUpperCase().replace(/-/g, "_")}`;
	const value = process.env[envName]?.toLowerCase().trim();
	return ["1", "true", "yes", "on"].includes(value || "");
}

/**
 * Check if a feature flag is disabled.
 * Checks MAESTRO_DISABLE_<feature> env var.
 */
export function isFeatureDisabled(feature: string): boolean {
	const envName = `MAESTRO_DISABLE_${feature.toUpperCase().replace(/-/g, "_")}`;
	const value = process.env[envName]?.toLowerCase().trim();
	return ["1", "true", "yes", "on"].includes(value || "");
}

/**
 * Get proxy configuration from environment variables.
 */
export function getProxyConfig(): {
	http?: string;
	https?: string;
	socks?: string;
	noProxy?: string[];
} {
	const config: {
		http?: string;
		https?: string;
		socks?: string;
		noProxy?: string[];
	} = {};

	// Check MAESTRO_* vars first, then standard vars
	const httpProxy =
		getEnvString(ENV_VARS.HTTP_PROXY) ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy;
	if (httpProxy) config.http = httpProxy;

	const httpsProxy =
		getEnvString(ENV_VARS.HTTPS_PROXY) ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy;
	if (httpsProxy) config.https = httpsProxy;

	const socksProxy = getEnvString(ENV_VARS.SOCKS_PROXY);
	if (socksProxy) config.socks = socksProxy;

	const noProxy =
		getEnvList(ENV_VARS.NO_PROXY) ||
		(process.env.NO_PROXY || process.env.no_proxy)
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	if (noProxy && noProxy.length > 0) config.noProxy = noProxy;

	return config;
}

/**
 * Check if we're running in safe mode.
 */
export function isSafeMode(): boolean {
	return getEnvBool(ENV_VARS.SAFE_MODE) ?? false;
}

/**
 * Check if context firewall blocking is enabled.
 * Defaults to true (blocking enabled). Set MAESTRO_CONTEXT_FIREWALL_BLOCKING=0 to disable.
 *
 * When blocking is disabled, sensitive content (API keys, credentials) can be passed
 * through tool arguments without being blocked. This is useful for testing scenarios
 * where you intentionally want to use test API keys.
 */
export function isContextFirewallBlockingEnabled(): boolean {
	return getEnvBool(ENV_VARS.CONTEXT_FIREWALL_BLOCKING) ?? true;
}

/**
 * Check if we're running as part of a swarm.
 */
export function isSwarmMode(): boolean {
	return getEnvBool(ENV_VARS.SWARM_MODE) ?? false;
}

/**
 * Check if telemetry is disabled.
 */
export function isTelemetryDisabled(): boolean {
	return getEnvBool(ENV_VARS.DISABLE_TELEMETRY) ?? false;
}

/**
 * Check if animations are disabled.
 */
export function areAnimationsDisabled(): boolean {
	return getEnvBool(ENV_VARS.DISABLE_ANIMATIONS) ?? false;
}

/**
 * Get max output tokens configuration.
 */
export function getMaxOutputTokens(): number | undefined {
	return getEnvInt(ENV_VARS.MAX_OUTPUT_TOKENS);
}

/**
 * Get subagent model override.
 */
export function getSubagentModel(): string | undefined {
	return getEnvString(ENV_VARS.SUBAGENT_MODEL);
}

/**
 * Log all set MAESTRO_* environment variables (for debugging).
 */
export function logEnvVars(): void {
	const setVars: Record<string, string> = {};

	for (const [key, envName] of Object.entries(ENV_VARS)) {
		const value = process.env[envName];
		if (value !== undefined) {
			// Mask sensitive values
			if (
				envName.includes("KEY") ||
				envName.includes("TOKEN") ||
				envName.includes("SECRET")
			) {
				setVars[key] = "[REDACTED]";
			} else {
				setVars[key] = value;
			}
		}
	}

	if (Object.keys(setVars).length > 0) {
		logger.debug("COMPOSER environment variables", setVars);
	}
}

/**
 * Validate environment variable values and warn about invalid ones.
 */
export function validateEnvVars(): string[] {
	const warnings: string[] = [];

	// Validate APPROVAL_POLICY
	const approvalPolicy = getEnvString(ENV_VARS.APPROVAL_POLICY);
	if (
		approvalPolicy &&
		!["untrusted", "on-failure", "on-request", "never"].includes(approvalPolicy)
	) {
		warnings.push(
			`Invalid MAESTRO_APPROVAL_POLICY: "${approvalPolicy}". Must be one of: untrusted, on-failure, on-request, never`,
		);
	}

	// Validate SANDBOX_MODE
	const sandboxMode = getEnvString(ENV_VARS.SANDBOX_MODE);
	if (
		sandboxMode &&
		!["read-only", "workspace-write", "danger-full-access"].includes(
			sandboxMode,
		)
	) {
		warnings.push(
			`Invalid MAESTRO_SANDBOX_MODE: "${sandboxMode}". Must be one of: read-only, workspace-write, danger-full-access`,
		);
	}

	// Validate LOG_LEVEL
	const logLevel = getEnvString(ENV_VARS.LOG_LEVEL);
	if (logLevel && !["debug", "info", "warn", "error"].includes(logLevel)) {
		warnings.push(
			`Invalid MAESTRO_LOG_LEVEL: "${logLevel}". Must be one of: debug, info, warn, error`,
		);
	}

	// Validate MAX_OUTPUT_TOKENS
	const maxTokens = getEnvString(ENV_VARS.MAX_OUTPUT_TOKENS);
	if (
		maxTokens &&
		(Number.isNaN(Number.parseInt(maxTokens, 10)) ||
			Number.parseInt(maxTokens, 10) < 1)
	) {
		warnings.push(
			`Invalid MAESTRO_MAX_OUTPUT_TOKENS: "${maxTokens}". Must be a positive integer`,
		);
	}

	for (const warning of warnings) {
		logger.warn(warning);
	}

	return warnings;
}
