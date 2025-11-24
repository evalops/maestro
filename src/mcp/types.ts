import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
	name: string;
	transport: McpTransport;
	// For stdio transport
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	// For http/sse transport
	url?: string;
	headers?: Record<string, string>;
	// Common options
	enabled?: boolean;
	timeout?: number;
}

export interface McpConfig {
	servers: McpServerConfig[];
}

export interface McpServerStatus {
	name: string;
	connected: boolean;
	error?: string;
	tools: McpTool[];
	resources: string[];
	prompts: string[];
}

export interface McpManagerStatus {
	servers: McpServerStatus[];
}
