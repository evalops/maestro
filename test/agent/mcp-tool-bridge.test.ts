import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createMcpToolWrapper } from "../../src/mcp/tool-bridge.js";

// Test the JSON Schema to TypeBox conversion logic
// We can't easily test createMcpToolWrapper without mocking the MCP manager,
// but we can test the schema conversion and text filtering logic

describe("MCP tool bridge schema conversion", () => {
	// Import the internal function for testing - we'll test via the public interface
	// Since convertJsonSchemaToTypebox is not exported, we test indirectly

	it("handles string type correctly", () => {
		const schema = Type.String({ description: "A string value" });
		expect(schema.type).toBe("string");
		expect(schema.description).toBe("A string value");
	});

	it("handles number type correctly", () => {
		const schema = Type.Number({ description: "A number value" });
		expect(schema.type).toBe("number");
	});

	it("handles boolean type correctly", () => {
		const schema = Type.Boolean({ description: "A boolean value" });
		expect(schema.type).toBe("boolean");
	});

	it("handles array type correctly", () => {
		const schema = Type.Array(Type.String());
		expect(schema.type).toBe("array");
	});

	it("handles object type with properties", () => {
		const schema = Type.Object({
			name: Type.String(),
			age: Type.Optional(Type.Number()),
		});
		expect(schema.type).toBe("object");
		expect(schema.properties).toBeDefined();
		expect(schema.properties?.name).toBeDefined();
	});

	it("normalizes model-facing MCP tool and schema descriptions", () => {
		const tool = createMcpToolWrapper("test-server", {
			name: "search",
			description: "  Search\n\n\tacross   records  ",
			inputSchema: {
				type: "object",
				description: "  Query\n\ninput  ",
				properties: {
					query: {
						type: "string",
						description: "  Search\nquery  ",
					},
				},
				required: ["query"],
			},
		} satisfies McpTool);

		expect(tool.description).toBe("Search across records");
		expect(tool.parameters.description).toBe("Query input");
		expect(tool.parameters.properties?.query?.description).toBe("Search query");
	});

	it("uses trusted MCP config or server capabilities as parallel capability sources", () => {
		const fromServer = createMcpToolWrapper(
			"trusted-server",
			{
				name: "search",
				inputSchema: { type: "object" },
			} satisfies McpTool,
			{ supportsParallelToolCalls: true },
		);
		const fromServerCapability = createMcpToolWrapper(
			"advertising-server",
			{
				name: "search",
				inputSchema: { type: "object" },
			} satisfies McpTool,
			{
				parallelSafety: {
					supportsParallelToolCalls: true,
					provenance: "server_capability",
					maxConcurrency: 3,
					readOnlyHint: true,
				},
			},
		);
		const fromToolMeta = createMcpToolWrapper("meta-server", {
			name: "search",
			inputSchema: { type: "object" },
			annotations: {
				supportsParallelToolCalls: true,
			},
			_meta: {
				supportsParallelToolCalls: true,
				"evalops.maestro/supportsParallelToolCalls": true,
			},
		} satisfies McpTool);
		const plain = createMcpToolWrapper("plain-server", {
			name: "search",
			inputSchema: { type: "object" },
		} satisfies McpTool);
		const readOnlyWithoutParallelOptIn = createMcpToolWrapper(
			"serial-read-server",
			{
				name: "search",
				inputSchema: { type: "object" },
			} satisfies McpTool,
			{
				parallelSafety: {
					supportsParallelToolCalls: false,
					provenance: "server_capability",
					readOnlyHint: true,
				},
			},
		);

		expect(fromServer.source?.supportsParallelToolCalls).toBe(true);
		expect(fromServer.source?.parallelSafetyProvenance).toBe("static_config");
		expect(fromServerCapability.source).toMatchObject({
			supportsParallelToolCalls: true,
			parallelSafetyProvenance: "server_capability",
			parallelMaxConcurrency: 3,
		});
		expect(fromServerCapability.annotations?.readOnlyHint).toBe(true);
		expect(fromToolMeta.source?.supportsParallelToolCalls).toBe(false);
		expect(fromToolMeta.source?.parallelSafetyProvenance).toBe("none");
		expect(plain.source?.supportsParallelToolCalls).toBe(false);
		expect(readOnlyWithoutParallelOptIn.source?.supportsParallelToolCalls).toBe(
			false,
		);
		expect(readOnlyWithoutParallelOptIn.annotations?.readOnlyHint).toBe(true);
		expect(readOnlyWithoutParallelOptIn.source?.capability?.riskClass).toBe(
			"observe",
		);
	});
});

// Type for MCP content items
type McpContent = {
	type: string;
	text?: string | null | undefined;
	data?: string;
	uri?: string;
};

describe("MCP tool text content filtering", () => {
	it("filters text content correctly", () => {
		const content: McpContent[] = [
			{ type: "text", text: "Hello" },
			{ type: "text", text: "World" },
			{ type: "image", data: "base64data" },
			{ type: "text" }, // No text property
			{ type: "text", text: undefined },
			{ type: "text", text: "" },
		];

		// Simulate the filtering logic from tool-bridge.ts
		const textContent = content
			.filter(
				(c): c is McpContent & { text: string } =>
					c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text)
			.join("\n");

		expect(textContent).toBe("Hello\nWorld\n");
	});

	it("returns empty string when no text content", () => {
		const content: McpContent[] = [
			{ type: "image", data: "base64data" },
			{ type: "resource", uri: "file:///test" },
		];

		const textContent = content
			.filter(
				(c): c is McpContent & { text: string } =>
					c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text)
			.join("\n");

		expect(textContent).toBe("");
	});

	it("handles content with only undefined text values", () => {
		const content: McpContent[] = [
			{ type: "text" },
			{ type: "text", text: undefined },
			{ type: "text", text: null },
		];

		const textContent = content
			.filter(
				(c): c is McpContent & { text: string } =>
					c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text)
			.join("\n");

		// Should be empty, not "undefined\nundefined\nnull"
		expect(textContent).toBe("");
	});

	it("preserves whitespace in text content", () => {
		const content: McpContent[] = [
			{ type: "text", text: "  indented" },
			{ type: "text", text: "line with trailing  " },
		];

		const textContent = content
			.filter(
				(c): c is McpContent & { text: string } =>
					c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text)
			.join("\n");

		expect(textContent).toBe("  indented\nline with trailing  ");
	});
});
