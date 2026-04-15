import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import { createTool } from "../tools/tool-dsl.js";
import { mcpManager } from "./manager.js";
import { buildMcpToolName, parseMcpToolName } from "./names.js";

interface McpToolDetails {
	server: string;
	tool: string;
	content: unknown[];
	isError?: boolean;
}

function convertJsonSchemaToTypebox(schema: unknown): TSchema {
	if (!schema || typeof schema !== "object") {
		return Type.Unknown();
	}

	const s = schema as Record<string, unknown>;
	const type = s.type as string | undefined;

	switch (type) {
		case "string":
			return Type.String({ description: s.description as string | undefined });
		case "number":
		case "integer":
			return Type.Number({ description: s.description as string | undefined });
		case "boolean":
			return Type.Boolean({ description: s.description as string | undefined });
		case "array":
			return Type.Array(convertJsonSchemaToTypebox(s.items), {
				description: s.description as string | undefined,
			});
		case "object": {
			const properties = s.properties as Record<string, unknown> | undefined;
			if (!properties) {
				return Type.Record(Type.String(), Type.Unknown());
			}
			const required = (s.required as string[]) ?? [];
			const props: Record<string, TSchema> = {};
			for (const [key, value] of Object.entries(properties)) {
				const converted = convertJsonSchemaToTypebox(value);
				props[key] = required.includes(key)
					? converted
					: Type.Optional(converted);
			}
			return Type.Object(props, {
				description: s.description as string | undefined,
			});
		}
		default:
			return Type.Unknown({ description: s.description as string | undefined });
	}
}

export function createMcpToolWrapper(serverName: string, mcpTool: McpTool) {
	const toolName = buildMcpToolName(serverName, mcpTool.name);
	const schema = mcpTool.inputSchema
		? convertJsonSchemaToTypebox(mcpTool.inputSchema)
		: Type.Object({});

	// Extract MCP tool annotations for approval decisions
	const mcpAnnotations = mcpTool.annotations as
		| {
				readOnlyHint?: boolean;
				destructiveHint?: boolean;
				idempotentHint?: boolean;
				openWorldHint?: boolean;
		  }
		| undefined;

	return createTool<typeof schema, McpToolDetails>({
		name: toolName,
		label: `${serverName}/${mcpTool.name}`,
		description:
			mcpTool.description ?? `MCP tool from ${serverName}: ${mcpTool.name}`,
		schema,
		annotations: mcpAnnotations
			? {
					readOnlyHint: mcpAnnotations.readOnlyHint,
					destructiveHint: mcpAnnotations.destructiveHint,
					idempotentHint: mcpAnnotations.idempotentHint,
					openWorldHint: mcpAnnotations.openWorldHint,
				}
			: undefined,
		async run(params, { respond }) {
			const result = await mcpManager.callTool(
				serverName,
				mcpTool.name,
				params as Record<string, unknown>,
			);

			const textContent = result.content
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text as string)
				.join("\n");

			const output = textContent || JSON.stringify(result.content, null, 2);

			return respond.text(output).detail({
				server: serverName,
				tool: mcpTool.name,
				content: result.content,
				isError: result.isError,
			});
		},
	});
}

export function getAllMcpTools(): AgentTool[] {
	const mcpTools = mcpManager.getAllTools();
	return [
		...mcpTools.map(({ server, tool }) => createMcpToolWrapper(server, tool)),
		...getMcpHelperTools(),
	];
}

export function getMcpToolMap(): Map<string, AgentTool> {
	const map = new Map<string, AgentTool>();
	const mcpTools = mcpManager.getAllTools();

	for (const tool of getMcpHelperTools()) {
		map.set(tool.name, tool);
	}

	for (const { server, tool } of mcpTools) {
		const wrapper = createMcpToolWrapper(server, tool);
		map.set(wrapper.name, wrapper);
	}

	return map;
}

// ─────────────────────────────────────────────────────────────
// MCP Resource Tools (inspired by Claude Code's ListMcpResources/ReadMcpResource)
// ─────────────────────────────────────────────────────────────

interface McpResourceListDetails {
	servers: Array<{
		name: string;
		resources: string[];
	}>;
}

const listMcpResourcesSchema = Type.Object({
	server: Type.Optional(
		Type.String({
			description:
				"Optional server name to filter resources. If omitted, lists resources from all servers.",
		}),
	),
});

/**
 * Tool to list available MCP resources across all connected servers.
 */
export const listMcpResourcesTool = createTool<
	typeof listMcpResourcesSchema,
	McpResourceListDetails
>({
	name: "mcp_list_resources",
	description:
		"List available resources from MCP servers. Resources are data sources that can be read (files, configs, etc.).",
	schema: listMcpResourcesSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const status = mcpManager.getStatus();
		const result: Array<{ name: string; resources: string[] }> = [];

		for (const server of status.servers) {
			if (params.server && server.name !== params.server) {
				continue;
			}
			if (server.connected && server.resources.length > 0) {
				result.push({
					name: server.name,
					resources: server.resources,
				});
			}
		}

		if (result.length === 0) {
			return respond
				.text(
					"No MCP resources available. Either no servers are connected or they don't expose resources.",
				)
				.detail({ servers: [] });
		}

		const lines: string[] = ["# Available MCP Resources\n"];
		for (const server of result) {
			lines.push(`## ${server.name}`);
			for (const uri of server.resources) {
				lines.push(`- ${uri}`);
			}
			lines.push("");
		}

		return respond.text(lines.join("\n")).detail({ servers: result });
	},
});

