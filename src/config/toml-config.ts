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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import { parsePackageSpec } from "../packages/loader.js";
import {
	formatPackageSource,
	parsePackageSource,
} from "../packages/sources.js";
import type { PackageSpec } from "../packages/types.js";
import { writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { getHomeDir } from "../utils/path-expansion.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import { PATHS, getAgentDir } from "./constants.js";

const logger = createLogger("config:toml");

const PROJECT_SECURITY_KEYS = [
	"approval_policy",
	"sandbox_mode",
	"sandbox_workspace_write",
	"shell_environment_policy",
	"model_providers",
	"mcp_servers",
	"instructions",
	"experimental_instructions_file",
	"project_doc_max_bytes",
	"project_doc_fallback_filenames",
	"profile",
	"projects",
	"packages",
] as const satisfies readonly (keyof ComposerConfig)[];

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

	// Packages
	packages?: PackageSpec[];

	// Trust
	projects?: Record<string, { trust_level?: "trusted" | "untrusted" }>;
}

export interface ConfiguredPackageSpec {
	spec: PackageSpec;
	cwd: string;
	scope: "user" | "project" | "local";
	configPath: string;
}

export type WritablePackageScope = ConfiguredPackageSpec["scope"];

export interface AddConfiguredPackageSpecOptions {
	workspaceDir?: string;
	scope: WritablePackageScope;
	spec: PackageSpec;
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
}

export interface RemoveConfiguredPackageSpecOptions {
	workspaceDir?: string;
	scope?: WritablePackageScope;
	spec: string;
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
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

const PackageSpecSchema = Type.Union([
	Type.String(),
	Type.Object(
		{
			source: Type.String(),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: true },
	),
]);

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
		packages: Type.Optional(Type.Array(PackageSpecSchema)),
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
	model: "gpt-5.5",
	model_provider: "openai-codex",
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

export function resolveProjectDocCandidateFilenames(
	config?: ComposerConfig,
): string[] {
	const fallback =
		config?.project_doc_fallback_filenames ??
		DEFAULT_CONFIG.project_doc_fallback_filenames ??
		[];
	const merged = [...PATHS.AGENT_CONTEXT_FILES, ...fallback];
	return Array.from(new Set(merged));
}

export type PromptProjectDocSourceKind = "global" | "project";

export type PromptProjectDocDiagnosticSeverity = "info" | "warning";

export interface PromptProjectDocManifestEntry {
	path: string;
	sourceKind: PromptProjectDocSourceKind;
	scopeDir: string;
	candidateName: string;
	bytesRead: number;
	truncated: boolean;
	contentHash: string;
	precedenceIndex: number;
	content: string;
	originalSize?: number;
	maxBytes?: number;
}

export interface PromptProjectDocDiagnostic {
	code:
		| "budget_exhausted"
		| "duplicate_skipped"
		| "multiple_instruction_layers"
		| "read_failed"
		| "truncated";
	severity: PromptProjectDocDiagnosticSeverity;
	message: string;
	path?: string;
	scopeDir?: string;
}

export interface PromptProjectDocManifest {
	cwd: string;
	candidates: string[];
	maxBytes?: number;
	bytesRead: number;
	entries: PromptProjectDocManifestEntry[];
	diagnostics: PromptProjectDocDiagnostic[];
}

function truncateUtf8ToValidBytes(buffer: Buffer, bytesRead: number): number {
	let end = bytesRead;
	if (end === 0) {
		return 0;
	}

	let start = end - 1;
	while (start >= 0 && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
		start -= 1;
	}

	if (start < 0) {
		return 0;
	}

	const lead = buffer[start]!;
	let expected = 1;
	if ((lead & 0b1000_0000) === 0) {
		expected = 1;
	} else if ((lead & 0b1110_0000) === 0b1100_0000) {
		expected = 2;
	} else if ((lead & 0b1111_0000) === 0b1110_0000) {
		expected = 3;
	} else if ((lead & 0b1111_1000) === 0b1111_0000) {
		expected = 4;
	} else {
		end = start;
	}

	if (start + expected > end) {
		end = start;
	}

	return Math.max(0, end);
}

function hashPromptProjectDocContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function readProjectDocContent(
	filePath: string,
	budget?: number,
): {
	content: string;
	bytesRead: number;
	truncated: boolean;
	originalSize?: number;
	maxBytes?: number;
} {
	const stats = statSync(filePath);
	if (budget !== undefined && budget > 0 && stats.size > budget) {
		const fd = openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(budget);
			const bytesRead = readSync(fd, buffer, 0, budget, 0);
			const validBytes = truncateUtf8ToValidBytes(buffer, bytesRead);
			return {
				content: buffer.slice(0, validBytes).toString("utf-8"),
				bytesRead: validBytes,
				truncated: true,
				originalSize: stats.size,
				maxBytes: budget,
			};
		} finally {
			closeSync(fd);
		}
	}

	const content = readFileSync(filePath, "utf-8");
	return {
		content,
		bytesRead: Buffer.byteLength(content),
		truncated: false,
		originalSize: stats.size,
	};
}

