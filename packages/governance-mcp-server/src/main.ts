#!/usr/bin/env node
/**
 * CLI entrypoint for the governance MCP server.
 *
 * Supports:
 * - stdio transport (default) for local use with Claude Code, Composer, etc.
 * - HTTP transport via --http --port <port> for remote deployments
 *
 * Usage:
 *   governance-mcp-server                    # stdio mode
 *   governance-mcp-server --http --port 3100 # HTTP mode
 *
 * @module governance-mcp-server/main
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGovernanceMcpServer } from "./server.js";

function parseArgs(argv: string[]): {
	http: boolean;
	port: number;
} {
	let http = false;
	let port = 3100;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--http") {
			http = true;
		} else if (arg === "--port" && argv[i + 1]) {
			port = Number.parseInt(argv[i + 1]!, 10);
			i++;
		}
	}

	if (Number.isNaN(port) || port < 1 || port > 65535) {
		throw new Error("Invalid port: expected 1-65535");
	}

	return { http, port };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	const { server } = createGovernanceMcpServer();

	if (args.http) {
		// Dynamic import to avoid requiring http module when using stdio
		const { StreamableHTTPServerTransport } = await import(
			"@modelcontextprotocol/sdk/server/streamableHttp.js"
		);
		const http = await import("node:http");

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});

		await server.connect(transport);

		const httpServer = http.createServer(async (req, res) => {
			await transport.handleRequest(req, res);
		});

		httpServer.listen(args.port, () => {
			process.stderr.write(
				`Governance MCP server listening on http://localhost:${args.port}\n`,
			);
		});
	} else {
		// stdio mode (default)
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write("Governance MCP server running on stdio\n");
	}
}

main().catch((error) => {
	process.stderr.write(`Fatal: ${error}\n`);
	process.exit(1);
});
