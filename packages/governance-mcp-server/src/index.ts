/**
 * @evalops/governance-mcp-server — Programmatic API.
 *
 * Use `createGovernanceMcpServer()` to create a server instance
 * that you can connect to any MCP transport.
 *
 * @example
 * ```typescript
 * import { createGovernanceMcpServer } from "@evalops/governance-mcp-server";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 * const { server } = createGovernanceMcpServer();
 * await server.connect(new StdioServerTransport());
 * ```
 *
 * @module governance-mcp-server
 */

export {
	createGovernanceMcpServer,
	type CreateGovernanceMcpServerOptions,
} from "./server.js";
export { registerGovernanceTools } from "./tools.js";
