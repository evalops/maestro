/**
 * MCP Configuration - Model Context Protocol Server Management
 *
 * This module handles loading and merging MCP (Model Context Protocol)
 * server configurations from multiple sources. MCP servers extend the
 * agent's capabilities with additional tools and integrations.
 *
 * ## Configuration Sources (precedence order)
 *
 * 1. **Enterprise**: `~/.maestro/enterprise/mcp.json` (highest; legacy
 *    Composer enterprise MCP config remains a fallback)
 * 2. **Plugin**: Programmatically provided servers
 * 3. **Project**: `.maestro/mcp.json` in project root
 * 4. **Local**: `.maestro/mcp.local.json` (git-ignored)
 * 5. **User**: `~/.maestro/mcp.json` (lowest; legacy Composer user MCP config
 *    remains a fallback)
 *
 * ## Configuration Format
 *
 * ```json
 * {
 *   "servers": [
 *     {
 *       "name": "my-server",
 *       "transport": "stdio",
 *       "command": "node",
 *       "args": ["path/to/server.js"],
 *       "env": { "API_KEY": "${MY_API_KEY}" }
 *     }
 *   ],
 *   "mcpServers": {
 *     "another-server": {
 *       "command": "python",
 *       "args": ["-m", "my_mcp_server"]
 *     }
 *   }
 * }
 * ```
 *
 * ## Transport Types
 *
 * | Transport | Description                              |
 * |-----------|------------------------------------------|
 * | stdio     | Communicate via stdin/stdout (default)   |
 * | http      | HTTP-based transport                     |
 * | sse       | Server-Sent Events transport             |
 *
 * ## Environment Variable Expansion
 *
 * Supports `${VAR}` and `${VAR:-default}` syntax in:
 * - command, args, url, cwd, headersHelper
 * - env values
 * - headers
 *
 * @module mcp/config
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { PATHS } from "../config/constants.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { getHomeDir, resolveEnvPath } from "../utils/path-expansion.js";
import { uniquePaths } from "../utils/path-utils.js";
import { defaultEnvValidators, evaluateEnvValidators } from "./env-limits.js";
import { getPlatformMcpPluginServers } from "./platform-plugin.js";
import {
	type McpAuthPresetInput,
	type McpServerInput,
	mcpAuthPresetSchema,
	mcpConfigSchema,
	mcpServerSchema,
	mcpWorkspaceTrustDefaultSchema,
	mcpWorkspaceTrustEntrySchema,
} from "./schema.js";
import type {
	McpAuthPresetConfig,
	McpConfig,
	McpScope,
	McpServerConfig,
	McpWorkspaceTrustDefault,
	McpWorkspaceTrustEntry,
} from "./types.js";

const logger = createLogger("mcp:config");

const PROJECT_CONFIG_NAME = ".maestro/mcp.json";
const LOCAL_CONFIG_NAME = ".maestro/mcp.local.json";

const getEnterpriseConfigPathOverride = (): string | null =>
	resolveEnvPath(process.env.MAESTRO_ENTERPRISE_MCP_PATH);

const getDefaultEnterpriseConfigPath = (): string =>
	join(PATHS.MAESTRO_HOME, "enterprise", "mcp.json");

const getEnterpriseConfigPath = (): string =>
	getEnterpriseConfigPathOverride() ?? getDefaultEnterpriseConfigPath();

const getUserConfigPathOverride = (): string | null =>
	resolveEnvPath(process.env.MAESTRO_USER_MCP_PATH);

const getDefaultUserConfigPath = (): string =>
	join(PATHS.MAESTRO_HOME, "mcp.json");

const getUserConfigPath = (): string =>
	getUserConfigPathOverride() ?? getDefaultUserConfigPath();

const getLegacyEnterpriseConfigPath = (): string =>
	join(getHomeDir(), ".composer", "enterprise", "mcp.json");

const getLegacyUserConfigPath = (): string =>
	join(getHomeDir(), ".composer", "mcp.json");

function isConfigFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function selectEffectiveConfigPath(paths: string[]): string {
	return paths.find(isConfigFile) ?? paths[0]!;
}

const getUserConfigPathCandidates = (): string[] => {
	const overridePath = getUserConfigPathOverride();
	if (overridePath) {
		return [overridePath];
	}
	return uniquePaths([getDefaultUserConfigPath(), getLegacyUserConfigPath()]);
};

const getEnterpriseConfigPathCandidates = (): string[] => {
	const overridePath = getEnterpriseConfigPathOverride();
	if (overridePath) {
		return [overridePath];
	}
	return uniquePaths([
		getDefaultEnterpriseConfigPath(),
		getLegacyEnterpriseConfigPath(),
	]);
};

const getEffectiveUserConfigPath = (): string =>
	selectEffectiveConfigPath(getUserConfigPathCandidates());

const getEffectiveEnterpriseConfigPath = (): string =>
	selectEffectiveConfigPath(getEnterpriseConfigPathCandidates());

type ParsedConfig = {
	servers: McpServerConfig[];
	authPresets: McpAuthPresetConfig[];
	trustedWorkspaces: Record<string, McpWorkspaceTrustEntry[]>;
	workspaceTrustDefault?: McpWorkspaceTrustDefault;
};
type RawMcpConfigFile = z.infer<typeof mcpConfigSchema>;
type PersistedMcpAuthPresetConfig = Omit<McpAuthPresetInput, "name">;
type PersistedMcpServerConfig = Omit<McpServerInput, "name">;
export type WritableMcpScope = Exclude<McpScope, "enterprise" | "plugin">;

export interface LoadMcpOptions {
	pluginServers?: McpServerConfig[];
	includeEnvLimits?: boolean;
}

export interface AddMcpServerOptions {
	projectRoot?: string;
	scope: WritableMcpScope;
	server: McpServerInput & { name: string };
}

export interface AddMcpAuthPresetOptions {
	projectRoot?: string;
	scope: WritableMcpScope;
	preset: McpAuthPresetInput & { name: string };
}

export interface RemoveMcpServerOptions {
	projectRoot?: string;
	scope?: WritableMcpScope;
	name: string;
}

export interface RemoveMcpAuthPresetOptions {
	projectRoot?: string;
	scope?: WritableMcpScope;
	name: string;
}

export interface UpdateMcpServerOptions {
	projectRoot?: string;
	scope?: WritableMcpScope;
	name: string;
	server: McpServerInput & { name: string };
}

export interface UpdateMcpAuthPresetOptions {
	projectRoot?: string;
	scope?: WritableMcpScope;
	name: string;
	preset: McpAuthPresetInput & { name: string };
}

export function loadMcpConfig(
	projectRoot?: string,
	options: LoadMcpOptions = {},
): McpConfig {
	const userCfg = parseConfigFile(getEffectiveUserConfigPath(), "user");
	const enterpriseCfg = parseConfigFile(
		getEffectiveEnterpriseConfigPath(),
		"enterprise",
	);
	const projectCfg = projectRoot
		? parseConfigFile(resolve(projectRoot, PROJECT_CONFIG_NAME), "project")
		: { servers: [], authPresets: [], trustedWorkspaces: {} };
	const localCfg = projectRoot
		? parseConfigFile(resolve(projectRoot, LOCAL_CONFIG_NAME), "local")
		: { servers: [], authPresets: [], trustedWorkspaces: {} };
	const pluginCfg: ParsedConfig = {
		servers: [
			...getPlatformMcpPluginServers(),
			...(options.pluginServers ?? []),
		],
		authPresets: [],
		trustedWorkspaces: {},
	};

	const merged = new Map<string, McpServerConfig>();
	const mergedAuthPresets = new Map<string, McpAuthPresetConfig>();
	const mergedTrustedWorkspaces: Record<string, McpWorkspaceTrustEntry[]> = {};
	let workspaceTrustDefault: McpWorkspaceTrustDefault | undefined;
	// precedence: enterprise -> plugin -> project -> local -> user
	// lower precedence first, higher precedence last so later overrides earlier
	for (const src of [userCfg, localCfg, projectCfg, pluginCfg, enterpriseCfg]) {
		for (const authPreset of src.authPresets) {
			mergedAuthPresets.set(authPreset.name, authPreset);
		}
		for (const server of src.servers) {
			// A higher-precedence config can explicitly disable a server defined earlier.
			if (server.enabled === false || server.disabled === true) {
				merged.delete(server.name);
				continue;
			}
			merged.set(server.name, server);
		}
		for (const [serverName, entries] of Object.entries(src.trustedWorkspaces)) {
			mergedTrustedWorkspaces[serverName] = [
				...(mergedTrustedWorkspaces[serverName] ?? []),
				...entries,
			];
		}
		if (src.workspaceTrustDefault) {
			workspaceTrustDefault = src.workspaceTrustDefault;
		}
	}

	const envLimits = options.includeEnvLimits
		? evaluateEnvValidators(defaultEnvValidators)
		: undefined;

	return {
		servers: Array.from(merged.values()),
		authPresets: Array.from(mergedAuthPresets.values()),
		projectRoot: projectRoot ? resolve(projectRoot) : undefined,
		trustedWorkspaces:
			Object.keys(mergedTrustedWorkspaces).length > 0
				? mergedTrustedWorkspaces
				: undefined,
		workspaceTrustDefault,
		envLimits,
	};
}

export function getConfigPaths(projectRoot?: string): string[] {
	const paths = [
		getEffectiveUserConfigPath(),
		getEffectiveEnterpriseConfigPath(),
	];
	if (projectRoot) {
		paths.push(resolve(projectRoot, PROJECT_CONFIG_NAME));
		paths.push(resolve(projectRoot, LOCAL_CONFIG_NAME));
	}
	return paths;
}

export function getWritableMcpConfigPath(
	scope: WritableMcpScope,
	projectRoot = process.cwd(),
): string {
	switch (scope) {
		case "user":
			return getEffectiveUserConfigPath();
		case "project":
			return resolve(projectRoot, PROJECT_CONFIG_NAME);
		case "local":
			return resolve(projectRoot, LOCAL_CONFIG_NAME);
	}
}

export function inferRemoteMcpTransport(url: string): "http" | "sse" {
	return isSseUrl(url) ? "sse" : "http";
}

export function addMcpServerToConfig(options: AddMcpServerOptions): {
	path: string;
} {
	const path = getWritableMcpConfigPath(options.scope, options.projectRoot);
	const validatedServer = mcpServerSchema.parse({
		...options.server,
		transport:
			options.server.transport ??
			(options.server.url
				? inferRemoteMcpTransport(options.server.url)
				: "stdio"),
	});
	const existing = readJsonFile<unknown>(path, { fallback: {} });
	const parsed = mcpConfigSchema.safeParse(existing);
	if (!parsed.success) {
		throw new Error(
			`Invalid MCP config at ${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
		);
	}

	const nextConfig = structuredClone(parsed.data) as RawMcpConfigFile;
	const hasObjectFormat =
		isRecord(nextConfig.mcpServers) || !Array.isArray(nextConfig.servers);
	if (hasObjectFormat) {
		const existingServers = isRecord(nextConfig.mcpServers)
			? nextConfig.mcpServers
			: {};
		if (
			Object.prototype.hasOwnProperty.call(
				existingServers,
				validatedServer.name,
			)
		) {
			throw new Error(
				`MCP server "${validatedServer.name}" already exists in ${path}`,
			);
		}
		nextConfig.mcpServers = {
			...existingServers,
			[validatedServer.name]: buildPersistedServerConfig(validatedServer),
		};
	} else {
		const servers = nextConfig.servers ?? [];
		if (servers.some((server) => server.name === validatedServer.name)) {
			throw new Error(
				`MCP server "${validatedServer.name}" already exists in ${path}`,
			);
		}
		nextConfig.servers = [
			...servers,
			{
				...buildPersistedServerConfig(validatedServer),
				name: validatedServer.name,
			},
		];
	}

	writeJsonFile(path, nextConfig);
	return { path };
}

export function addMcpAuthPresetToConfig(options: AddMcpAuthPresetOptions): {
	path: string;
} {
	const path = getWritableMcpConfigPath(options.scope, options.projectRoot);
	const validatedPreset = mcpAuthPresetSchema.parse(options.preset);
	const existing = readJsonFile<unknown>(path, { fallback: {} });
	const parsed = mcpConfigSchema.safeParse(existing);
	if (!parsed.success) {
		throw new Error(
			`Invalid MCP config at ${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
		);
	}

	const nextConfig = structuredClone(parsed.data) as RawMcpConfigFile;
	const existingPresets = isRecord(nextConfig.authPresets)
		? nextConfig.authPresets
		: {};
	if (
		Object.prototype.hasOwnProperty.call(existingPresets, validatedPreset.name)
	) {
		throw new Error(
			`MCP auth preset "${validatedPreset.name}" already exists in ${path}`,
		);
	}

	nextConfig.authPresets = {
		...existingPresets,
		[validatedPreset.name]: buildPersistedAuthPresetConfig(validatedPreset),
	};

	writeJsonFile(path, nextConfig);
	return { path };
}

export function removeMcpServerFromConfig(options: RemoveMcpServerOptions): {
	path: string;
	scope: WritableMcpScope;
} {
	const projectRoot = options.projectRoot ?? process.cwd();
	const scope = resolveWritableMutationScope(
		options.name,
		options.scope,
		projectRoot,
	);
	const { path, config } = readWritableMcpConfig(scope, projectRoot);
	const nextConfig = structuredClone(config) as RawMcpConfigFile;
	const removed = mutateWritableMcpConfig(nextConfig, options.name, "remove");
	if (!removed) {
		throw new Error(`MCP server "${options.name}" not found in ${path}`);
	}

	writeJsonFile(path, nextConfig);
	return { path, scope };
}

export function removeMcpAuthPresetFromConfig(
	options: RemoveMcpAuthPresetOptions,
): {
	path: string;
	scope: WritableMcpScope;
} {
	const projectRoot = options.projectRoot ?? process.cwd();
	const scope = resolveWritableAuthPresetMutationScope(
		options.name,
		options.scope,
		projectRoot,
	);
	const { path, config } = readWritableMcpConfig(scope, projectRoot);
	const nextConfig = structuredClone(config) as RawMcpConfigFile;
	const removed = mutateWritableMcpAuthPresetConfig(
		nextConfig,
		options.name,
		"remove",
	);
	if (!removed) {
		throw new Error(`MCP auth preset "${options.name}" not found in ${path}`);
	}

	writeJsonFile(path, nextConfig);
	return { path, scope };
}

export function updateMcpServerInConfig(options: UpdateMcpServerOptions): {
	path: string;
	scope: WritableMcpScope;
} {
	const projectRoot = options.projectRoot ?? process.cwd();
	const scope = resolveWritableMutationScope(
		options.name,
		options.scope,
		projectRoot,
	);
	if (options.server.name !== options.name) {
		throw new Error("Renaming MCP servers is not supported by /mcp edit.");
	}

	const validatedServer = mcpServerSchema.parse({
		...options.server,
		transport:
			options.server.transport ??
			(options.server.url
				? inferRemoteMcpTransport(options.server.url)
				: "stdio"),
	});
	const { path, config } = readWritableMcpConfig(scope, projectRoot);
	const nextConfig = structuredClone(config) as RawMcpConfigFile;
	const updated = mutateWritableMcpConfig(nextConfig, options.name, "update", {
		server: validatedServer,
	});
	if (!updated) {
		throw new Error(`MCP server "${options.name}" not found in ${path}`);
	}

	writeJsonFile(path, nextConfig);
	return { path, scope };
}

export function updateMcpAuthPresetInConfig(
	options: UpdateMcpAuthPresetOptions,
): {
	path: string;
	scope: WritableMcpScope;
} {
	const projectRoot = options.projectRoot ?? process.cwd();
	const scope = resolveWritableAuthPresetMutationScope(
		options.name,
		options.scope,
		projectRoot,
	);
	if (options.preset.name !== options.name) {
		throw new Error("Renaming MCP auth presets is not supported.");
	}

	const validatedPreset = mcpAuthPresetSchema.parse(options.preset);
	const { path, config } = readWritableMcpConfig(scope, projectRoot);
	const nextConfig = structuredClone(config) as RawMcpConfigFile;
	const updated = mutateWritableMcpAuthPresetConfig(
		nextConfig,
		options.name,
		"update",
		{
			preset: validatedPreset,
		},
	);
	if (!updated) {
		throw new Error(`MCP auth preset "${options.name}" not found in ${path}`);
	}

	writeJsonFile(path, nextConfig);
	return { path, scope };
}

function parseConfigFile(path: string, scope: McpScope): ParsedConfig {
	if (!isConfigFile(path)) {
		return { servers: [], authPresets: [], trustedWorkspaces: {} };
	}
	try {
		const content = readFileSync(path, "utf-8");
		const json = JSON.parse(content);
		const parsed = mcpConfigSchema.safeParse(json);
		if (!parsed.success) {
			logger.warn("Invalid MCP config", {
				scope,
				path,
				error: parsed.error.issues.map((e) => e.message).join("; "),
			});
			return { servers: [], authPresets: [], trustedWorkspaces: {} };
		}

		const servers: McpServerConfig[] = [];
		const authPresets: McpAuthPresetConfig[] = [];
		if (Array.isArray(parsed.data.servers)) {
			for (const server of parsed.data.servers) {
				const normalized = normalizeServer(server, server.name, scope);
				if (normalized) servers.push(normalized);
			}
		}
		if (parsed.data.mcpServers) {
			for (const [name, raw] of Object.entries(parsed.data.mcpServers)) {
				const merged: McpServerInput | { name: string } = isRecord(raw)
					? ({ ...raw, name } as McpServerInput)
					: { name };
				const normalized = normalizeServer(merged, name, scope);
				if (normalized) servers.push(normalized);
			}
		}
		if (parsed.data.authPresets) {
			for (const [name, raw] of Object.entries(parsed.data.authPresets)) {
				const merged: McpAuthPresetInput | { name: string } = isRecord(raw)
					? ({ ...raw, name } as McpAuthPresetInput)
					: { name };
				const normalized = normalizeAuthPreset(merged, name, scope);
				if (normalized) authPresets.push(normalized);
			}
		}
		return {
			servers,
			authPresets,
			trustedWorkspaces: normalizeTrustedWorkspaces(
				parsed.data.trustedWorkspaces,
				scope,
				path,
			),
			workspaceTrustDefault: normalizeWorkspaceTrustDefault(
				parsed.data.workspaceTrustDefault,
				scope,
				path,
			),
		};
	} catch (error) {
		logger.warn("Failed to parse MCP config file", {
			path,
			scope,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		return { servers: [], authPresets: [], trustedWorkspaces: {} };
	}
}

function normalizeWorkspaceTrustDefault(
	raw: unknown,
	scope: McpScope,
	path: string,
): McpWorkspaceTrustDefault | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const parsed = mcpWorkspaceTrustDefaultSchema.safeParse(raw);
	if (parsed.success) {
		return parsed.data;
	}
	logger.warn("Invalid MCP workspaceTrustDefault", {
		scope,
		path,
		error: parsed.error.issues.map((issue) => issue.message).join("; "),
	});
	return undefined;
}

function normalizeTrustedWorkspaces(
	raw: unknown,
	scope: McpScope,
	path: string,
): Record<string, McpWorkspaceTrustEntry[]> {
	if (raw === undefined) {
		return {};
	}
	if (!isRecord(raw)) {
		logger.warn("Invalid MCP trustedWorkspaces", {
			scope,
			path,
			error: "expected an object keyed by MCP server name",
		});
		return {};
	}
	const trustedWorkspaces: Record<string, McpWorkspaceTrustEntry[]> = {};
	for (const [serverName, entries] of Object.entries(raw)) {
		if (!Array.isArray(entries)) {
			logger.warn("Invalid MCP trustedWorkspaces entry", {
				scope,
				path,
				serverName,
				error: "expected an array of workspace trust entries",
			});
			continue;
		}
		const validEntries: McpWorkspaceTrustEntry[] = [];
		for (const [index, entry] of entries.entries()) {
			const parsed = mcpWorkspaceTrustEntrySchema.safeParse(entry);
			if (!parsed.success) {
				logger.warn("Invalid MCP trusted workspace entry", {
					scope,
					path,
					serverName,
					index,
					error: parsed.error.issues.map((issue) => issue.message).join("; "),
				});
				continue;
			}
			validEntries.push(parsed.data);
		}
		if (validEntries.length > 0) {
			trustedWorkspaces[serverName] = validEntries;
		}
	}
	return trustedWorkspaces;
}

function readWritableMcpConfig(
	scope: WritableMcpScope,
	projectRoot: string,
): {
	path: string;
	config: RawMcpConfigFile;
} {
	const path = getWritableMcpConfigPath(scope, projectRoot);
	const existing = readJsonFile<unknown>(path, { fallback: {} });
	const parsed = mcpConfigSchema.safeParse(existing);
	if (!parsed.success) {
		throw new Error(
			`Invalid MCP config at ${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
		);
	}
	return { path, config: parsed.data };
}

function resolveWritableMutationScope(
	name: string,
	scope: WritableMcpScope | undefined,
	projectRoot: string,
): WritableMcpScope {
	if (scope) {
		return scope;
	}

	const activeServer = loadMcpConfig(projectRoot).servers.find(
		(server) => server.name === name,
	);
	if (!activeServer) {
		throw new Error(`MCP server "${name}" not found in merged config.`);
	}
	if (!isWritableScope(activeServer.scope)) {
		throw new Error(
			`MCP server "${name}" is managed by ${activeServer.scope ?? "an unknown"} scope and cannot be edited here.`,
		);
	}
	return activeServer.scope;
}

function resolveWritableAuthPresetMutationScope(
	name: string,
	scope: WritableMcpScope | undefined,
	projectRoot: string,
): WritableMcpScope {
	if (scope) {
		return scope;
	}

	const activePreset = loadMcpConfig(projectRoot).authPresets.find(
		(preset) => preset.name === name,
	);
	if (!activePreset) {
		throw new Error(`MCP auth preset "${name}" not found in merged config.`);
	}
	if (!isWritableScope(activePreset.scope)) {
		throw new Error(
			`MCP auth preset "${name}" is managed by ${activePreset.scope ?? "an unknown"} scope and cannot be edited here.`,
		);
	}
	return activePreset.scope;
}

function mutateWritableMcpConfig(
	config: RawMcpConfigFile,
	name: string,
	mode: "remove" | "update",
	options?: { server: McpServerInput & { name: string } },
): boolean {
	if (
		isRecord(config.mcpServers) &&
		Object.prototype.hasOwnProperty.call(config.mcpServers, name)
	) {
		if (mode === "remove") {
			delete config.mcpServers[name];
		} else {
			config.mcpServers[name] = buildPersistedServerConfig(options!.server);
		}
		return true;
	}

	if (Array.isArray(config.servers)) {
		const index = config.servers.findIndex((server) => server.name === name);
		if (index >= 0) {
			if (mode === "remove") {
				config.servers.splice(index, 1);
			} else {
				config.servers[index] = {
					...buildPersistedServerConfig(options!.server),
					name: options!.server.name,
				};
			}
			return true;
		}
	}

	return false;
}

function mutateWritableMcpAuthPresetConfig(
	config: RawMcpConfigFile,
	name: string,
	mode: "remove" | "update",
	options?: {
		preset: McpAuthPresetInput & { name: string };
	},
): boolean {
	if (
		isRecord(config.authPresets) &&
		Object.prototype.hasOwnProperty.call(config.authPresets, name)
	) {
		if (mode === "remove") {
			delete config.authPresets[name];
		} else {
			config.authPresets[name] = buildPersistedAuthPresetConfig(
				options!.preset,
			);
		}
		return true;
	}

	return false;
}

function normalizeServer(
	server: McpServerInput,
	name: string,
	scope: McpScope,
): McpServerConfig | null {
	const transport = resolveTransport(server);
	const expanded = expandServerEnv({ ...server, name, transport });

	const validated = mcpServerSchema.safeParse(expanded);
	if (!validated.success) {
		logger.warn("Invalid MCP server entry", {
			scope,
			name,
			error: validated.error.issues.map((e) => e.message).join("; "),
		});
		return null;
	}

	const cleanEnv =
		validated.data.env && typeof validated.data.env === "object"
			? (Object.fromEntries(
					Object.entries(validated.data.env).map(([k, v]) => [
						k,
						String(v ?? ""),
					]),
				) as Record<string, string>)
			: undefined;
	const cleanHeaders =
		validated.data.headers && typeof validated.data.headers === "object"
			? (Object.fromEntries(
					Object.entries(validated.data.headers).map(([k, v]) => [
						k,
						String(v ?? ""),
					]),
				) as Record<string, string>)
			: undefined;

	return {
		...validated.data,
		env: cleanEnv,
		headers: cleanHeaders,
		transport,
		scope,
		enabled: validated.data.enabled ?? validated.data.disabled !== true,
	};
}

function normalizeAuthPreset(
	preset: McpAuthPresetInput,
	name: string,
	scope: McpScope,
): McpAuthPresetConfig | null {
	const expanded = expandAuthPresetEnv({ ...preset, name });
	const validated = mcpAuthPresetSchema.safeParse(expanded);
	if (!validated.success) {
		logger.warn("Invalid MCP auth preset entry", {
			scope,
			name,
			error: validated.error.issues.map((e) => e.message).join("; "),
		});
		return null;
	}

	const cleanHeaders =
		validated.data.headers && typeof validated.data.headers === "object"
			? (Object.fromEntries(
					Object.entries(validated.data.headers).map(([k, v]) => [
						k,
						String(v ?? ""),
					]),
				) as Record<string, string>)
			: undefined;

	return {
		...validated.data,
		headers: cleanHeaders,
		scope,
	};
}

function resolveTransport(
	server: McpServerInput,
): McpServerConfig["transport"] {
	if (
		server.transport &&
		(server.transport === "stdio" ||
			server.transport === "http" ||
			server.transport === "sse")
	) {
		return server.transport;
	}
	if (server.url) {
		return isSseUrl(server.url) ? "sse" : "http";
	}
	return "stdio";
}

function isSseUrl(rawUrl: string): boolean {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.hostname.startsWith("sse.")) return true;
		const path = parsed.pathname || "";
		if (path.endsWith("/sse")) return true;
		if (path.includes("/sse/")) return true;
		return false;
	} catch {
		return false;
	}
}

function buildPersistedServerConfig(
	server: McpServerInput & { name: string },
): PersistedMcpServerConfig {
	return {
		transport: server.transport,
		command: server.command,
		args: server.args,
		env: server.env,
		cwd: server.cwd,
		url: server.url,
		headers: server.headers,
		headersHelper: server.headersHelper,
		authPreset: server.authPreset,
		timeout: server.timeout,
		enabled: server.enabled,
		disabled: server.disabled,
	};
}

function buildPersistedAuthPresetConfig(
	preset: McpAuthPresetInput & { name: string },
): PersistedMcpAuthPresetConfig {
	return {
		headers: preset.headers,
		headersHelper: preset.headersHelper,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isWritableScope(
	value: McpScope | undefined,
): value is WritableMcpScope {
	return value === "local" || value === "project" || value === "user";
}

function expandValue(
	value: string | undefined,
	context: { kind: "server" | "authPreset"; name: string },
): string | undefined {
	if (!value) return value;
	return value.replace(/\$\{([^}]+)\}/g, (_match, expr: unknown) => {
		const [name, fallback] = String(expr).split(":-");
		const val = name ? process.env[name] : undefined;
		if (val !== undefined) return val;
		if (fallback !== undefined) return fallback;
		logger.debug("Missing environment variable during MCP expansion", {
			[context.kind]: context.name,
			variable: name,
		});
		return _match;
	});
}

function expandServerEnv(
	server: McpServerInput & {
		transport: McpServerConfig["transport"];
		name: string;
	},
): McpServerInput {
	const expand = (value?: string) =>
		expandValue(value, { kind: "server", name: server.name });

	return {
		...server,
		command: expand(server.command),
		args: server.args
			? server.args.map((v) => expand(String(v)) ?? "")
			: undefined,
		env: server.env
			? Object.fromEntries(
					Object.entries(server.env).map(([k, v]) => [
						k,
						expand(typeof v === "string" ? v : undefined) ?? "",
					]),
				)
			: undefined,
		url: expand(server.url),
		headers: server.headers
			? Object.fromEntries(
					Object.entries(server.headers).map(([k, v]) => {
						const expanded =
							expand(typeof v === "string" ? v : undefined) ?? "";
						return [k, expanded] as [string, string];
					}),
				)
			: undefined,
		headersHelper: expand(server.headersHelper),
		authPreset: expand(server.authPreset),
		cwd: expand(server.cwd),
	};
}

function expandAuthPresetEnv(
	preset: McpAuthPresetInput & { name: string },
): McpAuthPresetInput {
	const expand = (value?: string) =>
		expandValue(value, { kind: "authPreset", name: preset.name });

	return {
		...preset,
		headers: preset.headers
			? Object.fromEntries(
					Object.entries(preset.headers).map(([k, v]) => {
						const expanded =
							expand(typeof v === "string" ? v : undefined) ?? "";
						return [k, expanded] as [string, string];
					}),
				)
			: undefined,
		headersHelper: expand(preset.headersHelper),
	};
}
