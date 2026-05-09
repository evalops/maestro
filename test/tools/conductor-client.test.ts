import { describe, expect, it } from "vitest";
import {
	conductorBrowserOperatorTool,
	conductorClientTools,
	conductorListMcpResourcesTool,
} from "../../src/tools/conductor-client.js";

type JsonSchemaObject = {
	type?: string;
	required?: string[];
	const?: string;
	anyOf?: JsonSchemaObject[];
	properties?: Record<string, JsonSchemaObject>;
};

describe("conductor MCP client tools", () => {
	it("does not require a server filter for list_mcp_resources", () => {
		const schema = conductorListMcpResourcesTool.parameters as JsonSchemaObject;

		expect(schema.type).toBe("object");
		expect(schema.properties?.server?.type).toBe("string");
		expect(schema.required ?? []).not.toContain("server");
	});

	it("publishes browser_operator as the task-level browser-control tool", () => {
		const schema = conductorBrowserOperatorTool.parameters as JsonSchemaObject;

		expect(conductorClientTools.map((tool) => tool.name)).toContain(
			"browser_operator",
		);
		expect(conductorBrowserOperatorTool.executionLocation).toBe("client");
		expect(schema.type).toBe("object");
		expect(schema.required ?? []).toContain("goal");
		expect(schema.properties?.action?.type).toBe("object");
		const action = schema.properties?.action;
		const kindValues = action?.properties?.kind?.anyOf?.map(
			(entry) => entry.const,
		);
		expect(kindValues).toEqual([
			"click",
			"hover",
			"type",
			"select",
			"wait",
			"scroll",
			"key",
		]);
	});
});
