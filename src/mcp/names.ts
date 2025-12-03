/** Build the canonical MCP tool name */
export function buildMcpToolName(server: string, tool: string): string {
	return `mcp__${sanitize(server)}__${tool}`;
}

/** Strip the MCP prefix; returns null if not an MCP tool */
export function parseMcpToolName(
	name: string,
): { server: string; tool?: string } | null {
	const parts = name.split("__");
	if (parts[0] !== "mcp" || parts.length < 2) return null;
	const server = parts[1];
	const tool = parts.length > 2 ? parts.slice(2).join("__") : undefined;
	return { server, tool };
}

export function isMcpTool(name: string): boolean {
	return name.startsWith("mcp__");
}

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
