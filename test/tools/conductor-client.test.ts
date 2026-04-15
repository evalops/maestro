import { describe, expect, it } from "vitest";
import { conductorListMcpResourcesTool } from "../../src/tools/conductor-client.js";

type JsonSchemaObject = {
	type?: string;
	required?: string[];
	properties?: Record<string, { type?: string }>;
};

describe("conductor MCP client tools", () => {
	it("does not require a server filter for list_mcp_resources", () => {
		const schema = conductorListMcpResourcesTool.parameters as JsonSchemaObject;

		expect(schema.type).toBe("object");
		expect(schema.properties?.server?.type).toBe("string");
		expect(schema.required ?? []).not.toContain("server");
	});
});
