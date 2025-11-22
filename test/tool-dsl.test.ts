import os from "node:os";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	ToolResponseBuilder,
	createJsonTool,
	createTextTool,
	createTool,
	expandUserPath,
} from "../src/tools/tool-dsl.js";

const echoSchema = Type.Object({
	text: Type.String(),
});

const echoTool = createTool<typeof echoSchema, { length: number }>({
	name: "echo",
	label: "echo",
	description: "Echo text",
	schema: echoSchema,
	run: ({ text }, { respond }) =>
		respond.text(text).detail({ length: text.length }),
});

const builderReturnTool = createTool({
	name: "builder-return",
	label: "builder-return",
	description: "Return builder directly",
	schema: Type.Object({ value: Type.String() }),
	run: ({ value }) => new ToolResponseBuilder().text(value.toUpperCase()),
});

const directTool = createTool({
	name: "direct",
	description: "Return direct AgentToolResult",
	schema: Type.Object({}),
	run: () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
});

const textHelperTool = createTextTool({
	name: "text-helper",
	description: "Return plain strings",
	schema: Type.Object({ prefix: Type.String() }),
	run: async ({ prefix }) => `${prefix}:done`,
});

const jsonHelperTool = createJsonTool({
	name: "json-helper",
	description: "Return JSON payloads",
	schema: Type.Object({ value: Type.Number() }),
	run: ({ value }) => ({ value, double: value * 2 }),
});

const codeTool = createTool({
	name: "code-tool",
	description: "Emit code block",
	schema: Type.Object({}),
	run: (_params, { respond }) => respond.code("ts", "const x = 42;"),
});

describe("createTool DSL", () => {
	it("builds response via context builder", async () => {
		const result = await echoTool.execute("call-1", { text: "hello" });
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ text: "hello" });
		expect(result.details).toEqual({ length: 5 });
	});

	it("supports returning ToolResponseBuilder instances", async () => {
		const result = await builderReturnTool.execute("call-2", {
			value: "test",
		});
		expect(result.content[0]).toMatchObject({ text: "TEST" });
	});

	it("allows direct AgentToolResult return", async () => {
		const result = await directTool.execute("call-3", {});
		expect(result.content[0]).toMatchObject({ text: "ok" });
	});

	it("supports createTextTool helper for string responses", async () => {
		const result = await textHelperTool.execute("call-4", { prefix: "task" });
		expect(result.content[0]).toMatchObject({ text: "task:done" });
	});

	it("supports createJsonTool helper for objects", async () => {
		const result = await jsonHelperTool.execute("call-5", { value: 3 });
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("double"),
		});
	});

	it("renders code fences via builder", async () => {
		const result = await codeTool.execute("call-6", {});
		const text =
			result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("```ts");
		expect(text).toContain("const x = 42;");
	});

	it("expands user paths", () => {
		expect(expandUserPath("~")).toBe(os.homedir());
		const sample = expandUserPath("~/tmp");
		expect(sample).toBe(`${os.homedir()}/tmp`);
	});

	it("throws when builder has no content", () => {
		const builder = new ToolResponseBuilder();
		expect(() => builder.build()).toThrow(/no content/i);
	});

	it("emits standardized error responses", () => {
		const builder = new ToolResponseBuilder<{ code: number }>();
		try {
			builder.error("File not found", { code: 404 });
			throw new Error("Expected error to be thrown");
		} catch (error: any) {
			expect(error.message).toBe("Error: File not found");
			expect(error.toolDetails).toEqual({ code: 404 });
		}
	});

	it("sanitizes sensitive path information from error details", () => {
		const builder = new ToolResponseBuilder<{
			code: number;
			absolutePath?: string;
			fullPath?: string;
			realPath?: string;
			safePath?: string;
		}>();
		try {
			builder.error("Access denied", {
				code: 403,
				absolutePath: "/home/user/secret",
				fullPath: "/home/user/secret/file.txt",
				realPath: "/mnt/secure/data",
				safePath: "public/file.txt",
			});
			throw new Error("Expected error to be thrown");
		} catch (error: any) {
			expect(error.message).toBe("Error: Access denied");
			// Sensitive paths should be removed
			expect(error.toolDetails).not.toHaveProperty("absolutePath");
			expect(error.toolDetails).not.toHaveProperty("fullPath");
			expect(error.toolDetails).not.toHaveProperty("realPath");
			// Non-sensitive properties should remain
			expect(error.toolDetails).toHaveProperty("code", 403);
			expect(error.toolDetails).toHaveProperty("safePath", "public/file.txt");
		}
	});
});