interface McpResourceReadDetails {
	server: string;
	uri: string;
	contents: Array<{
		uri: string;
		text?: string;
		mimeType?: string;
	}>;
}

const readMcpResourceSchema = Type.Object({
	server: Type.String({
		description: "Name of the MCP server that hosts the resource",
	}),
	uri: Type.String({
		description: "URI of the resource to read",
	}),
});

/**
 * Tool to read a specific MCP resource.
 */
export const readMcpResourceTool = createTool<
	typeof readMcpResourceSchema,
	McpResourceReadDetails
>({
	name: "mcp_read_resource",
	description:
		"Read the contents of an MCP resource by URI. Use mcp_list_resources first to discover available resources.",
	schema: readMcpResourceSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const { server, uri } = params;

		try {
			const result = await mcpManager.readResource(server, uri);

			if (result.contents.length === 0) {
				return respond.text(`Resource '${uri}' is empty.`).detail({
					server,
					uri,
					contents: [],
				});
			}

			// Format output based on content type
			const textContents = result.contents
				.filter((c) => c.text !== undefined)
				.map((c) => c.text)
				.join("\n---\n");

			const output = textContents || JSON.stringify(result.contents, null, 2);

			return respond.text(output).detail({
				server,
				uri,
				contents: result.contents.map((c) => ({
					uri: c.uri,
					text: c.text,
					mimeType: c.mimeType,
				})),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return respond.error(`Failed to read resource: ${message}`);
		}
	},
});

interface McpPromptListDetails {
	servers: Array<{
		name: string;
		prompts: string[];
	}>;
}

const listMcpPromptsSchema = Type.Object({
	server: Type.Optional(
		Type.String({
			description:
				"Optional server name to filter prompts. If omitted, lists prompts from all servers.",
		}),
	),
});

/**
 * Tool to list available MCP prompts across all connected servers.
 */
export const listMcpPromptsTool = createTool<
	typeof listMcpPromptsSchema,
	McpPromptListDetails
>({
	name: "mcp_list_prompts",
	description:
		"List available prompts from MCP servers. Prompts are reusable prompt templates exposed by servers.",
	schema: listMcpPromptsSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const status = mcpManager.getStatus();
		const result: Array<{ name: string; prompts: string[] }> = [];

		for (const server of status.servers) {
			if (params.server && server.name !== params.server) {
				continue;
			}
			if (server.connected && server.prompts.length > 0) {
				result.push({
					name: server.name,
					prompts: server.prompts,
				});
			}
		}

		if (result.length === 0) {
			return respond
				.text(
					"No MCP prompts available. Either no servers are connected or they don't expose prompts.",
				)
				.detail({ servers: [] });
		}

		const lines: string[] = ["# Available MCP Prompts\n"];
		for (const server of result) {
			lines.push(`## ${server.name}`);
			for (const prompt of server.prompts) {
				lines.push(`- ${prompt}`);
			}
			lines.push("");
		}

		return respond.text(lines.join("\n")).detail({ servers: result });
	},
});

interface McpPromptDetails {
	server: string;
	name: string;
	description?: string;
	messages: Array<{ role: string; content: string }>;
}

const getMcpPromptSchema = Type.Object({
	server: Type.String({
		description: "Name of the MCP server that hosts the prompt",
	}),
	name: Type.String({
		description: "Name of the prompt to fetch",
	}),
	args: Type.Optional(
		Type.Record(
			Type.String(),
			Type.String({
				description: "Optional string arguments passed to the prompt",
			}),
		),
	),
});

/**
 * Tool to fetch a specific MCP prompt.
 */
export const getMcpPromptTool = createTool<
	typeof getMcpPromptSchema,
	McpPromptDetails
>({
	name: "mcp_get_prompt",
	description:
		"Fetch an MCP prompt by name. Use mcp_list_prompts first to discover available prompts.",
	schema: getMcpPromptSchema,
	annotations: {
		readOnlyHint: true,
	},
	async run(params, { respond }) {
		const { server, name, args } = params;

		try {
			const result = await mcpManager.getPrompt(server, name, args);
			const lines: string[] = [`Prompt: ${name}`];

			if (result.description) {
				lines.push(`Description: ${result.description}`);
			}

			if (result.messages.length === 0) {
				lines.push("");
				lines.push("No prompt messages returned.");
			} else {
				lines.push("");
				for (const message of result.messages) {
					lines.push(`[${message.role}]`);
					lines.push(message.content);
					lines.push("");
				}
			}

			return respond.text(lines.join("\n").trimEnd()).detail({
				server,
				name,
				description: result.description,
				messages: result.messages,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return respond.error(`Failed to get prompt: ${message}`);
		}
	},
});

/**
 * Get all MCP resource tools.
 */
export function getMcpResourceTools() {
	return [listMcpResourcesTool, readMcpResourceTool];
}

function getMcpHelperTools() {
	return [
		listMcpResourcesTool,
		readMcpResourceTool,
		listMcpPromptsTool,
		getMcpPromptTool,
	];
}
