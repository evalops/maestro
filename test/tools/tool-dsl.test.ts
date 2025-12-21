import os from "node:os";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ToolResponseBuilder,
	createJsonTool,
	createTextTool,
	createTool,
	expandUserPath,
	interpolateContext,
} from "../../src/tools/tool-dsl.js";

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
	run: (_params, { respond }) => respond.text("```ts\nconst x = 42;\n```"),
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

	it("allows builder with no content", () => {
		const builder = new ToolResponseBuilder();
		const result = builder.build();
		expect(result.content).toEqual([]);
		expect(result.isError).toBe(false);
	});

	it("marks error responses with isError flag", () => {
		const builder = new ToolResponseBuilder();
		builder.error("File not found");
		const result = builder.build();
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: "File not found" });
	});
});

describe("tool retry logic", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on failure when maxRetries is set", async () => {
		let attempts = 0;
		const failingTool = createTool({
			name: "retry-test",
			description: "Test retry",
			schema: Type.Object({}),
			maxRetries: 2,
			retryDelayMs: 10, // Short delay for tests
			run: async () => {
				attempts++;
				if (attempts < 3) {
					throw new Error("Temporary failure");
				}
				return { content: [{ type: "text", text: "success" }] };
			},
		});

		const promise = failingTool.execute("retry-1", {});
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(attempts).toBe(3); // Initial + 2 retries
		expect(result.content[0]).toMatchObject({ text: "success" });
	});

	it("respects shouldRetry predicate", async () => {
		let attempts = 0;
		const selectiveRetryTool = createTool({
			name: "selective-retry",
			description: "Test selective retry",
			schema: Type.Object({}),
			maxRetries: 3,
			retryDelayMs: 10,
			shouldRetry: (error) =>
				error instanceof Error && error.message.includes("transient"),
			run: async () => {
				attempts++;
				if (attempts === 1) {
					throw new Error("transient error"); // Will retry
				}
				if (attempts === 2) {
					throw new Error("permanent error"); // Won't retry - no "transient"
				}
				return { content: [{ type: "text", text: "done" }] };
			},
		});

		const promise = selectiveRetryTool.execute("retry-2", {});
		const assertion = expect(promise).rejects.toThrow("permanent error");
		await vi.runAllTimersAsync();
		await assertion;
		expect(attempts).toBe(2); // Initial + 1 retry (stopped by shouldRetry)
	});

	it("throws after exhausting retries", async () => {
		let attempts = 0;
		const alwaysFailTool = createTool({
			name: "always-fail",
			description: "Always fails",
			schema: Type.Object({}),
			maxRetries: 2,
			retryDelayMs: 10,
			run: async () => {
				attempts++;
				throw new Error("Persistent failure");
			},
		});

		const promise = alwaysFailTool.execute("retry-3", {});
		const assertion = expect(promise).rejects.toThrow("Persistent failure");
		await vi.runAllTimersAsync();
		await assertion;
		expect(attempts).toBe(3); // Initial + 2 retries
	});

	it("respects abort signal during retry delay", async () => {
		const controller = new AbortController();
		let attempts = 0;

		const abortableTool = createTool({
			name: "abortable",
			description: "Can be aborted",
			schema: Type.Object({}),
			maxRetries: 5,
			retryDelayMs: 1000, // Long delay
			run: async () => {
				attempts++;
				throw new Error("Fail");
			},
		});

		// Abort after first attempt
		setTimeout(() => controller.abort(), 50);

		const promise = abortableTool.execute("abort-1", {}, controller.signal);
		const assertion = expect(promise).rejects.toThrow();
		await vi.runAllTimersAsync();
		await assertion;
		expect(attempts).toBeLessThanOrEqual(2); // Should abort before many retries
	});
});

describe("interpolateContext", () => {
	it("interpolates environment variables", () => {
		process.env.TEST_VAR = "test-value";
		const result = interpolateContext("Value: ${env.TEST_VAR}");
		expect(result).toBe("Value: test-value");
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.TEST_VAR;
	});

	it("returns empty string for missing env vars", () => {
		const result = interpolateContext("Value: ${env.NONEXISTENT_VAR_XYZ}");
		expect(result).toBe("Value: ");
	});

	it("interpolates cwd", () => {
		const result = interpolateContext("Dir: ${cwd}");
		expect(result).toBe(`Dir: ${process.cwd()}`);
	});

	it("interpolates home", () => {
		const result = interpolateContext("Home: ${home}");
		expect(result).toBe(`Home: ${os.homedir()}`);
	});

	it("handles multiple interpolations", () => {
		process.env.TEST_USER = "alice";
		const result = interpolateContext("${home}/users/${env.TEST_USER}");
		expect(result).toBe(`${os.homedir()}/users/alice`);
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.TEST_USER;
	});
});
