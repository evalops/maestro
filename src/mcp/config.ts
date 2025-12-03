import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createLogger } from "../utils/logger.js";
import { defaultEnvValidators, evaluateEnvValidators } from "./env-limits.js";
import {
	type McpServerInput,
	mcpConfigSchema,
	mcpServerSchema,
} from "./schema.js";
import type { McpConfig, McpScope, McpServerConfig } from "./types.js";

const logger = createLogger("mcp:config");

const PROJECT_CONFIG_NAME = ".composer/mcp.json";
const LOCAL_CONFIG_NAME = ".composer/mcp.local.json";

const getEnterpriseConfigPath = (): string =>
	process.env.COMPOSER_ENTERPRISE_MCP_PATH ??
	join(homedir(), ".composer", "enterprise", "mcp.json");

const getUserConfigPath = (): string =>
	process.env.COMPOSER_USER_MCP_PATH ??
	join(homedir(), ".composer", "mcp.json");

type ParsedConfig = { servers: McpServerConfig[] };

export interface LoadMcpOptions {
	pluginServers?: McpServerConfig[];
	includeEnvLimits?: boolean;
}

export function loadMcpConfig(
	projectRoot?: string,
	options: LoadMcpOptions = {},
): McpConfig {
	const userCfg = parseConfigFile(getUserConfigPath(), "user");
	const enterpriseCfg = parseConfigFile(
		getEnterpriseConfigPath(),
		"enterprise",
	);
	const projectCfg = projectRoot
		? parseConfigFile(resolve(projectRoot, PROJECT_CONFIG_NAME), "project")
		: { servers: [] };
	const localCfg = projectRoot
		? parseConfigFile(resolve(projectRoot, LOCAL_CONFIG_NAME), "local")
		: { servers: [] };
	const pluginCfg: ParsedConfig = { servers: options.pluginServers ?? [] };

	const merged = new Map<string, McpServerConfig>();
	// precedence: enterprise -> plugin -> project -> local -> user
	// lower precedence first, higher precedence last so later overrides earlier
	for (const src of [userCfg, localCfg, projectCfg, pluginCfg, enterpriseCfg]) {
		for (const server of src.servers) {
			// A higher-precedence config can explicitly disable a server defined earlier.
			if (server.enabled === false || server.disabled === true) {
				merged.delete(server.name);
				continue;
			}
			merged.set(server.name, server);
		}
	}

	const envLimits = options.includeEnvLimits
		? evaluateEnvValidators(defaultEnvValidators)
		: undefined;

	return { servers: Array.from(merged.values()), envLimits };
}

export function getConfigPaths(projectRoot?: string): string[] {
	const paths = [getUserConfigPath(), getEnterpriseConfigPath()];
	if (projectRoot) {
		paths.push(resolve(projectRoot, PROJECT_CONFIG_NAME));
		paths.push(resolve(projectRoot, LOCAL_CONFIG_NAME));
	}
	return paths;
}

function parseConfigFile(path: string, scope: McpScope): ParsedConfig {
	if (!existsSync(path)) {
		return { servers: [] };
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
			return { servers: [] };
		}

		const servers: McpServerConfig[] = [];
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
		return { servers };
	} catch (error) {
		logger.warn("Failed to parse MCP config file", {
			path,
			scope,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		return { servers: [] };
	}
}

function normalizeServer(
	server: McpServerInput,
	name: string,
	scope: McpScope,
): McpServerConfig | null {
	const transport = resolveTransport(server);
	const expanded = expandEnv({ ...server, name, transport });

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

function expandEnv(
	server: McpServerInput & {
		transport: McpServerConfig["transport"];
		name: string;
	},
): McpServerInput {
	const expand = (value?: string) => {
		if (!value) return value;
		return value.replace(/\$\{([^}]+)\}/g, (_match, expr: unknown) => {
			const [name, fallback] = String(expr).split(":-");
			const val = process.env[name];
			if (val !== undefined) return val;
			if (fallback !== undefined) return fallback;
			logger.debug("Missing environment variable during MCP expansion", {
				server: server.name,
				variable: name,
			});
			return _match;
		});
	};

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
		cwd: expand(server.cwd),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
