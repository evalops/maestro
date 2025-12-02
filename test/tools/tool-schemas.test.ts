import { describe, expect, it } from "vitest";
import { bashTool } from "../../src/tools/bash.js";
import { listTool } from "../../src/tools/list.js";
import { readTool } from "../../src/tools/read.js";

describe("Tool Schemas", () => {
	it("should have valid parameters with properties", () => {
		const params = bashTool.parameters as any;
		console.log("bashTool.parameters:", JSON.stringify(params, null, 2));

		expect(params).toBeDefined();
		expect(params.properties).toBeDefined();
		expect(params.properties.command).toBeDefined();
	});

	it("readTool should have path property", () => {
		const params = readTool.parameters as any;
		console.log("readTool.parameters:", JSON.stringify(params, null, 2));

		expect(params).toBeDefined();
		expect(params.properties).toBeDefined();
		expect(params.properties.path).toBeDefined();
		expect(params.required).toContain("path");
	});

	it("listTool should have valid schema", () => {
		const params = listTool.parameters as any;
		console.log("listTool.parameters:", JSON.stringify(params, null, 2));

		expect(params).toBeDefined();
		expect(params.properties).toBeDefined();
	});

	it("should convert to Anthropic format correctly", () => {
		const params = readTool.parameters as any;
		const anthropicSchema = {
			type: "object" as const,
			properties: params.properties || {},
			required: params.required || [],
		};

		console.log("Anthropic schema:", JSON.stringify(anthropicSchema, null, 2));

		expect(anthropicSchema.type).toBe("object");
		expect(anthropicSchema.properties.path).toBeDefined();
		expect(anthropicSchema.required).toContain("path");
	});
});
