import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/mcp/config.js";
import { getPlatformMcpPluginServers } from "../../src/mcp/platform-plugin.js";
import { saveOAuthCredentials } from "../../src/oauth/storage.js";

describe("platform MCP plugin servers", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = join(tmpdir(), `mcp-platform-plugin-${Date.now()}`);
		mkdirSync(join(projectDir, ".maestro"), { recursive: true });
		process.env.MAESTRO_AGENT_DIR = join(projectDir, "agent");
		for (const name of [
			"MAESTRO_AGENT_DIR",
			"MAESTRO_PLATFORM_MCP_ENABLED",
			"MAESTRO_AGENT_MCP_ENABLED",
			"MAESTRO_PLATFORM_MCP_NAME",
			"MAESTRO_AGENT_MCP_NAME",
			"MAESTRO_PLATFORM_MCP_URL",
			"MAESTRO_AGENT_MCP_URL",
			"MAESTRO_EVALOPS_AGENT_MCP_URL",
			"MAESTRO_PLATFORM_MCP_MANIFEST_URL",
			"MAESTRO_AGENT_MCP_MANIFEST_URL",
			"MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL",
			"MAESTRO_PLATFORM_MCP_TOKEN",
			"MAESTRO_AGENT_MCP_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_WORKSPACE_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_SESSION_ID",
			"MAESTRO_AGENT_ID",
			"MAESTRO_EVALOPS_AGENT_ID",
			"MAESTRO_AGENT_RUN_ID",
			"MAESTRO_PLATFORM_MCP_SCOPES",
			"MAESTRO_AGENT_MCP_SCOPES",
			"MAESTRO_EVALOPS_AGENT_MCP_SCOPES",
			"MAESTRO_CEREBRO_MCP_SCOPES",
			"MAESTRO_EVALOPS_INTEGRATION_PROFILE",
			"MAESTRO_INTEGRATION_PROFILE",
			"MAESTRO_EVALOPS_MEMORY_MODE",
			"MAESTRO_MEMORY_MODE",
			"MAESTRO_EVALOPS_RUNTIME_OWNER",
			"MAESTRO_RUNTIME_OWNER",
			"MAESTRO_EVALOPS_SHIM_TYPE",
			"MAESTRO_SHIM_TYPE",
			"MAESTRO_EVALOPS_TRACE_MODE",
			"MAESTRO_TRACE_MODE",
			"MAESTRO_REQUEST_ID",
			"TRACE_ID",
			"OTEL_TRACE_ID",
			"MAESTRO_SURFACE",
		]) {
			if (name !== "MAESTRO_AGENT_DIR") {
				Reflect.deleteProperty(process.env, name);
			}
		}
	});

	afterEach(() => {
		// leave temp dirs for the OS to clean up
	});

	it("builds a plugin-scoped Platform MCP server with auth and correlation headers", () => {
		process.env.MAESTRO_PLATFORM_MCP_URL =
			"https://agent-mcp.evalops.example/mcp/";
		process.env.EVALOPS_TOKEN = "evalops-token";
		process.env.EVALOPS_ORGANIZATION_ID = "workspace-123";
		process.env.MAESTRO_SESSION_ID = "session-123";
		process.env.MAESTRO_AGENT_ID = "agent-maestro";
		process.env.MAESTRO_AGENT_RUN_ID = "run-123";
		process.env.MAESTRO_CEREBRO_MCP_SCOPES = "cerebro:read,cerebro:assert";
		process.env.MAESTRO_REQUEST_ID = "request-123";
		process.env.TRACE_ID = "trace-123";
		process.env.MAESTRO_SURFACE = "MAESTRO_SURFACE_CLI";

		expect(getPlatformMcpPluginServers()).toEqual([
			{
				name: "evalops",
				transport: "http",
				url: "https://agent-mcp.evalops.example/mcp",
				scope: "plugin",
				headers: {
					Authorization: "Bearer evalops-token",
					"Mcp-Session-Id": "session-123",
					"X-EvalOps-Workspace-Id": "workspace-123",
					"X-EvalOps-Session-Id": "session-123",
					"X-EvalOps-Agent-Id": "agent-maestro",
					"X-EvalOps-Agent-Run-Id": "run-123",
					"X-EvalOps-Scopes": "cerebro:read,cerebro:assert",
					"X-EvalOps-Request-Id": "request-123",
					"X-EvalOps-Trace-Id": "trace-123",
					"X-EvalOps-Maestro-Surface": "MAESTRO_SURFACE_CLI",
				},
			},
		]);
	});

	it("prefers env-driven profile headers over stored managed metadata", () => {
		process.env.MAESTRO_PLATFORM_MCP_URL =
			"https://agent-mcp.evalops.example/mcp";
		process.env.EVALOPS_ORGANIZATION_ID = "workspace-123";
		process.env.MAESTRO_EVALOPS_INTEGRATION_PROFILE = "mcp_only";
		process.env.MAESTRO_EVALOPS_MEMORY_MODE = "cerebro";
		process.env.MAESTRO_EVALOPS_RUNTIME_OWNER = "customer";
		process.env.MAESTRO_EVALOPS_SHIM_TYPE = "shim";
		process.env.MAESTRO_EVALOPS_TRACE_MODE = "mcp_events";
		saveOAuthCredentials("evalops", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
			metadata: {
				agentMcp: {
					apiKey: "eoak_stored",
					endpoint: "https://app.evalops.dev/mcp",
					integrationProfile: "managed_runtime",
					memoryMode: "durable",
					runtimeOwner: "evalops",
					shimType: "sdk",
					traceMode: "otlp",
				},
			},
		});

		expect(getPlatformMcpPluginServers()[0]?.headers).toMatchObject({
			"X-EvalOps-Integration-Profile": "mcp_only",
			"X-EvalOps-Memory-Mode": "cerebro",
			"X-EvalOps-Runtime-Owner": "customer",
			"X-EvalOps-Shim-Type": "shim",
			"X-EvalOps-Trace-Mode": "mcp_events",
		});
	});

	it("keeps transport session evidence for existing MCP clients", () => {
		process.env.MAESTRO_PLATFORM_MCP_URL =
			"https://agent-mcp.evalops.example/mcp/";
		process.env.EVALOPS_ORGANIZATION_ID = "workspace-123";
		process.env.MAESTRO_SESSION_ID = "session-123";

		const [server] = getPlatformMcpPluginServers();
		expect(server?.headers).toMatchObject({
			"Mcp-Session-Id": "session-123",
			"X-EvalOps-Session-Id": "session-123",
		});
	});

	it("uses stored maestro init MCP credentials when no env URL is present", () => {
		saveOAuthCredentials("evalops", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
			metadata: {
				agentMcp: {
					agentId: "agent-stored",
					apiKey: "eoak_stored",
					createdAt: "2026-05-03T19:00:00.000Z",
					endpoint: "https://app.evalops.dev/mcp",
					registeredAt: "2026-05-03T19:00:01.000Z",
					runId: "run-stored",
					surface: "cli",
					workspaceId: "org-stored",
				},
			},
		});

		expect(getPlatformMcpPluginServers()).toEqual([
			{
				name: "evalops",
				transport: "http",
				url: "https://app.evalops.dev/mcp",
				scope: "plugin",
				headers: {
					Authorization: "Bearer eoak_stored",
					"X-EvalOps-Agent-Id": "agent-stored",
					"X-EvalOps-Agent-Run-Id": "run-stored",
					"X-EvalOps-Maestro-Surface": "maestro",
					"X-EvalOps-Workspace-Id": "org-stored",
				},
			},
		]);
	});

	it("normalizes public app and manifest URLs to the Platform MCP endpoint", () => {
		process.env.MAESTRO_PLATFORM_MCP_URL = "https://app.evalops.dev";
		expect(getPlatformMcpPluginServers()[0]?.url).toBe(
			"https://app.evalops.dev/mcp",
		);

		Reflect.deleteProperty(process.env, "MAESTRO_PLATFORM_MCP_URL");
		process.env.MAESTRO_PLATFORM_MCP_MANIFEST_URL =
			"https://app.evalops.dev/.well-known/evalops/agent-mcp.json";
		expect(getPlatformMcpPluginServers()[0]?.url).toBe(
			"https://app.evalops.dev/mcp",
		);
	});

	it("merges the Platform MCP plugin server into the runtime MCP config", () => {
		process.env.MAESTRO_PLATFORM_MCP_URL =
			"https://agent-mcp.evalops.example/mcp";
		process.env.EVALOPS_ORGANIZATION_ID = "workspace-123";
		writeFileSync(
			join(projectDir, ".maestro", "mcp.json"),
			JSON.stringify(
				{
					servers: [
						{
							name: "filesystem",
							transport: "stdio",
							command: "node",
							args: ["server.js"],
						},
					],
				},
				null,
				2,
			),
		);

		const config = loadMcpConfig(projectDir, { includeEnvLimits: true });
		expect(config.servers.map((server) => server.name)).toEqual([
			"filesystem",
			"evalops",
		]);
		expect(
			config.servers.find((server) => server.name === "evalops"),
		).toMatchObject({
			scope: "plugin",
			transport: "http",
			url: "https://agent-mcp.evalops.example/mcp",
			headers: {
				"X-EvalOps-Workspace-Id": "workspace-123",
			},
		});
	});

	it("does not add the Platform MCP server when explicitly disabled", () => {
		process.env.MAESTRO_PLATFORM_MCP_ENABLED = "false";
		process.env.MAESTRO_PLATFORM_MCP_URL =
			"https://agent-mcp.evalops.example/mcp";

		expect(getPlatformMcpPluginServers()).toEqual([]);
		expect(loadMcpConfig(projectDir).servers).toEqual([]);
	});
});
