/**
 * Factory for creating a governance MCP server.
 *
 * @module governance-mcp-server/server
 */

import {
	GovernanceEngine,
	type GovernanceEngineConfig,
} from "@evalops/governance";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGovernanceTools } from "./tools.js";

export interface CreateGovernanceMcpServerOptions {
	/** Configuration for the governance engine */
	engineConfig?: GovernanceEngineConfig;
}

/**
 * Create a governance MCP server with all tools registered.
 */
export function createGovernanceMcpServer(
	options?: CreateGovernanceMcpServerOptions,
): { server: McpServer; engine: GovernanceEngine } {
	const engine = new GovernanceEngine(options?.engineConfig);

	const server = new McpServer(
		{
			name: "governance",
			version: "0.10.0",
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	registerGovernanceTools(server, engine);

	return { server, engine };
}
