/**
 * Configuration Module
 *
 * Unified configuration access for Composer. Combines multiple configuration
 * sources with a clear precedence order:
 *
 * 1. CLI flags (--model, --config key=value, --profile)
 * 2. Environment variables (MAESTRO_*)
 * 3. Active TOML profile settings
 * 4. Project config.toml (.maestro/config.toml)
 * 5. Global config.toml (~/.maestro/config.toml)
 * 6. Built-in defaults
 */

export {
	loadConfig,
	clearConfigCache,
	getAvailableProfiles,
	getConfigSummary,
	parseCliOverride,
	applyCliOverride,
	DEFAULT_CONFIG,
	resolveProjectDocCandidateFilenames,
	type ComposerConfig,
	type ApprovalPolicy,
	type SandboxMode,
	type ReasoningEffort,
	type ModelProviderConfig,
	type McpServerConfig,
	type FeaturesConfig,
	type ToolsConfig,
	type OtelConfig,
	type HistoryConfig,
	type TuiConfig,
	type ShellEnvironmentPolicy,
	type SandboxWorkspaceWriteConfig,
	type ProfileConfig,
} from "./toml-config.js";
