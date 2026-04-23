import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/mcp/config.js";
import { getPlatformMcpPluginServers } from "../../src/mcp/platform-plugin.js";

describe("platform MCP plugin servers", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = join(tmpdir(), `mcp-platform-plugin-${Date.now()}`);
		mkdirSync(join(projectDir, ".maestro"), { recursive: true });
		for (const name of [
			"MAESTRO_PLATFORM_MCP_ENABLED",
			"MAESTRO_AGENT_MCP_ENABLED",
			"MAESTRO_PLATFORM_MCP_NAME",
			"MAESTRO_AGENT_MCP_NAME",
			"MAESTRO_PLATFORM_MCP_URL",
			"MAESTRO_AGENT_MCP_URL",
			"MAESTRO_EVALOPS_AGENT_MCP_URL",
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
			"MAESTRO_AGENT_RUN_ID",
			"MAESTRO_REQUEST_ID",
			"TRACE_ID",
			"OTEL_TRACE_ID",
			"MAESTRO_SURFACE",
		]) {
			Reflect.deleteProperty(process.env, name);
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
		process.env.MAESTRO_AGENT_RUN_ID = "run-123";
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
					"X-EvalOps-Agent-Run-Id": "run-123",
					"X-EvalOps-Request-Id": "request-123",
					"X-EvalOps-Trace-Id": "trace-123",
					"X-EvalOps-Maestro-Surface": "MAESTRO_SURFACE_CLI",
				},
			},
		]);
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
