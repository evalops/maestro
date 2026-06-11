import { createHash } from "node:crypto";

/** Build the canonical MCP tool name */
export function buildMcpToolName(server: string, tool: string): string {
	return `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
}

export function buildMcpToolCollisionName(
	server: string,
	tool: string,
): string {
	return `${buildMcpToolName(server, tool)}_${hashMcpToolNameCollision(
		server,
		tool,
	)}_`;
}

export function buildMcpToolCanonicalNames<T>(
	tools: T[],
	getServer: (tool: T) => string,
	getTool: (tool: T) => string,
): string[] {
	const baseCounts = new Map<string, number>();
	const collisionCounts = new Map<string, number>();

	for (const tool of tools) {
		const baseName = buildMcpToolName(getServer(tool), getTool(tool));
		baseCounts.set(baseName, (baseCounts.get(baseName) ?? 0) + 1);
	}

	for (const tool of tools) {
		const baseName = buildMcpToolName(getServer(tool), getTool(tool));
		if ((baseCounts.get(baseName) ?? 0) <= 1) {
			continue;
		}
		const collisionName = buildMcpToolCollisionName(
			getServer(tool),
			getTool(tool),
		);
		collisionCounts.set(
			collisionName,
			(collisionCounts.get(collisionName) ?? 0) + 1,
		);
	}

	const seenCollisionNames = new Map<string, number>();
	return tools.map((tool) => {
		const baseName = buildMcpToolName(getServer(tool), getTool(tool));
		if ((baseCounts.get(baseName) ?? 0) <= 1) {
			return baseName;
		}
		const collisionName = buildMcpToolCollisionName(
			getServer(tool),
			getTool(tool),
		);
		if ((collisionCounts.get(collisionName) ?? 0) <= 1) {
			return collisionName;
		}
		const ordinal = (seenCollisionNames.get(collisionName) ?? 0) + 1;
		seenCollisionNames.set(collisionName, ordinal);
		return `${collisionName}${ordinal.toString(36)}_`;
	});
}

export function hashMcpToolNameCollision(
	serverName: string,
	toolName: string,
): string {
	return createHash("sha256")
		.update(`${serverName}\u0000${toolName}`)
		.digest("hex")
		.slice(0, 8);
}

/** Strip the MCP prefix; returns null if not an MCP tool */
export function parseMcpToolName(
	name: string,
): { server: string; tool?: string } | null {
	const parts = name.split("__");
	if (parts[0] !== "mcp" || parts.length < 2) return null;
	const server = parts[1]!;
	const tool = parts.length > 2 ? parts.slice(2).join("__") : undefined;
	return { server, tool };
}

export function isMcpTool(name: string): boolean {
	return name.startsWith("mcp__");
}

function sanitizeSegment(value: string): string {
	const sanitized =
		value.replace(/[^a-zA-Z0-9-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
	if (sanitized === value) return sanitized;
	return `${sanitized}_${shortStableHash(value)}`;
}

function shortStableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36).slice(0, 6);
}
