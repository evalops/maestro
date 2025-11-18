import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	ToolResponseBuilder,
	createTextTool,
	createTool,
} from "../src/tools/tool-dsl.js";

const echoTool = createTool({
	name: "echo",
	label: "echo",
	description: "Echo text",
	schema: Type.Object({
		text: Type.String(),
	}),
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

	it("throws when builder has no content", () => {
		const builder = new ToolResponseBuilder();
		expect(() => builder.build()).toThrow(/no content/i);
	});
});
