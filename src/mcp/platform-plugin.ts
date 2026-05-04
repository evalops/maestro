import { getStoredEvalOpsAgentMcpMetadata } from "../evalops/agent-bootstrap.js";
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
const PLATFORM_MCP_MANIFEST_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_MCP_MANIFEST_URL",
	"MAESTRO_AGENT_MCP_MANIFEST_URL",
	"MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL",
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
const PLATFORM_MCP_AGENT_ID_ENV_VARS = [
	"MAESTRO_AGENT_ID",
	"MAESTRO_EVALOPS_AGENT_ID",
] as const;
const PLATFORM_MCP_SCOPES_ENV_VARS = [
	"MAESTRO_PLATFORM_MCP_SCOPES",
	"MAESTRO_AGENT_MCP_SCOPES",
	"MAESTRO_EVALOPS_AGENT_MCP_SCOPES",
	"MAESTRO_CEREBRO_MCP_SCOPES",
] as const;
const DEFAULT_PLATFORM_MCP_SERVER_NAME = "evalops";
const AGENT_MCP_MANIFEST_PATH = "/.well-known/evalops/agent-mcp.json";
const AGENT_MCP_PATH = "/mcp";

function isPlatformMcpExplicitlyDisabled(): boolean {
	const enabled = getEnvValue(PLATFORM_MCP_ENABLED_ENV_VARS);
	if (!enabled) {
		return false;
	}
	return PLATFORM_MCP_DISABLED_VALUES.has(enabled.trim().toLowerCase());
}

function buildPlatformMcpHeaders(): Record<string, string> | undefined {
	const stored = getStoredEvalOpsAgentMcpMetadata();
	const token =
		getEnvValue(PLATFORM_MCP_TOKEN_ENV_VARS) ??
		stored?.apiKey ??
		resolveConfiguredToken(PLATFORM_MCP_TOKEN_ENV_VARS);
	const workspaceId =
		resolveWorkspaceId(PLATFORM_MCP_WORKSPACE_ENV_VARS) ?? stored?.workspaceId;
	const headers = Object.fromEntries(
		Object.entries({
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Mcp-Session-Id": getEnvValue(["MAESTRO_SESSION_ID"]),
			"X-EvalOps-Workspace-Id": workspaceId,
			"X-EvalOps-Session-Id": getEnvValue(["MAESTRO_SESSION_ID"]),
			"X-EvalOps-Agent-Id":
				getEnvValue(PLATFORM_MCP_AGENT_ID_ENV_VARS) ?? stored?.agentId,
			"X-EvalOps-Agent-Run-Id":
				getEnvValue(["MAESTRO_AGENT_RUN_ID"]) ?? stored?.runId,
			"X-EvalOps-Scopes": getEnvValue(PLATFORM_MCP_SCOPES_ENV_VARS),
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

function normalizePlatformMcpEndpoint(url: string): string {
	const normalized = normalizeBaseUrl(url);
	try {
		const parsed = new URL(normalized);
		if (
			parsed.pathname === "" ||
			parsed.pathname === "/" ||
			parsed.pathname === AGENT_MCP_MANIFEST_PATH
		) {
			parsed.pathname = AGENT_MCP_PATH;
			parsed.search = "";
			parsed.hash = "";
			return normalizeBaseUrl(parsed.toString());
		}
	} catch {
		// Keep the existing permissive behavior for non-standard local test URLs.
	}
	return normalized;
}

function resolvePlatformMcpURL(): string | undefined {
	return (
		getEnvValue(PLATFORM_MCP_URL_ENV_VARS) ??
		getEnvValue(PLATFORM_MCP_MANIFEST_URL_ENV_VARS) ??
		getStoredEvalOpsAgentMcpMetadata()?.endpoint
	);
}

export function getPlatformMcpPluginServers(): McpServerConfig[] {
	if (isPlatformMcpExplicitlyDisabled()) {
		return [];
	}

	const url = resolvePlatformMcpURL();
	if (!url) {
		return [];
	}

	return [
		{
			name:
				getEnvValue(PLATFORM_MCP_NAME_ENV_VARS) ??
				DEFAULT_PLATFORM_MCP_SERVER_NAME,
			transport: "http",
			url: normalizePlatformMcpEndpoint(url),
			headers: buildPlatformMcpHeaders(),
			scope: "plugin",
		},
	];
}
