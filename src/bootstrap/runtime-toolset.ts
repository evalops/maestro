import type { Agent, AgentTool } from "../agent/index.js";
import { composerManager } from "../composers/index.js";
import { applyExtensionToolState } from "../hooks/index.js";
import { getAllMcpTools } from "../mcp/tool-bridge.js";

export function buildRuntimeToolset(
	baseTools: AgentTool[],
	mcpTools: AgentTool[] = getAllMcpTools(),
): AgentTool[] {
	return applyExtensionToolState([...baseTools, ...mcpTools]);
}

export function syncRuntimeToolset(
	agent: Agent,
	baseTools: AgentTool[],
	mcpTools: AgentTool[] = getAllMcpTools(),
): AgentTool[] {
	const updatedTools = buildRuntimeToolset(baseTools, mcpTools);
	agent.setTools(updatedTools);
	composerManager.updateBaseTools(updatedTools);
	return updatedTools;
}
