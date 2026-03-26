/**
 * TOML-based Configuration System with Profiles
 *
 * Ported from OpenAI Codex (MIT License) config pattern.
 * Supports:
 * - ~/.maestro/config.toml (global config)
 * - .maestro/config.toml (project config - shared, committed to git)
 * - .maestro/config.local.toml (local overrides - gitignored)
 * - Named profiles for different configurations
 * - Environment variable overrides
 * - CLI flag overrides
 *
 * Configuration precedence (highest first):
 * 1. CLI flags (--model, --config key=value)
 * 2. Environment variables (MAESTRO_*)
 * 3. Active profile settings
 * 4. Local config.local.toml (personal overrides)
 * 5. Project config.toml (shared)
 * 6. Global config.toml
 * 7. Built-in defaults
 *
 * The config.local.toml file follows Claude Code's settings.local.json pattern,
 * allowing users to have personal settings that don't get committed to git.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { parse as parseTOML } from "smol-toml";
import { createLogger } from "../utils/logger.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import { PATHS } from "./constants.js";

const logger = createLogger("config:toml");

// ─────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────

export type ApprovalPolicy =
	| "untrusted"
	| "on-failure"
	| "on-request"
	| "never";
export type SandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ModelProviderConfig {
	name: string;
	base_url: string;
	env_key?: string;
	wire_api?: "chat" | "responses";
	query_params?: Record<string, string>;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;
	request_max_retries?: number;
	stream_max_retries?: number;
	stream_idle_timeout_ms?: number;
}

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	bearer_token_env_var?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;
	enabled?: boolean;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	enabled_tools?: string[];
	disabled_tools?: string[];
}

export interface FeaturesConfig {
	web_search_request?: boolean;
	view_image_tool?: boolean;
	ghost_commit?: boolean;
	[key: string]: boolean | undefined;
}

export interface ToolsConfig {
	web_search?: boolean;
	view_image?: boolean;
}

export interface OtelConfig {
	environment?: string;
	exporter?:
		| "none"
		| { "otlp-http": OtlpHttpConfig }
		| { "otlp-grpc": OtlpGrpcConfig };
	log_user_prompt?: boolean;
}

export interface OtlpHttpConfig {
	endpoint: string;
	protocol?: "binary" | "json";
	headers?: Record<string, string>;
}

export interface OtlpGrpcConfig {
	endpoint: string;
	headers?: Record<string, string>;
}

export interface RetryConfig {
	enabled?: boolean; // default: true
	max_retries?: number; // default: 3
	base_delay_ms?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
}

export interface HistoryConfig {
	persistence?: "save-all" | "none";
	max_bytes?: number;
}

export interface TuiConfig {
	notifications?: boolean | string[];
	animations?: boolean;
}

export interface ShellEnvironmentPolicy {
	inherit?: "all" | "core" | "none";
	ignore_default_excludes?: boolean;
	exclude?: string[];
	set?: Record<string, string>;
	include_only?: string[];
}

export interface SandboxWorkspaceWriteConfig {
	writable_roots?: string[];
	network_access?: boolean;
	exclude_tmpdir_env_var?: boolean;
	exclude_slash_tmp?: boolean;
}

export interface ProfileConfig {
	model?: string;
	model_provider?: string;
	approval_policy?: ApprovalPolicy;
	sandbox_mode?: SandboxMode;
	model_reasoning_effort?: ReasoningEffort;
	model_reasoning_summary?: "auto" | "concise" | "detailed" | "none";
	model_verbosity?: "low" | "medium" | "high";
	// Allow any other config keys
	[key: string]: unknown;
}

export interface ComposerConfig {
	// Model settings
	model?: string;
	model_provider?: string;
	model_context_window?: number;
	model_reasoning_effort?: ReasoningEffort;
	model_reasoning_summary?: "auto" | "concise" | "detailed" | "none";
	model_verbosity?: "low" | "medium" | "high";
	model_supports_reasoning_summaries?: boolean;

	// Execution environment
	approval_policy?: ApprovalPolicy;
	sandbox_mode?: SandboxMode;
	sandbox_workspace_write?: SandboxWorkspaceWriteConfig;
	shell_environment_policy?: ShellEnvironmentPolicy;

	// Providers
	model_providers?: Record<string, ModelProviderConfig>;

	// MCP
	mcp_servers?: Record<string, McpServerConfig>;

	// Features
	features?: FeaturesConfig;
	tools?: ToolsConfig;

	// Observability
	otel?: OtelConfig;
	notify?: string[];
	hide_agent_reasoning?: boolean;
	show_raw_agent_reasoning?: boolean;

	// History
	history?: HistoryConfig;

	// Retry on transient errors
	retry?: RetryConfig;

	// TUI
	tui?: TuiConfig;

	// Project docs
	project_doc_max_bytes?: number;
	project_doc_fallback_filenames?: string[];

	// Profiles
	profile?: string;
	profiles?: Record<string, ProfileConfig>;

	// File opener
	file_opener?: "vscode" | "vscode-insiders" | "windsurf" | "cursor" | "none";

	// Instructions
	instructions?: string;
	experimental_instructions_file?: string;

	// Trust
	projects?: Record<string, { trust_level?: "trusted" | "untrusted" }>;
}

// ─────────────────────────────────────────────────────────────
// Validation Schema (loose, allows extra keys)
// ─────────────────────────────────────────────────────────────

const ApprovalPolicySchema = Type.Union([
	Type.Literal("untrusted"),
	Type.Literal("on-failure"),
	Type.Literal("on-request"),
	Type.Literal("never"),
]);

const SandboxModeSchema = Type.Union([
	Type.Literal("read-only"),
	Type.Literal("workspace-write"),
	Type.Literal("danger-full-access"),
]);

const ReasoningEffortSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);

const ModelReasoningSummarySchema = Type.Union([
	Type.Literal("auto"),
	Type.Literal("concise"),
	Type.Literal("detailed"),
	Type.Literal("none"),
]);

const ModelVerbositySchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);

const ModelProviderConfigSchema = Type.Object(
	{
		name: Type.Optional(Type.String()),
		base_url: Type.Optional(Type.String()),
		env_key: Type.Optional(Type.String()),
		wire_api: Type.Optional(
			Type.Union([Type.Literal("chat"), Type.Literal("responses")]),
		),
		query_params: Type.Optional(Type.Record(Type.String(), Type.String())),
		http_headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		env_http_headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		request_max_retries: Type.Optional(Type.Number({ minimum: 0 })),
		stream_max_retries: Type.Optional(Type.Number({ minimum: 0 })),
		stream_idle_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: true },
);

const McpServerConfigSchema = Type.Object(
	{
		command: Type.Optional(Type.String()),
		args: Type.Optional(Type.Array(Type.String())),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		cwd: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()),
		bearer_token_env_var: Type.Optional(Type.String()),
		http_headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		env_http_headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		enabled: Type.Optional(Type.Boolean()),
		startup_timeout_sec: Type.Optional(Type.Number({ minimum: 0 })),
		tool_timeout_sec: Type.Optional(Type.Number({ minimum: 0 })),
		enabled_tools: Type.Optional(Type.Array(Type.String())),
		disabled_tools: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);

const FeaturesConfigSchema = Type.Object(
	{
		web_search_request: Type.Optional(Type.Boolean()),
		view_image_tool: Type.Optional(Type.Boolean()),
		ghost_commit: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: Type.Boolean() },
);

const ToolsConfigSchema = Type.Object(
	{
		web_search: Type.Optional(Type.Boolean()),
		view_image: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: Type.Boolean() },
);

const OtlpHttpConfigSchema = Type.Object(
	{
		endpoint: Type.String(),
		protocol: Type.Optional(
			Type.Union([Type.Literal("binary"), Type.Literal("json")]),
		),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: true },
);

const OtlpGrpcConfigSchema = Type.Object(
	{
		endpoint: Type.String(),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: true },
);

const OtelExporterSchema = Type.Union([
	Type.Literal("none"),
	Type.Object(
		{ "otlp-http": OtlpHttpConfigSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ "otlp-grpc": OtlpGrpcConfigSchema },
		{ additionalProperties: false },
	),
]);

const OtelConfigSchema = Type.Object(
	{
		environment: Type.Optional(Type.String()),
		exporter: Type.Optional(OtelExporterSchema),
		log_user_prompt: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

const RetryConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		max_retries: Type.Optional(Type.Number({ minimum: 0 })),
		base_delay_ms: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: true },
);

const HistoryConfigSchema = Type.Object(
	{
		persistence: Type.Optional(
			Type.Union([Type.Literal("save-all"), Type.Literal("none")]),
		),
		max_bytes: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: true },
);

const TuiConfigSchema = Type.Object(
	{
		notifications: Type.Optional(
			Type.Union([Type.Boolean(), Type.Array(Type.String())]),
		),
		animations: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

const ShellEnvironmentPolicySchema = Type.Object(
	{
		inherit: Type.Optional(
			Type.Union([
				Type.Literal("all"),
				Type.Literal("core"),
				Type.Literal("none"),
			]),
		),
		ignore_default_excludes: Type.Optional(Type.Boolean()),
		exclude: Type.Optional(Type.Array(Type.String())),
		set: Type.Optional(Type.Record(Type.String(), Type.String())),
		include_only: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);

const SandboxWorkspaceWriteConfigSchema = Type.Object(
	{
		writable_roots: Type.Optional(Type.Array(Type.String())),
		network_access: Type.Optional(Type.Boolean()),
		exclude_tmpdir_env_var: Type.Optional(Type.Boolean()),
		exclude_slash_tmp: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

const ProfileConfigSchema = Type.Object(
	{
		model: Type.Optional(Type.String()),
		model_provider: Type.Optional(Type.String()),
		approval_policy: Type.Optional(ApprovalPolicySchema),
		sandbox_mode: Type.Optional(SandboxModeSchema),
		model_reasoning_effort: Type.Optional(ReasoningEffortSchema),
		model_reasoning_summary: Type.Optional(ModelReasoningSummarySchema),
		model_verbosity: Type.Optional(ModelVerbositySchema),
	},
	{ additionalProperties: true },
);

const ComposerConfigSchema = Type.Object(
	{
		model: Type.Optional(Type.String()),
		model_provider: Type.Optional(Type.String()),
		model_context_window: Type.Optional(Type.Number({ minimum: 0 })),
		model_reasoning_effort: Type.Optional(ReasoningEffortSchema),
		model_reasoning_summary: Type.Optional(ModelReasoningSummarySchema),
		model_verbosity: Type.Optional(ModelVerbositySchema),
		model_supports_reasoning_summaries: Type.Optional(Type.Boolean()),
		approval_policy: Type.Optional(ApprovalPolicySchema),
		sandbox_mode: Type.Optional(SandboxModeSchema),
		sandbox_workspace_write: Type.Optional(SandboxWorkspaceWriteConfigSchema),
		shell_environment_policy: Type.Optional(ShellEnvironmentPolicySchema),
		model_providers: Type.Optional(
			Type.Record(Type.String(), ModelProviderConfigSchema),
		),
		mcp_servers: Type.Optional(
			Type.Record(Type.String(), McpServerConfigSchema),
		),
		features: Type.Optional(FeaturesConfigSchema),
		tools: Type.Optional(ToolsConfigSchema),
		otel: Type.Optional(OtelConfigSchema),
		notify: Type.Optional(Type.Array(Type.String())),
		hide_agent_reasoning: Type.Optional(Type.Boolean()),
		show_raw_agent_reasoning: Type.Optional(Type.Boolean()),
		history: Type.Optional(HistoryConfigSchema),
		retry: Type.Optional(RetryConfigSchema),
		tui: Type.Optional(TuiConfigSchema),
		project_doc_max_bytes: Type.Optional(Type.Number({ minimum: 0 })),
		project_doc_fallback_filenames: Type.Optional(Type.Array(Type.String())),
		profile: Type.Optional(Type.String()),
		profiles: Type.Optional(Type.Record(Type.String(), ProfileConfigSchema)),
		file_opener: Type.Optional(
			Type.Union([
				Type.Literal("vscode"),
				Type.Literal("vscode-insiders"),
				Type.Literal("windsurf"),
				Type.Literal("cursor"),
				Type.Literal("none"),
			]),
		),
		instructions: Type.Optional(Type.String()),
		experimental_instructions_file: Type.Optional(Type.String()),
		projects: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object(
					{
						trust_level: Type.Optional(
							Type.Union([Type.Literal("trusted"), Type.Literal("untrusted")]),
						),
					},
					{ additionalProperties: true },
				),
			),
		),
	},
	{ additionalProperties: true },
);

const validateConfig = compileTypeboxSchema(ComposerConfigSchema);

// ─────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ComposerConfig = {
	model: "claude-sonnet-4-20250514",
	model_provider: "anthropic",
	approval_policy: "untrusted",
	sandbox_mode: "workspace-write",
	model_reasoning_effort: "medium",
	features: {
		view_image_tool: true,
	},
	history: {
		persistence: "save-all",
	},
	retry: {
		enabled: true,
		max_retries: 3,
		base_delay_ms: 2000,
	},
	tui: {
		notifications: true,
		animations: true,
	},
	file_opener: "vscode",
	project_doc_max_bytes: 32 * 1024,
	project_doc_fallback_filenames: ["CLAUDE.md"],
};

// ─────────────────────────────────────────────────────────────
// Configuration Loading
// ─────────────────────────────────────────────────────────────

let cachedConfig: ComposerConfig | null = null;
let cachedWorkspaceDir: string | null = null;
let cachedProfileName: string | null = null;

/**
 * Deep merge two objects, with source values overwriting target values.
 */
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
	const result = { ...target } as Record<string, unknown>;

	for (const key of Object.keys(source)) {
		const sourceValue = (source as Record<string, unknown>)[key];
		const targetValue = result[key];

		if (
			sourceValue !== undefined &&
			typeof sourceValue === "object" &&
			sourceValue !== null &&
			!Array.isArray(sourceValue) &&
			typeof targetValue === "object" &&
			targetValue !== null &&
			!Array.isArray(targetValue)
		) {
			result[key] = deepMerge(
				targetValue as Record<string, unknown>,
				sourceValue as Partial<Record<string, unknown>>,
			);
		} else if (sourceValue !== undefined) {
			result[key] = sourceValue;
		}
	}

	return result as T;
}

