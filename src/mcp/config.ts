import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type { McpConfig, McpServerConfig } from "./types.js";

const logger = createLogger("mcp:config");

const GLOBAL_CONFIG_PATH = join(homedir(), ".composer", "mcp.json");
const PROJECT_CONFIG_NAME = ".composer/mcp.json";

function parseConfigFile(path: string): McpConfig | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);
		return validateConfig(parsed);
	} catch (error) {
		logger.warn("Failed to parse config", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function validateConfig(config: unknown): McpConfig | null {
	if (!config || typeof config !== "object") {
		return null;
	}

	const cfg = config as Record<string, unknown>;

	// Handle both { servers: [...] } and { mcpServers: {...} } formats
	let servers: McpServerConfig[] = [];

	if (Array.isArray(cfg.servers)) {
		servers = cfg.servers.filter(isValidServerConfig);
	} else if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
		// Claude Desktop / VS Code format: { mcpServers: { name: { command, args, ... } } }
		const mcpServers = cfg.mcpServers as Record<string, unknown>;
		for (const [name, serverCfg] of Object.entries(mcpServers)) {
			if (serverCfg && typeof serverCfg === "object") {
				const srv = serverCfg as Record<string, unknown>;
				const normalized: McpServerConfig = {
					name,
					transport: "stdio",
					command: typeof srv.command === "string" ? srv.command : undefined,
					args: Array.isArray(srv.args) ? srv.args : undefined,
					env:
						srv.env && typeof srv.env === "object"
							? (srv.env as Record<string, string>)
							: undefined,
					cwd: typeof srv.cwd === "string" ? srv.cwd : undefined,
					url: typeof srv.url === "string" ? srv.url : undefined,
					enabled: srv.disabled !== true,
				};
				// Determine transport from config
				// Default to http for URL-based servers; use sse only if explicitly indicated
				if (normalized.url) {
					normalized.transport =
						normalized.url.endsWith("/sse") ||
						normalized.url.includes("/sse/") ||
						normalized.url.includes("://sse.")
							? "sse"
							: "http";
				}
				if (isValidServerConfig(normalized)) {
					servers.push(normalized);
				}
			}
		}
	}

	return { servers };
}

function isValidServerConfig(cfg: unknown): cfg is McpServerConfig {
	if (!cfg || typeof cfg !== "object") {
		return false;
	}
	const c = cfg as Record<string, unknown>;
	if (typeof c.name !== "string" || !c.name) {
		return false;
	}
	const transport = c.transport ?? "stdio";
	if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
		return false;
	}
	// Stdio requires command
	if (transport === "stdio" && typeof c.command !== "string") {
		return false;
	}
	// HTTP/SSE requires url
	if (
		(transport === "http" || transport === "sse") &&
		typeof c.url !== "string"
	) {
		return false;
	}
	return true;
}

export function loadMcpConfig(projectRoot?: string): McpConfig {
	const globalConfig = parseConfigFile(GLOBAL_CONFIG_PATH);
	const projectConfig = projectRoot
		? parseConfigFile(join(projectRoot, PROJECT_CONFIG_NAME))
		: null;

	// Merge configs: project overrides global by server name
	const serverMap = new Map<string, McpServerConfig>();

	for (const server of globalConfig?.servers ?? []) {
		serverMap.set(server.name, server);
	}
	for (const server of projectConfig?.servers ?? []) {
		serverMap.set(server.name, server);
	}

	return {
		servers: Array.from(serverMap.values()).filter((s) => s.enabled !== false),
	};
}

export function getConfigPaths(projectRoot?: string): string[] {
	const paths = [GLOBAL_CONFIG_PATH];
	if (projectRoot) {
		paths.push(join(projectRoot, PROJECT_CONFIG_NAME));
	}
	return paths;
}