function loadFirstProjectDocInDir(
	dir: string,
	candidates: string[],
	sourceKind: PromptProjectDocSourceKind,
	remainingBytes?: number,
	diagnostics: PromptProjectDocDiagnostic[] = [],
): Omit<PromptProjectDocManifestEntry, "precedenceIndex"> | null {
	if (remainingBytes !== undefined && remainingBytes <= 0) {
		return null;
	}
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			const resolvedPath = resolve(filePath);
			let read: ReturnType<typeof readProjectDocContent>;
			try {
				read = readProjectDocContent(resolvedPath, remainingBytes);
			} catch (error) {
				diagnostics.push({
					code: "read_failed",
					severity: "warning",
					message: `Could not read instruction file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
					path: resolvedPath,
					scopeDir: resolve(dir),
				});
				continue;
			}
			const note = read.truncated
				? `\n\n[Truncated to ${read.bytesRead} bytes from ${read.originalSize} bytes.]`
				: "";
			const content = `${read.content}${note}`;
			return {
				path: resolvedPath,
				sourceKind,
				scopeDir: resolve(dir),
				candidateName: filename,
				bytesRead: read.bytesRead,
				truncated: read.truncated,
				contentHash: hashPromptProjectDocContent(read.content),
				content,
				originalSize: read.originalSize,
				maxBytes: read.maxBytes,
			};
		}
	}
	return null;
}

export function resolveProjectDocGlobalDirectories(): string[] {
	return Array.from(
		new Set([resolve(getAgentDir()), resolve(getHomeDir(), ".config")]),
	);
}

function resolveProjectDocAncestorDirectories(cwd: string): string[] {
	const directories: string[] = [];
	let currentDir = resolve(cwd);
	const root = resolve("/");

	while (true) {
		directories.push(currentDir);
		if (currentDir === root) {
			break;
		}

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	directories.reverse();
	return directories;
}

export function loadPromptProjectDocManifest(
	cwdOverride?: string,
	config?: ComposerConfig,
): PromptProjectDocManifest {
	const cwd = resolve(cwdOverride ?? process.cwd());
	const resolvedOptions = resolveRuntimeConfigResolutionOptions(cwd);
	const resolvedConfig =
		config ??
		loadConfig(cwd, resolvedOptions.profileName, resolvedOptions.cliOverrides);
	const candidates = resolveProjectDocCandidateFilenames(resolvedConfig);
	const maxBytesRaw = resolvedConfig.project_doc_max_bytes;
	const maxBytes =
		typeof maxBytesRaw === "number"
			? Math.max(0, Math.floor(maxBytesRaw))
			: undefined;
	let remainingBytes = maxBytes;
	const entries: PromptProjectDocManifestEntry[] = [];
	const diagnostics: PromptProjectDocDiagnostic[] = [];
	const loadedPaths = new Set<string>();

	const pushEntry = (
		entry: Omit<PromptProjectDocManifestEntry, "precedenceIndex"> | null,
	): void => {
		if (!entry) {
			return;
		}
		const resolvedPath = resolve(entry.path);
		if (loadedPaths.has(resolvedPath)) {
			diagnostics.push({
				code: "duplicate_skipped",
				severity: "warning",
				message: `Skipped duplicate instruction file already loaded from ${resolvedPath}.`,
				path: resolvedPath,
				scopeDir: entry.scopeDir,
			});
			return;
		}

		loadedPaths.add(resolvedPath);
		entries.push({
			...entry,
			path: resolvedPath,
			precedenceIndex: entries.length,
		});
		if (entry.truncated) {
			diagnostics.push({
				code: "truncated",
				severity: "warning",
				message: `Loaded only ${entry.bytesRead} of ${entry.originalSize ?? "unknown"} bytes from ${resolvedPath}.`,
				path: resolvedPath,
				scopeDir: entry.scopeDir,
			});
		}
		if (remainingBytes !== undefined) {
			remainingBytes = Math.max(0, remainingBytes - entry.bytesRead);
		}
	};

	const scanDir = (
		dir: string,
		sourceKind: PromptProjectDocSourceKind,
	): boolean => {
		if (remainingBytes === 0) {
			diagnostics.push({
				code: "budget_exhausted",
				severity: "warning",
				message: `Skipped instruction lookup under ${resolve(dir)} because project_doc_max_bytes was exhausted.`,
				scopeDir: resolve(dir),
			});
			return false;
		}
		pushEntry(
			loadFirstProjectDocInDir(
				dir,
				candidates,
				sourceKind,
				remainingBytes,
				diagnostics,
			),
		);
		return true;
	};

	for (const globalContextDir of resolveProjectDocGlobalDirectories()) {
		if (!scanDir(globalContextDir, "global")) {
			break;
		}
	}

	for (const dir of resolveProjectDocAncestorDirectories(cwd)) {
		if (!scanDir(dir, "project")) {
			break;
		}
	}

	const layerCounts = new Map<string, number>();
	for (const entry of entries) {
		layerCounts.set(
			entry.candidateName,
			(layerCounts.get(entry.candidateName) ?? 0) + 1,
		);
	}
	for (const [candidateName, count] of layerCounts) {
		if (count > 1) {
			diagnostics.push({
				code: "multiple_instruction_layers",
				severity: "info",
				message: `${count} ${candidateName} instruction layers were loaded; later project scopes have higher precedence in the prompt.`,
			});
		}
	}

	return {
		cwd,
		candidates,
		maxBytes,
		bytesRead: entries.reduce((total, entry) => total + entry.bytesRead, 0),
		entries,
		diagnostics,
	};
}

export function resolvePromptLoadedProjectDocPaths(
	cwdOverride?: string,
	config?: ComposerConfig,
): string[] {
	return loadPromptProjectDocManifest(cwdOverride, config).entries.map(
		(entry) => entry.path,
	);
}

function getAppendSystemPromptCandidatePaths(cwdOverride?: string): {
	cwd: string;
	projectPath: string;
	globalPath: string;
} {
	const cwd = resolve(cwdOverride ?? process.cwd());
	return {
		cwd,
		projectPath: resolve(join(cwd, ".maestro", "APPEND_SYSTEM.md")),
		globalPath: resolve(join(getAgentDir(), "APPEND_SYSTEM.md")),
	};
}

export function resolveExistingAppendSystemPromptPaths(
	cwdOverride?: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): string[] {
	const loadedAppendSystemPromptPath = resolveLoadedAppendSystemPromptPath(
		cwdOverride,
		profileName,
		cliOverrides,
	);
	// Use the symlink-safe resolver here: a project APPEND_SYSTEM.md that is a
	// symlink must not be added to the read-restore exclusion set, otherwise the
	// realpath-normalized symlink target (e.g. a regular source file) would be
	// dropped from compaction restore even though the append prompt was never
	// loaded.
	const projectAppendSystemPromptPath =
		resolveProjectAppendSystemPromptPath(cwdOverride);
	return [loadedAppendSystemPromptPath, projectAppendSystemPromptPath].filter(
		(path, index, paths): path is string =>
			path !== null && paths.indexOf(path) === index,
	);
}

export function resolveLoadedAppendSystemPromptPath(
	cwdOverride?: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): string | null {
	const { cwd, globalPath } = getAppendSystemPromptCandidatePaths(cwdOverride);
	const projectPath = resolveProjectAppendSystemPromptPath(cwd);
	const isTrustedProject = isTrustedProjectForAppendSystemPrompt(
		cwd,
		profileName,
		cliOverrides,
	);
	if (projectPath && isTrustedProject) {
		return projectPath;
	}

	if (!isTrustedProject) {
		if (isPathWithinWorkspace(cwd, globalPath)) {
			return null;
		}
		// Canonicalize before the workspace check: an attacker who can choose
		// the agent dir (e.g. via MAESTRO_AGENT_DIR=/proc/self/cwd/.maestro
		// or a parent-dir symlink) can make globalPath lexically resolve
		// outside the workspace while the actual on-disk file lives back
		// inside it, which would otherwise load the repo's APPEND_SYSTEM.md
		// as the trusted "global" prompt.
		if (existsSync(globalPath)) {
			const canonicalGlobalPath = canonicalizePathOrSelf(globalPath);
			const canonicalCwd = canonicalizePathOrSelf(cwd);
			if (isPathWithinWorkspace(canonicalCwd, canonicalGlobalPath)) {
				return null;
			}
		}
	}

	return existsSync(globalPath) ? globalPath : null;
}

function canonicalizePathOrSelf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export function resolveProjectAppendSystemPromptPath(
	cwdOverride?: string,
): string | null {
	const { cwd, projectPath } = getAppendSystemPromptCandidatePaths(cwdOverride);
	return existsSync(projectPath) &&
		isLocalMaestroConfigPathSafe(cwd, projectPath)
		? projectPath
		: null;
}

function isTrustedProjectForAppendSystemPrompt(
	cwd: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): boolean {
	const globalConfig = parseConfigFile(getUserConfigPath());
	const projectConfig = parseConfigFile(join(cwd, ".maestro", "config.toml"));
	const localConfigPath = join(cwd, ".maestro", "config.local.toml");
	const localConfig = parseConfigFile(localConfigPath);
	const trustedLocalConfig =
		localConfig &&
		isGitUntrackedPath(cwd, localConfigPath) &&
		isLocalMaestroConfigPathSafe(cwd, localConfigPath)
			? localConfig
			: null;
	if (!globalConfig && !projectConfig && !localConfig) {
		if (!cliOverrides || Object.keys(cliOverrides).length === 0) {
			return false;
		}
	}

	const resolvedCwd = resolve(cwd);
	const cliProfile =
		typeof cliOverrides?.profile === "string"
			? cliOverrides.profile
			: undefined;
	const envProfile = process.env.MAESTRO_PROFILE?.trim() || undefined;
	// User-controlled layers (global config + proven-untracked local config)
	// can legitimately select the active profile via `profile = "..."`. Repo
	// project config and untrusted local config can also set that field but
	// must not be allowed to steer the profile used by CLI trust overrides —
	// only honor the user-controlled selection here.
	const userControlledConfigProfile =
		(typeof trustedLocalConfig?.profile === "string"
			? trustedLocalConfig.profile
			: undefined) ??
		(typeof globalConfig?.profile === "string"
			? globalConfig.profile
			: undefined);
	const explicitProfile =
		profileName ??
		cliProfile ??
		envProfile ??
		getCachedProfileNameForWorkspace(cwd) ??
		userControlledConfigProfile ??
		undefined;

	// Direct CLI project trust overrides are explicit user intent and therefore
	// outrank on-disk trust state. If conflicting trust values are supplied in a
	// single CLI override bundle, fail closed by honoring untrusted first.
	const cliProfileLayer = explicitProfile
		? (cliOverrides?.profiles?.[explicitProfile] as
				| Partial<ComposerConfig>
				| undefined)
		: undefined;
	const cliTrustLevels = [
		cliOverrides?.projects?.[resolvedCwd]?.trust_level,
		cliProfileLayer?.projects?.[resolvedCwd]?.trust_level,
	].filter((level): level is "trusted" | "untrusted" => Boolean(level));
	if (cliTrustLevels.includes("untrusted")) {
		return false;
	}
	if (cliTrustLevels.includes("trusted")) {
		return true;
	}

	// Denial may be driven by any config layer, including repo-controlled
	// project config and tracked local config: those can only downgrade trust,
	// never grant it, so honoring their profile selection here is safe.
	const denialProfile =
		explicitProfile ??
		applyEnvOverrides(
			deepMerge(
				deepMerge(globalConfig ?? {}, projectConfig ?? {}),
				localConfig ?? {},
			),
		).profile;
	const getLayerProfileEntry = (
		layer: ComposerConfig | null | undefined,
	): Partial<ComposerConfig> | undefined =>
		denialProfile
			? (layer?.profiles?.[denialProfile] as
					| Partial<ComposerConfig>
					| undefined)
			: undefined;
	// User-controlled layers (global config, proven-untracked local config)
	// honor a same-layer profile grant as overriding that same layer's
	// top-level denial. Cross-layer denials (a repo config setting untrusted,
	// or another user layer denying) still apply downstream.
	for (const userLayer of [globalConfig, trustedLocalConfig]) {
		if (!userLayer) {
			continue;
		}
		const layerProfile = getLayerProfileEntry(userLayer);
		const layerProfileGrantsTrust =
			layerProfile?.projects?.[resolvedCwd]?.trust_level === "trusted";
		if (layerProfileGrantsTrust) {
			continue;
		}
		if (userLayer.projects?.[resolvedCwd]?.trust_level === "untrusted") {
			return false;
		}
		if (layerProfile?.projects?.[resolvedCwd]?.trust_level === "untrusted") {
			return false;
		}
	}
	// Repo-controlled layers (committed project config, and any local config
	// that failed the trusted-local proof) are strict deny: a same-layer
	// profile entry cannot lift a denial. A repo cannot grant trust via this
	// path because the grant loop below ignores repo layers entirely.
	const untrustedLocalConfig =
		localConfig && localConfig !== trustedLocalConfig ? localConfig : null;
	for (const repoLayer of [projectConfig, untrustedLocalConfig]) {
		// A top-level untrusted project entry in any layer downgrades trust,
		// including a repo-controlled `.maestro/config.toml`: repo config may
		// only deny, never grant, so honoring its denial respects normal
		// precedence.
		if (repoLayer?.projects?.[resolvedCwd]?.trust_level === "untrusted") {
			return false;
		}
		const layerProfile = getLayerProfileEntry(repoLayer);
		if (layerProfile?.projects?.[resolvedCwd]?.trust_level === "untrusted") {
			return false;
		}
	}

	// Granting trust may only be driven by user-controlled sources: an explicit
	// or cached profile, the user environment, the global config, or a proven
	// git-untracked local config. A committed `profile = "..."` in project config
	// (or a tracked local config) must not be able to activate a global profile
	// that trusts this workspace without the user selecting it.
	const trustProfile =
		explicitProfile ??
		applyEnvOverrides(
			deepMerge(
				deepMerge(globalConfig ?? {}, trustedLocalConfig ?? {}),
				cliOverrides ?? {},
			),
		).profile;
	let trustConfig: ComposerConfig = {};
	for (const configLayer of [globalConfig, trustedLocalConfig, cliOverrides]) {
		if (!configLayer) {
			continue;
		}
		trustConfig = deepMerge(trustConfig, configLayer);
	}
	for (const configLayer of [globalConfig, trustedLocalConfig, cliOverrides]) {
		if (!configLayer) {
			continue;
		}
		if (trustProfile && configLayer.profiles?.[trustProfile]) {
			trustConfig = deepMerge(
				trustConfig,
				configLayer.profiles[trustProfile] as Partial<ComposerConfig>,
			);
		}
	}

	return trustConfig.projects?.[resolvedCwd]?.trust_level === "trusted";
}

function isLocalMaestroConfigPathSafe(
	workspaceDir: string,
	path: string,
): boolean {
	for (const candidate of [join(workspaceDir, ".maestro"), path]) {
		if (!existsSync(candidate)) {
			continue;
		}
		try {
			if (lstatSync(candidate).isSymbolicLink()) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

function isPathWithinWorkspace(
	workspaceDir: string,
	targetPath: string,
): boolean {
	const relativePath = relative(workspaceDir, targetPath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function isGitTrackedPath(workspaceDir: string, target: string): boolean {
	try {
		execFileSync(
			"git",
			[
				"-C",
				workspaceDir,
				"ls-files",
				"--error-unmatch",
				"--",
				relative(workspaceDir, target),
			],
			{ stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

function isGitUntrackedPath(workspaceDir: string, path: string): boolean {
	try {
		const insideWorktree = execFileSync(
			"git",
			["-C", workspaceDir, "rev-parse", "--is-inside-work-tree"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		if (insideWorktree !== "true") {
			return false;
		}
	} catch {
		return false;
	}

	// The leaf file must not be tracked by the repo.
	if (isGitTrackedPath(workspaceDir, path)) {
		return false;
	}

	// Reject the path if any ancestor directory (up to the workspace root) is
	// itself a tracked entry. Directories are not normally listed by git, so a
	// tracked ancestor entry means it is a gitlink/submodule whose contents are
	// controlled by the repo — `git ls-files --error-unmatch` on the leaf would
	// fail there, falsely marking repo-owned content as user-untracked.
	const root = resolve(workspaceDir);
	let ancestor = dirname(resolve(path));
	while (ancestor !== root) {
		const rel = relative(root, ancestor);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
			break;
		}
		if (isGitTrackedPath(workspaceDir, ancestor)) {
			return false;
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) {
			break;
		}
		ancestor = parent;
	}

	return true;
}

// ─────────────────────────────────────────────────────────────
// Configuration Loading
// ─────────────────────────────────────────────────────────────

let cachedConfig: ComposerConfig | null = null;
let cachedWorkspaceDir: string | null = null;
let cachedProfileName: string | null = null;
let cachedTrustProfileName: string | null = null;
let cachedWorkspaceTrusted: boolean | null = null;
let cachedConfigFingerprint: string | null = null;
export interface RuntimeConfigResolutionOptions {
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
}

interface RuntimeConfigResolutionContext
	extends RuntimeConfigResolutionOptions {
	workspaceDir: string;
}

let runtimeConfigResolutionContext: RuntimeConfigResolutionContext | null =
	null;

export function setRuntimeConfigResolutionContext(
	workspaceDir: string,
	options: RuntimeConfigResolutionOptions = {},
): void {
	const hasCliOverrides =
		!!options.cliOverrides && Object.keys(options.cliOverrides).length > 0;
	if (!options.profileName && !hasCliOverrides) {
		runtimeConfigResolutionContext = null;
		return;
	}
	runtimeConfigResolutionContext = {
		workspaceDir: resolve(workspaceDir),
		profileName: options.profileName,
		cliOverrides: hasCliOverrides ? options.cliOverrides : undefined,
	};
}

export function clearRuntimeConfigResolutionContext(): void {
	runtimeConfigResolutionContext = null;
}

export function resolveRuntimeConfigResolutionOptions(
	workspaceDir: string,
	options: RuntimeConfigResolutionOptions = {},
): RuntimeConfigResolutionOptions {
	const runtimeContext =
		runtimeConfigResolutionContext?.workspaceDir === resolve(workspaceDir)
			? runtimeConfigResolutionContext
			: null;
	return {
		profileName: options.profileName ?? runtimeContext?.profileName,
		cliOverrides: options.cliOverrides ?? runtimeContext?.cliOverrides,
	};
}

function getConfigCacheFingerprint(paths: string[]): string {
	return paths
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${path}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("|");
}

function getCachedProfileNameForWorkspace(
	workspaceDir: string,
): string | undefined {
	if (!cachedWorkspaceDir) {
		return undefined;
	}
	return resolve(cachedWorkspaceDir) === resolve(workspaceDir)
		? (cachedProfileName ?? undefined)
		: undefined;
}

/**
 * Deep merge two objects, with source values overwriting target values.
 */
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
	const result = { ...target } as Record<string, unknown>;

	for (const key of Object.keys(source)) {
		// Skip prototype-polluting keys (fixes #2542 defense-in-depth).
		if (key === "__proto__" || key === "constructor" || key === "prototype") {
			continue;
		}
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

function stripProjectSecurityKeys<T extends Record<string, unknown>>(
	config: T,
): T {
	const result = { ...config };
	for (const key of PROJECT_SECURITY_KEYS) {
		delete result[key];
	}
	return result;
}

function sanitizeUntrustedProjectProfile(
	profile: ProfileConfig,
): ProfileConfig {
	return stripProjectSecurityKeys(profile as Record<string, unknown>);
}

function sanitizeUntrustedProjectConfig(
	config: ComposerConfig,
	path: string,
): ComposerConfig {
	const sanitized = stripProjectSecurityKeys(
		config as Record<string, unknown>,
	) as ComposerConfig;

	if (config.profiles) {
		sanitized.profiles = Object.fromEntries(
			Object.entries(config.profiles).map(([name, profile]) => [
				name,
				sanitizeUntrustedProjectProfile(profile),
			]),
		);
	}

	const removedSecurityKeys = PROJECT_SECURITY_KEYS.filter(
		(key) => key in config,
	);
	const sanitizedProfiles = Object.entries(config.profiles ?? {})
		.filter(([, profile]) =>
			PROJECT_SECURITY_KEYS.some((key) => key in profile),
		)
		.map(([name]) => name);

	if (removedSecurityKeys.length > 0 || sanitizedProfiles.length > 0) {
		logger.warn("Ignoring untrusted project config security settings", {
			path,
			keys: removedSecurityKeys,
			profiles: sanitizedProfiles,
		});
	}

	return sanitized;
}

function isWorkspaceTrusted(
	config: ComposerConfig,
	workspaceDir: string,
): boolean {
	const projects = config.projects;
	if (!projects) {
		return false;
	}

	const normalizedWorkspaceDir = resolve(workspaceDir);
	for (const [projectPath, projectConfig] of Object.entries(projects)) {
		if (
			resolve(projectPath) === normalizedWorkspaceDir &&
			projectConfig?.trust_level === "trusted"
		) {
			return true;
		}
	}
	return false;
}

function activeProfileNameForTrust(
	config: ComposerConfig,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): string | undefined {
	if (profileName) {
		return profileName;
	}
	if (typeof cliOverrides?.profile === "string") {
		return cliOverrides.profile;
	}
	if (process.env.MAESTRO_PROFILE) {
		return process.env.MAESTRO_PROFILE;
	}
	return config.profile;
}

function applyGlobalProfileForTrust(
	config: ComposerConfig,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): ComposerConfig {
	const activeProfile = activeProfileNameForTrust(
		config,
		profileName,
		cliOverrides,
	);
	const profile = activeProfile ? config.profiles?.[activeProfile] : undefined;
	return profile
		? deepMerge(config, profile as Partial<ComposerConfig>)
		: config;
}

function applyCliProjectTrustOverrides(
	config: ComposerConfig,
	cliOverrides?: Partial<ComposerConfig>,
): ComposerConfig {
	if (!cliOverrides?.projects) {
		return config;
	}
	return deepMerge(config, { projects: cliOverrides.projects });
}

function buildTrustConfig(
	config: ComposerConfig,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): ComposerConfig {
	return applyCliProjectTrustOverrides(
		applyGlobalProfileForTrust(config, profileName, cliOverrides),
		cliOverrides,
	);
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
			error: sanitizeWithStaticMask(
				error instanceof Error ? error.message : String(error),
			),
		});
		return null;
	}
}

function extractConfiguredPackageSpecs(
	config: ComposerConfig | null,
	configPath: string,
	scope: ConfiguredPackageSpec["scope"],
): ConfiguredPackageSpec[] {
	if (!config?.packages || config.packages.length === 0) {
		return [];
	}

	const configDir = dirname(configPath);
	return config.packages.map((spec) => ({
		spec,
		cwd: configDir,
		scope,
		configPath,
	}));
}

function getUserConfigPath(): string {
	return join(PATHS.MAESTRO_HOME, "config.toml");
}

export function getWritablePackageConfigPath(
	scope: WritablePackageScope,
	workspaceDir = process.cwd(),
): string {
	switch (scope) {
		case "user":
			return getUserConfigPath();
		case "project":
			return join(workspaceDir, ".maestro", "config.toml");
		case "local":
			return join(workspaceDir, ".maestro", "config.local.toml");
	}
}

function readWritableComposerConfig(path: string): ComposerConfig {
	if (!existsSync(path)) {
		return {};
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
			throw new Error(`Invalid config at ${path}: ${message}`);
		}
		return parsed as ComposerConfig;
	} catch (error) {
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(`Failed to parse config at ${path}: ${String(error)}`);
	}
}

function writeComposerConfig(path: string, config: ComposerConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const rendered = stringifyTOML(config as Record<string, unknown>).trim();
	writeTextFileAtomic(path, rendered ? `${rendered}\n` : "", {
		encoding: "utf-8",
	});
	clearConfigCache();
}

function resolvePackageSpecIdentity(spec: PackageSpec, cwd: string): string {
	const [sourceSpec] = parsePackageSpec(spec, cwd);
	return formatPackageSource(parsePackageSource(sourceSpec, cwd));
}

function tryResolvePackageSourceIdentity(
	sourceSpec: string,
	cwd: string,
): string | null {
	try {
		return formatPackageSource(parsePackageSource(sourceSpec, cwd));
	} catch {
		return null;
	}
}

function normalizeRelativeLocalPackagePath(
	configDir: string,
	absolutePath: string,
): string {
	const relativePath = relative(configDir, absolutePath);
	if (!relativePath || relativePath === ".") {
		return "./";
	}
	if (relativePath.startsWith(".") || relativePath.startsWith("/")) {
		return relativePath;
	}
	return `./${relativePath}`;
}

function normalizePackageSpecForStorage(
	spec: PackageSpec,
	configPath: string,
	inputCwd: string,
	scope: WritablePackageScope,
): PackageSpec {
	if (typeof spec === "string") {
		return normalizePackageSourceForStorage(spec, configPath, inputCwd, scope);
	}

	return {
		...spec,
		source: normalizePackageSourceForStorage(
			spec.source,
			configPath,
			inputCwd,
			scope,
		),
	};
}

function normalizePackageSourceForStorage(
	sourceSpec: string,
	configPath: string,
	inputCwd: string,
	scope: WritablePackageScope,
): string {
	const source = parsePackageSource(sourceSpec, inputCwd);
	if (source.type !== "local") {
		return formatPackageSource(source);
	}

	if (scope === "user") {
		return source.path;
	}

	return normalizeRelativeLocalPackagePath(dirname(configPath), source.path);
}

function doesConfiguredPackageMatch(
	spec: PackageSpec,
	configPath: string,
	requestedSpec: string,
	requestedCwd: string,
): boolean {
	const configDir = dirname(configPath);
	const [rawSourceSpec] = parsePackageSpec(spec, configDir);
	if (rawSourceSpec === requestedSpec) {
		return true;
	}

	const requestedIdentity = tryResolvePackageSourceIdentity(
		requestedSpec,
		requestedCwd,
	);
	if (!requestedIdentity) {
		return false;
	}

	return resolvePackageSpecIdentity(spec, configDir) === requestedIdentity;
}

function resolvePackageRemovalScope(
	workspaceDir: string,
	requestedSpec: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): WritablePackageScope {
	const matches = loadConfiguredPackageSpecs(
		workspaceDir,
		profileName,
		cliOverrides,
	).filter((entry) =>
		doesConfiguredPackageMatch(
			entry.spec,
			entry.configPath,
			requestedSpec,
			workspaceDir,
		),
	);
	for (const scope of ["local", "project", "user"] as const) {
		if (matches.some((entry) => entry.scope === scope)) {
			return scope;
		}
	}

	throw new Error(`Configured package "${requestedSpec}" was not found.`);
}

export function addConfiguredPackageSpecToConfig(
	options: AddConfiguredPackageSpecOptions,
): { path: string; scope: WritablePackageScope; spec: PackageSpec } {
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const resolvedOptions = resolveRuntimeConfigResolutionOptions(workspaceDir, {
		profileName: options.profileName,
		cliOverrides: options.cliOverrides,
	});
	const scope = options.scope;
	if (
		scope !== "user" &&
		!isWorkspacePackageConfigTrusted(
			workspaceDir,
			resolvedOptions.profileName,
			resolvedOptions.cliOverrides,
		)
	) {
		throw new Error(
			`Adding package to ${scope} config requires a trusted workspace because ${scope} package config is ignored until trust is granted. Use scope "user" or trust this workspace in global config.`,
		);
	}
	const path = getWritablePackageConfigPath(scope, workspaceDir);
	const config = readWritableComposerConfig(path);
	const configDir = dirname(path);
	const requestedIdentity = resolvePackageSpecIdentity(
		options.spec,
		workspaceDir,
	);
	const existingPackages = [...(config.packages ?? [])];
	const duplicate = existingPackages.find(
		(spec) => resolvePackageSpecIdentity(spec, configDir) === requestedIdentity,
	);
	if (duplicate) {
		const [sourceSpec] = parsePackageSpec(duplicate, configDir);
		throw new Error(`Package "${sourceSpec}" already exists in ${path}.`);
	}

	const storedSpec = normalizePackageSpecForStorage(
		options.spec,
		path,
		workspaceDir,
		scope,
	);
	const nextConfig = structuredClone(config);
	nextConfig.packages = [...existingPackages, storedSpec];
	writeComposerConfig(path, nextConfig);
	return { path, scope, spec: storedSpec };
}

export function removeConfiguredPackageSpecFromConfig(
	options: RemoveConfiguredPackageSpecOptions,
): { path: string; scope: WritablePackageScope; removedCount: number } {
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const scope =
		options.scope ??
		resolvePackageRemovalScope(
			workspaceDir,
			options.spec,
			options.profileName,
			options.cliOverrides,
		);
	const path = getWritablePackageConfigPath(scope, workspaceDir);
	const config = readWritableComposerConfig(path);
	const existingPackages = [...(config.packages ?? [])];
	const remainingPackages = existingPackages.filter(
		(spec) =>
			!doesConfiguredPackageMatch(spec, path, options.spec, workspaceDir),
	);
	const removedCount = existingPackages.length - remainingPackages.length;
	if (removedCount === 0) {
		throw new Error(
			`Configured package "${options.spec}" was not found in ${path}.`,
		);
	}

	const nextConfig = structuredClone(config);
	if (remainingPackages.length > 0) {
		nextConfig.packages = remainingPackages;
	} else {
		delete nextConfig.packages;
	}
	writeComposerConfig(path, nextConfig);
	return { path, scope, removedCount };
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

function normalizeCliOverridesForActiveProfile(
	cliOverrides: Partial<ComposerConfig>,
	activeProfile?: string,
): Partial<ComposerConfig> {
	if (
		activeProfile &&
		typeof cliOverrides.profile === "string" &&
		cliOverrides.profile !== activeProfile
	) {
		const { profile: _ignoredProfile, ...rest } = cliOverrides;
		return rest;
	}
	return cliOverrides;
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
	const resolvedWorkspaceDir = resolve(workspaceDir);
	// Fall back to the runtime config resolution context for callers that
	// reload configuration without re-threading explicit overrides (e.g.
	// `resolveShellEnvironment` from sandbox/bash execution). Without this,
	// a `--config 'projects."<cwd>".trust_level="trusted"'` override granted
	// at startup is dropped on later reloads and project security keys like
	// `shell_environment_policy` get stripped despite the user's explicit
	// trust grant.
	const resolvedOptions = resolveRuntimeConfigResolutionOptions(workspaceDir, {
		profileName,
		cliOverrides,
	});
	const effectiveProfileName = resolvedOptions.profileName;
	const effectiveCliOverrides = resolvedOptions.cliOverrides;
	const requestedProfileName = effectiveProfileName ?? null;
	let config = { ...DEFAULT_CONFIG };
	const globalPath = getUserConfigPath();
	const projectPath = join(workspaceDir, ".maestro", "config.toml");
	const localPath = join(workspaceDir, ".maestro", "config.local.toml");
	const cacheFingerprint = getConfigCacheFingerprint([
		globalPath,
		projectPath,
		localPath,
	]);
	const globalConfig = parseConfigFile(globalPath);
	if (globalConfig) {
		config = deepMerge(config, globalConfig);
	}
	const trustProfileName =
		activeProfileNameForTrust(
			config,
			effectiveProfileName,
			effectiveCliOverrides,
		) ?? null;
	const hasCliOverrides =
		!!effectiveCliOverrides && Object.keys(effectiveCliOverrides).length > 0;
	const workspaceTrusted = isWorkspaceTrusted(
		buildTrustConfig(
			config,
			trustProfileName ?? undefined,
			effectiveCliOverrides,
		),
		workspaceDir,
	);

	// Check cache
	if (
		!hasCliOverrides &&
		cachedConfig &&
		cachedWorkspaceDir === resolvedWorkspaceDir &&
		cachedProfileName === requestedProfileName &&
		cachedTrustProfileName === trustProfileName &&
		cachedWorkspaceTrusted === workspaceTrusted &&
		cachedConfigFingerprint === cacheFingerprint
	) {
		return cachedConfig;
	}

	// Load project config (shared, committed to git)
	const projectConfig = parseConfigFile(projectPath);
	if (projectConfig) {
		const safeProjectConfig = workspaceTrusted
			? projectConfig
			: sanitizeUntrustedProjectConfig(projectConfig, projectPath);
		config = deepMerge(config, safeProjectConfig);
	}

	// Load local config (personal overrides, gitignored)
	// This follows Claude Code's pattern of settings.local.json
	const localConfig = parseConfigFile(localPath);
	if (localConfig) {
		const safeLocalConfig = workspaceTrusted
			? localConfig
			: sanitizeUntrustedProjectConfig(localConfig, localPath);
		config = deepMerge(config, safeLocalConfig);
		logger.debug("Applied local config overrides", { path: localPath });
	}

	// Apply environment overrides
	config = applyEnvOverrides(config);

	// Determine active profile
	const activeProfile = activeProfileNameForTrust(
		config,
		effectiveProfileName,
		effectiveCliOverrides,
	);
	if (activeProfile) {
		config = applyProfile(config, activeProfile);
		config.profile = activeProfile;
	}

	// Apply CLI overrides (highest precedence)
	if (effectiveCliOverrides && Object.keys(effectiveCliOverrides).length > 0) {
		config = deepMerge(
			config,
			normalizeCliOverridesForActiveProfile(
				effectiveCliOverrides,
				activeProfile,
			),
		);
	}

	if (!hasCliOverrides) {
		cachedConfig = config;
		cachedWorkspaceDir = resolvedWorkspaceDir;
		cachedProfileName = requestedProfileName;
		cachedTrustProfileName = trustProfileName;
		cachedWorkspaceTrusted = workspaceTrusted;
		cachedConfigFingerprint = cacheFingerprint;
	} else {
		cachedConfig = null;
		cachedWorkspaceDir = resolvedWorkspaceDir;
		cachedProfileName = requestedProfileName;
		cachedTrustProfileName = trustProfileName;
		cachedWorkspaceTrusted = workspaceTrusted;
		cachedConfigFingerprint = null;
	}

	logger.info("Loaded configuration", {
		global: globalConfig !== null,
		project: projectConfig !== null,
		projectTrusted: workspaceTrusted,
		profile: activeProfile,
	});

	return config;
}

export function loadConfiguredPackageSpecs(
	workspaceDir: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): ConfiguredPackageSpec[] {
	const resolvedOptions = resolveRuntimeConfigResolutionOptions(workspaceDir, {
		profileName,
		cliOverrides,
	});
	const globalPath = getUserConfigPath();
	const projectPath = join(workspaceDir, ".maestro", "config.toml");
	const localPath = join(workspaceDir, ".maestro", "config.local.toml");
	const workspaceTrusted = isWorkspacePackageConfigTrusted(
		workspaceDir,
		resolvedOptions.profileName,
		resolvedOptions.cliOverrides,
	);

	return [
		...extractConfiguredPackageSpecs(
			parseConfigFile(globalPath),
			globalPath,
			"user",
		),
		...(workspaceTrusted
			? [
					...extractConfiguredPackageSpecs(
						parseConfigFile(projectPath),
						projectPath,
						"project",
					),
					...extractConfiguredPackageSpecs(
						parseConfigFile(localPath),
						localPath,
						"local",
					),
				]
			: []),
	];
}

export function isWorkspacePackageConfigTrusted(
	workspaceDir: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): boolean {
	const globalPath = getUserConfigPath();
	const globalConfig = parseConfigFile(globalPath);
	let trustConfig = { ...DEFAULT_CONFIG };
	if (globalConfig) {
		trustConfig = deepMerge(trustConfig, globalConfig);
	}
	return isWorkspaceTrusted(
		buildTrustConfig(trustConfig, profileName, cliOverrides),
		workspaceDir,
	);
}

/**
 * Clear the configuration cache.
 */
export function clearConfigCache(): void {
	cachedConfig = null;
	cachedWorkspaceDir = null;
	cachedProfileName = null;
	cachedTrustProfileName = null;
	cachedWorkspaceTrusted = null;
	cachedConfigFingerprint = null;
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
	lines.push(`Provider: ${config.model_provider ?? "openai-codex"}`);
	lines.push(`Approval Policy: ${config.approval_policy ?? "untrusted"}`);
	lines.push(`Sandbox Mode: ${config.sandbox_mode ?? "workspace-write"}`);

	if (config.profile) {
		lines.push(`Active Profile: ${config.profile}`);
	}

	const profiles = getAvailableProfiles(workspaceDir);
	if (profiles.length > 0) {
		lines.push(`Available Profiles: ${profiles.join(", ")}`);
	}

	const packageCount = loadConfiguredPackageSpecs(workspaceDir).length;
	if (packageCount > 0) {
		lines.push(`Configured Packages: ${packageCount}`);
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
	const keys = splitCliOverrideKey(key);
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

function splitCliOverrideKey(key: string): string[] {
	const keys: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of key) {
		if (quote === '"') {
			if (escaping) {
				current += char;
				escaping = false;
				continue;
			}
			if (char === "\\") {
				escaping = true;
				continue;
			}
			if (char === '"') {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}

		if (quote === "'") {
			if (char === "'") {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ".") {
			keys.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}

	keys.push(current.trim());
	return keys.filter((part) => part.length > 0);
}
