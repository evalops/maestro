import {
	getEnvValue,
	normalizeBaseUrl,
	resolveConfiguredToken,
	resolveWorkspaceId,
} from "../platform/client.js";
import type { McpServerConfig } from "./types.js";

const PLATFORM_MCP_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const PLATFORM_MCP_ENABLED_ENV_VARS = [
	"MAESTRO_PLATFORM_MCP_ENABLED",
	"MAESTRO_AGENT_MCP_ENABLED",
] as const;
const PLATFORM_MCP_NAME_ENV_VARS = [
	"MAESTRO_PLATFORM_MCP_NAME",
	"MAESTRO_AGENT_MCP_NAME",
] as const;
const PLATFORM_MCP_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_MCP_URL",
	"MAESTRO_AGENT_MCP_URL",
	"MAESTRO_EVALOPS_AGENT_MCP_URL",
] as const;
const PLATFORM_MCP_TOKEN_ENV_VARS = [
	"MAESTRO_PLATFORM_MCP_TOKEN",
	"MAESTRO_AGENT_MCP_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;
const PLATFORM_MCP_WORKSPACE_ENV_VARS = [
	"MAESTRO_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;
const DEFAULT_PLATFORM_MCP_SERVER_NAME = "evalops";

function isPlatformMcpExplicitlyDisabled(): boolean {
	const enabled = getEnvValue(PLATFORM_MCP_ENABLED_ENV_VARS);
	if (!enabled) {
		return false;
	}
	return PLATFORM_MCP_DISABLED_VALUES.has(enabled.trim().toLowerCase());
}

function buildPlatformMcpHeaders(): Record<string, string> | undefined {
	const token = resolveConfiguredToken(PLATFORM_MCP_TOKEN_ENV_VARS);
	const workspaceId = resolveWorkspaceId(PLATFORM_MCP_WORKSPACE_ENV_VARS);
	const headers = Object.fromEntries(
		Object.entries({
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Mcp-Session-Id": getEnvValue(["MAESTRO_SESSION_ID"]),
			"X-EvalOps-Workspace-Id": workspaceId,
			"X-EvalOps-Agent-Run-Id": getEnvValue(["MAESTRO_AGENT_RUN_ID"]),
			"X-EvalOps-Request-Id": getEnvValue(["MAESTRO_REQUEST_ID"]),
			"X-EvalOps-Trace-Id": getEnvValue(["TRACE_ID", "OTEL_TRACE_ID"]),
			"X-EvalOps-Maestro-Surface":
				getEnvValue(["MAESTRO_SURFACE"]) ?? "maestro",
		}).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1].trim().length > 0,
		),
	);
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function getPlatformMcpPluginServers(): McpServerConfig[] {
	if (isPlatformMcpExplicitlyDisabled()) {
		return [];
	}

	const url = getEnvValue(PLATFORM_MCP_URL_ENV_VARS);
	if (!url) {
		return [];
	}

	return [
		{
			name:
				getEnvValue(PLATFORM_MCP_NAME_ENV_VARS) ??
				DEFAULT_PLATFORM_MCP_SERVER_NAME,
			transport: "http",
			url: normalizeBaseUrl(url),
			headers: buildPlatformMcpHeaders(),
			scope: "plugin",
		},
	];
}
