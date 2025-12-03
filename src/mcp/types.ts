import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export type McpTransport = "stdio" | "http" | "sse";
export type McpScope = "enterprise" | "plugin" | "project" | "local" | "user";

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
	disabled?: boolean;
	timeout?: number;
	scope?: McpScope;
}

export interface McpConfig {
	servers: McpServerConfig[];
	envLimits?: Record<string, { effective: number; status: string; message?: string }>;
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
