/**
 * MCP Setup - Model Context Protocol server initialization.
 *
 * Extracts MCP integration from main.ts Phase 12:
 * config loading, event listeners for connected/disconnected/tools_changed.
 *
 * @module bootstrap/mcp-setup
 */

import type { Agent, AgentTool } from "../agent/index.js";
import { composerManager } from "../composers/index.js";
import { loadMcpConfig } from "../mcp/config.js";
import { mcpManager } from "../mcp/manager.js";
import { getAllMcpTools } from "../mcp/tool-bridge.js";

/**
 * Load MCP config and initialize servers with event listeners
 * that keep the agent's tool set up to date.
 */
export function initializeMcpServers(params: {
	agent: Agent;
	baseTools: AgentTool[];
	cwd: string;
}): void {
	const { agent, baseTools, cwd } = params;

	const mcpConfig = loadMcpConfig(cwd, { includeEnvLimits: true });
	if (mcpConfig.servers.length === 0) {
		return;
	}

	// Listen for MCP server connections to add their tools
	mcpManager.on("connected", () => {
		const mcpTools = getAllMcpTools();
		if (mcpTools.length > 0) {
			const updatedTools = [...baseTools, ...mcpTools];
			agent.setTools(updatedTools);
			composerManager.updateBaseTools(updatedTools);
		}
	});

	// Listen for tool list changes to update agent tools dynamically
	// Debounced to handle rapid concurrent updates from multiple servers
	let toolsChangedTimeout: ReturnType<typeof setTimeout> | null = null;
	mcpManager.on("tools_changed", () => {
		if (toolsChangedTimeout) clearTimeout(toolsChangedTimeout);
		toolsChangedTimeout = setTimeout(() => {
			toolsChangedTimeout = null;
			const mcpTools = getAllMcpTools();
			const updatedTools = [...baseTools, ...mcpTools];
			agent.setTools(updatedTools);
			composerManager.updateBaseTools(updatedTools);
		}, 100);
	});

	// Clear pending timeout only when all servers have disconnected
	mcpManager.on("disconnected", () => {
		const hasConnectedServers = mcpManager
			.getStatus()
			.servers.some((s) => s.connected);
		if (!hasConnectedServers && toolsChangedTimeout) {
			clearTimeout(toolsChangedTimeout);
			toolsChangedTimeout = null;
		}
	});

	mcpManager.configure(mcpConfig).catch((err) => {
		console.warn("[mcp] Failed to initialize MCP servers:", err);
	});
}