/**
 * Parse a TOML configuration file.
 */
function parseConfigFile(path: string): ComposerConfig | null {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = parseTOML(content);
		if (!validateConfig(parsed)) {
			const message =
				validateConfig.errors
					?.map(
						(err) => `${err.instancePath || "/"} ${err.message ?? "invalid"}`,
					)
					.join("; ") ?? "Invalid config";
			logger.warn("Invalid config file", { path, error: message });
			return null;
		}
		logger.debug("Parsed config file", { path });
		return parsed as ComposerConfig;
	} catch (error) {
		logger.warn("Failed to parse config file", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Apply environment variable overrides.
 */
function applyEnvOverrides(config: ComposerConfig): ComposerConfig {
	const result = { ...config };

	// MAESTRO_MODEL
	if (process.env.MAESTRO_MODEL) {
		result.model = process.env.MAESTRO_MODEL;
	}

	// MAESTRO_MODEL_PROVIDER
	if (process.env.MAESTRO_MODEL_PROVIDER) {
		result.model_provider = process.env.MAESTRO_MODEL_PROVIDER;
	}

	// MAESTRO_APPROVAL_POLICY
	if (process.env.MAESTRO_APPROVAL_POLICY) {
		const policy = process.env.MAESTRO_APPROVAL_POLICY as ApprovalPolicy;
		if (["untrusted", "on-failure", "on-request", "never"].includes(policy)) {
			result.approval_policy = policy;
		}
	}

	// MAESTRO_SANDBOX_MODE
	if (process.env.MAESTRO_SANDBOX_MODE) {
		const mode = process.env.MAESTRO_SANDBOX_MODE as SandboxMode;
		if (["read-only", "workspace-write", "danger-full-access"].includes(mode)) {
			result.sandbox_mode = mode;
		}
	}

	// MAESTRO_PROFILE
	if (process.env.MAESTRO_PROFILE) {
		result.profile = process.env.MAESTRO_PROFILE;
	}

	// MAESTRO_HISTORY_PERSISTENCE
	if (process.env.MAESTRO_HISTORY_PERSISTENCE) {
		const persistence =
			process.env.MAESTRO_HISTORY_PERSISTENCE.trim().toLowerCase();
		if (
			persistence === "save-all" ||
			persistence === "none" ||
			persistence === "save"
		) {
			result.history = {
				...(result.history ?? {}),
				persistence: persistence === "save" ? "save-all" : persistence,
			};
		}
	}

	// MAESTRO_HISTORY_MAX_BYTES
	if (process.env.MAESTRO_HISTORY_MAX_BYTES) {
		const parsed = Number.parseInt(process.env.MAESTRO_HISTORY_MAX_BYTES, 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			result.history = {
				...(result.history ?? {}),
				max_bytes: parsed,
			};
		}
	}

	return result;
}

/**
 * Apply profile settings to configuration.
 */
function applyProfile(
	config: ComposerConfig,
	profileName: string,
): ComposerConfig {
	if (!config.profiles || !config.profiles[profileName]) {
		logger.warn("Profile not found", { profile: profileName });
		return config;
	}

	const profile = config.profiles[profileName];
	const result = deepMerge(config, profile as Partial<ComposerConfig>);

	logger.debug("Applied profile", { profile: profileName });
	return result;
}

/**
 * Load configuration from files and environment.
 *
 * @param workspaceDir - The current workspace directory
 * @param profileName - Optional profile name to activate
 * @param cliOverrides - Optional CLI flag overrides
 */
export function loadConfig(
	workspaceDir: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): ComposerConfig {
	// Check cache
	if (
		cachedConfig &&
		cachedWorkspaceDir === workspaceDir &&
		cachedProfileName === (profileName ?? null)
	) {
		if (!cliOverrides || Object.keys(cliOverrides).length === 0) {
			return cachedConfig;
		}
		return deepMerge(cachedConfig, cliOverrides);
	}

	// Start with defaults
	let config = { ...DEFAULT_CONFIG };

	// Load global config
	const globalPath = join(PATHS.MAESTRO_HOME, "config.toml");
	const globalConfig = parseConfigFile(globalPath);
	if (globalConfig) {
		config = deepMerge(config, globalConfig);
	}

	// Load project config (shared, committed to git)
	const projectPath = join(workspaceDir, ".maestro", "config.toml");
	const projectConfig = parseConfigFile(projectPath);
	if (projectConfig) {
		config = deepMerge(config, projectConfig);
	}

	// Load local config (personal overrides, gitignored)
	// This follows Claude Code's pattern of settings.local.json
	const localPath = join(workspaceDir, ".maestro", "config.local.toml");
	const localConfig = parseConfigFile(localPath);
	if (localConfig) {
		config = deepMerge(config, localConfig);
		logger.debug("Applied local config overrides", { path: localPath });
	}

	// Apply environment overrides
	config = applyEnvOverrides(config);

	// Determine active profile
	const activeProfile = profileName ?? config.profile;
	if (activeProfile) {
		config = applyProfile(config, activeProfile);
	}

	// Apply CLI overrides (highest precedence)
	if (cliOverrides && Object.keys(cliOverrides).length > 0) {
		config = deepMerge(config, cliOverrides);
	}

	// Cache the result (without CLI overrides)
	cachedConfig = config;
	cachedWorkspaceDir = workspaceDir;
	cachedProfileName = profileName ?? null;

	logger.info("Loaded configuration", {
		global: globalConfig !== null,
		project: projectConfig !== null,
		profile: activeProfile,
	});

	return config;
}

/**
 * Clear the configuration cache.
 */
export function clearConfigCache(): void {
	cachedConfig = null;
	cachedWorkspaceDir = null;
	cachedProfileName = null;
}

/**
 * Get a specific configuration value with type safety.
 */
export function getConfigValue<K extends keyof ComposerConfig>(
	config: ComposerConfig,
	key: K,
): ComposerConfig[K] {
	return config[key];
}

/**
 * Get the list of available profiles.
 */
export function getAvailableProfiles(workspaceDir: string): string[] {
	const config = loadConfig(workspaceDir);
	if (!config.profiles) {
		return [];
	}
	return Object.keys(config.profiles);
}

/**
 * Get a summary of the current configuration for display.
 */
export function getConfigSummary(workspaceDir: string): string {
	const config = loadConfig(workspaceDir);
	const lines: string[] = [];

	lines.push("Current Configuration");
	lines.push("─".repeat(40));
	lines.push(`Model: ${config.model ?? "default"}`);
	lines.push(`Provider: ${config.model_provider ?? "anthropic"}`);
	lines.push(`Approval Policy: ${config.approval_policy ?? "untrusted"}`);
	lines.push(`Sandbox Mode: ${config.sandbox_mode ?? "workspace-write"}`);

	if (config.profile) {
		lines.push(`Active Profile: ${config.profile}`);
	}

	const profiles = getAvailableProfiles(workspaceDir);
	if (profiles.length > 0) {
		lines.push(`Available Profiles: ${profiles.join(", ")}`);
	}

	return lines.join("\n");
}

/**
 * Parse a CLI config override in the format "key=value".
 * Supports nested keys with dots (e.g., "model_providers.openai.base_url").
 */
export function parseCliOverride(
	override: string,
): { key: string; value: unknown } | null {
	const eqIndex = override.indexOf("=");
	if (eqIndex <= 0) {
		return null;
	}

	const key = override.slice(0, eqIndex).trim();
	let valueStr = override.slice(eqIndex + 1).trim();

	// Try to parse as TOML value
	try {
		// Wrap in a table to parse
		const tomlStr = `value = ${valueStr}`;
		const parsed = parseTOML(tomlStr) as { value: unknown };
		return { key, value: parsed.value };
	} catch {
		// If parsing fails, treat as string
		// Remove surrounding quotes if present
		if (
			(valueStr.startsWith('"') && valueStr.endsWith('"')) ||
			(valueStr.startsWith("'") && valueStr.endsWith("'"))
		) {
			valueStr = valueStr.slice(1, -1);
		}
		return { key, value: valueStr };
	}
}

/**
 * Apply a parsed CLI override to a configuration object.
 */
export function applyCliOverride(
	config: ComposerConfig,
	key: string,
	value: unknown,
): ComposerConfig {
	const keys = key.split(".");
	const result = { ...config };

	// Navigate to the nested key
	let current: Record<string, unknown> = result as Record<string, unknown>;
	for (let i = 0; i < keys.length - 1; i++) {
		const k = keys[i]!;
		if (current[k] === undefined || typeof current[k] !== "object") {
			current[k] = {};
		}
		current = current[k] as Record<string, unknown>;
	}

	// Set the value
	const finalKey = keys[keys.length - 1];
	if (finalKey !== undefined) {
		current[finalKey] = value;
	}

	return result;
}
