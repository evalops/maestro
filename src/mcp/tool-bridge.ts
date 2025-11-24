import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "@sinclair/typebox";
import { createTool } from "../tools/tool-dsl.js";
import { mcpManager } from "./manager.js";

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
	const toolName = `mcp_${serverName}_${mcpTool.name}`;
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

export function getAllMcpTools() {
	const mcpTools = mcpManager.getAllTools();
	return mcpTools.map(({ server, tool }) => createMcpToolWrapper(server, tool));
}

export function getMcpToolMap(): Map<
	string,
	ReturnType<typeof createMcpToolWrapper>
> {
	const map = new Map<string, ReturnType<typeof createMcpToolWrapper>>();
	const mcpTools = mcpManager.getAllTools();

	for (const { server, tool } of mcpTools) {
		const wrapper = createMcpToolWrapper(server, tool);
		map.set(wrapper.name, wrapper);
	}

	return map;
}
