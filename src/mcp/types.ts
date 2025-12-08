/**
 * MCP Types - Model Context Protocol Type Definitions
 *
 * This module defines the core types used throughout the MCP (Model Context
 * Protocol) integration. These types represent server configurations, connection
 * states, and status information.
 *
 * ## Transport Types
 *
 * | Transport | Description                              |
 * |-----------|------------------------------------------|
 * | stdio     | Subprocess communication via stdin/stdout|
 * | http      | HTTP-based REST transport                |
 * | sse       | Server-Sent Events for streaming         |
 *
 * ## Configuration Scopes
 *
 * | Scope      | Precedence | Description                        |
 * |------------|------------|------------------------------------|
 * | enterprise | Highest    | Organization-wide settings         |
 * | plugin     | High       | Programmatically provided          |
 * | project    | Medium     | Per-project .composer/mcp.json     |
 * | local      | Low        | Local overrides (git-ignored)      |
 * | user       | Lowest     | User's global settings             |
 *
 * ## Server Status
 *
 * The `McpServerStatus` interface tracks:
 * - Connection state (connected/disconnected)
 * - Available tools, resources, and prompts
 * - Error messages if connection failed
 *
 * @module mcp/types
 */

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
	envLimits?: Record<
		string,
		{ effective: number; status: string; message?: string }
	>;
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
