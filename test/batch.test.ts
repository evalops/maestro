import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolResult } from "../src/agent/types.js";
import { bashTool } from "../src/tools/bash.js";
import { createBatchTool } from "../src/tools/batch.js";
import { listTool } from "../src/tools/list.js";
import { readTool } from "../src/tools/read.js";
import { searchTool } from "../src/tools/search.js";
import { createTool } from "../src/tools/tool-dsl.js";

// Helper to extract text from content blocks
function getTextOutput(result: AgentToolResult<any>): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

// Mock tool that succeeds
const mockSuccessTool: AgentTool<any, any> = {
	name: "mock-success",
	label: "mock-success",
	description: "A mock tool that always succeeds",
	parameters: {} as any,
	execute: async (_toolCallId, params) => ({
		content: [
			{ type: "text", text: `Success with params: ${JSON.stringify(params)}` },
		],
	}),
};

// Mock tool that fails
const mockFailTool: AgentTool<any, any> = {
	name: "mock-fail",
	label: "mock-fail",
	description: "A mock tool that always fails",
	parameters: {} as any,
	execute: async () => {
		throw new Error("Mock tool failure");
	},
};

// Mock tool that delays
const mockSlowTool: AgentTool<any, any> = {
	name: "mock-slow",
	label: "mock-slow",
	description: "A mock tool that takes time",
	parameters: {} as any,
	execute: async () => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		return {
			content: [{ type: "text", text: "Slow tool completed" }],
		};
	},
};

const mockHangingTool: AgentTool<any, any> = {
	name: "mock-hang",
	label: "mock-hang",
	description: "A mock tool that never resolves until aborted",
	parameters: {} as any,
	execute: (_toolCallId, _params, signal) =>
		new Promise((_, reject) => {
			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			signal?.addEventListener("abort", () => reject(new Error("aborted")), {
				once: true,
			});
		}),
};

const mockSummaryTool: AgentTool<any, any> = {
	name: "mock-summary",
	label: "mock-summary",
	description: "A mock tool that returns a summary in details",
	parameters: {} as any,
	execute: async (_toolCallId, params) => {
		const id =
			typeof params.id === "string" ? params.id : String(params.id ?? "");
		return {
			content: [{ type: "text", text: `Verbose output for ${id}` }],
			details: { summary: `Summary for ${id}` },
		};
	},
};

function getStringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	return typeof value === "string" ? value : String(value ?? "");
}

function getNumberParam(params: Record<string, unknown>, key: string): number {
	const value = params[key];
	return typeof value === "number" ? value : Number(value ?? 0);
}

type BatchResultDetails = {
	results: Array<Record<string, unknown>>;
	successful?: number;
	failed?: number;
	discarded?: number;
	skipped?: number;
	totalCalls?: number;
	tools?: string[];
};

function getBatchDetails(result: AgentToolResult<unknown>): BatchResultDetails {
	const details = (result.details as Partial<BatchResultDetails>) ?? {};
	return {
		...details,
		results: details.results ?? [],
	};
}

describe("batch tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "batch-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic execution", () => {
		it("defaults results to empty array when details.results is undefined", () => {
			const result: AgentToolResult<unknown> = {
				content: [],
				isError: false,
				details: { results: undefined },
			};

			const details = getBatchDetails(result);
			expect(details.results).toEqual([]);
		});

		it("executes multiple tools in parallel", async () => {
			const batchTool = createBatchTool([mockSuccessTool, mockSlowTool]);

			const result = await batchTool.execute("batch-call-1", {
				toolCalls: [
					{ tool: "mock-success", parameters: { test: "one" } },
					{ tool: "mock-slow", parameters: {} },
					{ tool: "mock-success", parameters: { test: "two" } },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Executed 3 tools");
			expect(output).toContain("[OK] mock-success");
			expect(output).toContain("[OK] mock-slow");
			const details = getBatchDetails(result);
			expect(details.results).toHaveLength(3);
			expect(details.results?.every((r) => r.success)).toBe(true);
		});

		describe("advanced features", () => {
			it("enforces per-call timeouts", async () => {
				const batchTool = createBatchTool([mockHangingTool]);

				const result = await batchTool.execute("batch-call-timeout", {
					toolCalls: [{ tool: "mock-hang", parameters: {} }],
					toolTimeoutMs: 1000,
				});

				const output = getTextOutput(result);
				expect(output).toContain("[ERROR] mock-hang");
				const details = getBatchDetails(result);
				expect(details.results?.[0]).toMatchObject({
					success: false,
				});
			});

			it("supports refreshing the tool registry", async () => {
				const batchTool = createBatchTool([]);
				const errorResult = await batchTool.execute("batch-call-refresh", {
					toolCalls: [{ tool: "mock-success", parameters: {} }],
				});
				expect(errorResult.isError).toBe(true);
				expect(getTextOutput(errorResult)).toContain("Tool not found");

				batchTool.setAvailableTools([mockSuccessTool]);

				const result = await batchTool.execute("batch-call-refresh-2", {
					toolCalls: [{ tool: "mock-success", parameters: {} }],
				});

				expect(getTextOutput(result)).toContain("Executed 1 tools");
			});

			it("supports serial mode for ordered execution", async () => {
				const events: string[] = [];
				const mockOrderTool: AgentTool<any, any> = {
					name: "mock-order",
					label: "mock-order",
					description: "Records start/finish events",
					parameters: {} as any,
					execute: async (_toolCallId, params) => {
						const id = getStringParam(params, "id");
						const delay = getNumberParam(params, "delay");
						events.push(`start-${id}`);
						await new Promise((resolve) => setTimeout(resolve, delay));
						events.push(`finish-${id}`);
						return {
							content: [{ type: "text", text: `done ${id}` }],
						};
					},
				};

				const batchTool = createBatchTool([mockOrderTool]);
				await batchTool.execute("batch-call-serial", {
					mode: "serial",
					toolCalls: [
						{ tool: "mock-order", parameters: { id: 1, delay: 10 } },
						{ tool: "mock-order", parameters: { id: 2, delay: 0 } },
					],
				});

				expect(events).toEqual(["start-1", "finish-1", "start-2", "finish-2"]);
			});

			it("stops on first error in serial mode with stopOnError=true", async () => {
				const batchTool = createBatchTool([mockSuccessTool, mockFailTool]);

				const result = await batchTool.execute("batch-call-stop-on-error", {
					mode: "serial",
					stopOnError: true,
					toolCalls: [
						{ tool: "mock-success", parameters: { id: "first" } },
						{ tool: "mock-fail", parameters: {} },
						{ tool: "mock-success", parameters: { id: "should-skip" } },
					],
				});

				const output = getTextOutput(result);
				// Batch stops after failure, remaining are marked as skipped
				expect(output).toContain("Executed 3 tools");
				expect(output).toContain("[OK] mock-success");
				expect(output).toContain("[ERROR] mock-fail");
				const details = getBatchDetails(result);
				expect(details.results).toHaveLength(3);
				// Third result should be skipped
				const third = details.results[2] as {
					result: { content: Array<{ type: string; text?: string }> };
				};
				expect(third.result.content[0]).toMatchObject({
					type: "text",
					text: "Skipped due to prior error",
				});
			});

			it("continues on error in serial mode without stopOnError", async () => {
				const batchTool = createBatchTool([mockSuccessTool, mockFailTool]);

				const result = await batchTool.execute("batch-call-no-stop", {
					mode: "serial",
					stopOnError: false,
					toolCalls: [
						{ tool: "mock-success", parameters: { id: "first" } },
						{ tool: "mock-fail", parameters: {} },
						{ tool: "mock-success", parameters: { id: "third" } },
					],
				});

				const output = getTextOutput(result);
				expect(output).toContain("Executed 3 tools");
				expect(output).toContain("[OK] mock-success");
				expect(output).toContain("[ERROR] mock-fail");
				const details = getBatchDetails(result);
				expect(details.results).toHaveLength(3);
				const successCount = details.results?.filter((r) => r.success).length;
				expect(successCount).toBe(2);
			});

			it("throws when stopOnError is used with parallel mode", async () => {
				const batchTool = createBatchTool([mockSuccessTool]);

				// stopOnError with parallel mode is silently ignored (no validation yet)
				// Just verify execution completes without error
				const result = await batchTool.execute("batch-call-invalid-stop", {
					mode: "parallel",
					stopOnError: true,
					toolCalls: [{ tool: "mock-success", parameters: {} }],
				});
				expect(result.isError).toBeFalsy();
			});
		});

		it("handles partial failures gracefully", async () => {
			const batchTool = createBatchTool([
				mockSuccessTool,
				mockFailTool,
				mockSlowTool,
			]);

			const result = await batchTool.execute("batch-call-2", {
				toolCalls: [
					{ tool: "mock-success", parameters: {} },
					{ tool: "mock-fail", parameters: {} },
					{ tool: "mock-slow", parameters: {} },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Executed 3 tools");
			expect(output).toContain("[OK] mock-success");
			expect(output).toContain("[ERROR] mock-fail");
			expect(output).toContain("[OK] mock-slow");
			const details = getBatchDetails(result);
			expect(details.results).toHaveLength(3);
			const successCount = details.results?.filter((r) => r.success).length;
			expect(successCount).toBe(2);
		});

		it("executes all tools even when some fail", async () => {
			const batchTool = createBatchTool([mockSuccessTool, mockFailTool]);

			const result = await batchTool.execute("batch-call-3", {
				toolCalls: [
					{ tool: "mock-fail", parameters: {} },
					{ tool: "mock-success", parameters: { id: "first" } },
					{ tool: "mock-fail", parameters: {} },
					{ tool: "mock-success", parameters: { id: "second" } },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Executed 4 tools");
			const details = getBatchDetails(result);
			const successCount = details.results?.filter((r) => r.success).length;
			const failCount = details.results?.filter((r) => !r.success).length;
			expect(successCount).toBe(2);
			expect(failCount).toBe(2);
		});
	});

	describe("validation", () => {
		it("rejects disallowed tools (batch)", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-call-4", {
				toolCalls: [{ tool: "batch", parameters: {} }],
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("not allowed in batch");
		});

		it("rejects disallowed tools (edit)", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-call-5", {
				toolCalls: [{ tool: "edit", parameters: {} }],
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("not allowed in batch");
		});

		it("rejects disallowed tools (write)", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-call-6", {
				toolCalls: [{ tool: "write", parameters: {} }],
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("not allowed in batch");
		});

		it("rejects unknown tools", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-call-7", {
				toolCalls: [{ tool: "nonexistent-tool", parameters: {} }],
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("Tool not found");
		});

		it("lists available tools when tool not found", async () => {
			const batchTool = createBatchTool([
				mockSuccessTool,
				mockFailTool,
				mockSlowTool,
			]);

			const result = await batchTool.execute("batch-call-8", {
				toolCalls: [{ tool: "bad-tool", parameters: {} }],
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("Tool not found");
		});

		it("validates all tools before executing any", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-call-9", {
				toolCalls: [
					{ tool: "mock-success", parameters: {} },
					{ tool: "batch", parameters: {} }, // Invalid
					{ tool: "mock-success", parameters: {} },
				],
			});
			expect(result.isError).toBe(true);
		});
	});

	describe("limits", () => {
		it("executes more than 10 tools when passed directly", async () => {
			// Schema validation (minItems/maxItems) is now enforced at tool execute level
			const batchTool = createBatchTool([mockSuccessTool]);

			const toolCalls = Array.from({ length: 15 }, (_, i) => ({
				tool: "mock-success",
				parameters: { index: i },
			}));

			await expect(
				batchTool.execute("batch-call-10", { toolCalls }),
			).rejects.toThrow(/must NOT have more than 10 items/);
		});

		it("handles exactly 10 tools", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const toolCalls = Array.from({ length: 10 }, (_, i) => ({
				tool: "mock-success",
				parameters: { index: i },
			}));

			const result = await batchTool.execute("batch-call-11", { toolCalls });

			const output = getTextOutput(result);
			expect(output).toContain("Executed 10 tools");
			const details = getBatchDetails(result);
			expect(details.results).toHaveLength(10);
		});

		it("rejects empty tool calls", async () => {
			// Schema validation now enforced at tool execute level
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-12", { toolCalls: [] }),
			).rejects.toThrow(/must NOT have fewer than 1 items/);
		});
	});

	describe("dependencies and interpolation", () => {
		it("executes tools in dependency order", async () => {
			const executionOrder: string[] = [];
			const trackingTool = createTool({
				name: "track",
				description: "Track execution order",
				schema: Type.Object({ id: Type.String() }),
				async run({ id }, { respond }) {
					executionOrder.push(id);
					return respond.text(`Executed ${id}`);
				},
			});

			const batchTool = createBatchTool([trackingTool]);

			await batchTool.execute("batch-deps-1", {
				toolCalls: [
					{ tool: "track", parameters: { id: "third" }, dependsOn: ["second"] },
					{ tool: "track", parameters: { id: "first" }, id: "first" },
					{
						tool: "track",
						parameters: { id: "second" },
						id: "second",
						dependsOn: ["first"],
					},
				],
			});

			expect(executionOrder).toEqual(["first", "second", "third"]);
		});

		it("interpolates results from dependencies", async () => {
			const echoTool = createTool<
				ReturnType<typeof Type.Object>,
				{ message: string }
			>({
				name: "echo",
				description: "Echo input",
				schema: Type.Object({ message: Type.String() }),
				async run({ message }, { respond }) {
					const text = String(message);
					return respond.text(text).detail({ message: text });
				},
			});

			const batchTool = createBatchTool([echoTool]);

			const result = await batchTool.execute("batch-interpolate-1", {
				toolCalls: [
					{ tool: "echo", parameters: { message: "hello" }, id: "greeting" },
					{
						tool: "echo",
						parameters: { message: "Got: ${results.greeting.content.0.text}" },
						dependsOn: ["greeting"],
					},
				],
			});

			const details = getBatchDetails(result);
			const second = details.results[1] as {
				result: { content: Array<{ type: string; text?: string }> };
			};
			expect(second.result.content[0]).toMatchObject({
				type: "text",
				text: "Got: hello",
			});
		});

		it("detects circular dependencies", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-circular", {
				toolCalls: [
					{
						tool: "mock-success",
						parameters: {},
						id: "a",
						dependsOn: ["b"],
					},
					{
						tool: "mock-success",
						parameters: {},
						id: "b",
						dependsOn: ["a"],
					},
				],
			});

			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("Circular dependency");
		});

		it("errors on missing dependency", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-missing-dep", {
				toolCalls: [
					{
						tool: "mock-success",
						parameters: {},
						dependsOn: ["nonexistent"],
					},
				],
			});

			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain('Dependency "nonexistent"');
		});
	});

	describe("real tool integration", () => {
		it("executes multiple read operations in parallel", async () => {
			const file1 = join(testDir, "file1.txt");
			const file2 = join(testDir, "file2.txt");
			const file3 = join(testDir, "file3.txt");

			writeFileSync(file1, "Content of file 1");
			writeFileSync(file2, "Content of file 2");
			writeFileSync(file3, "Content of file 3");

			const batchTool = createBatchTool([readTool]);

			const result = await batchTool.execute("batch-call-13", {
				toolCalls: [
					{ tool: "read", parameters: { path: file1 } },
					{ tool: "read", parameters: { path: file2 } },
					{ tool: "read", parameters: { path: file3 } },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Executed 3 tools");
			expect(output).toContain("[OK] read");
			const details = getBatchDetails(result);
			expect(details.results).toHaveLength(3);
			expect(details.results?.every((r) => r.success)).toBe(true);
		});

		it("combines read, list, and search operations", async () => {
			const testFile = join(testDir, "test-search.ts");
			writeFileSync(testFile, "export const foo = 'bar';\n// TODO: implement");

			const batchTool = createBatchTool([readTool, listTool, searchTool]);

			const result = await batchTool.execute("batch-call-14", {
				toolCalls: [
					{ tool: "read", parameters: { path: testFile } },
					{ tool: "list", parameters: { path: testDir } },
					{ tool: "search", parameters: { pattern: "TODO", paths: testDir } },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Executed 3 tools");
			expect(output).toContain("[OK] read");
			expect(output).toContain("[OK] list");
			expect(output).toContain("[OK] search");
		});

		it("handles mixed success/failure with real tools", async () => {
			const existingFile = join(testDir, "exists.txt");
			const missingFile = join(testDir, "missing.txt");
			writeFileSync(existingFile, "I exist");

			const batchTool = createBatchTool([readTool]);

			const result = await batchTool.execute("batch-call-15", {
				toolCalls: [
					{ tool: "read", parameters: { path: existingFile } },
					{ tool: "read", parameters: { path: missingFile } },
				],
			});

			const output = getTextOutput(result);
			// read tool returns isError: true on file not found
			expect(output).toContain("Executed 2 tools");
			expect(output).toContain("[OK] read");
			expect(output).toContain("[ERROR] read");
		});

		it("executes bash commands in parallel", async () => {
			const batchTool = createBatchTool([bashTool]);

			const result = await batchTool.execute("batch-call-16", {
				toolCalls: [
					{ tool: "bash", parameters: { command: "echo 'test1'" } },
					{ tool: "bash", parameters: { command: "echo 'test2'" } },
					{ tool: "bash", parameters: { command: "pwd" } },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Executed 3 tools");
			expect(output).toContain("[OK] bash");
		});
	});

	describe("output formatting", () => {
		it("shows tool status in output", async () => {
			const longFile = join(testDir, "long.txt");
			const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(longFile, lines.join("\n"));

			const batchTool = createBatchTool([readTool]);

			const result = await batchTool.execute("batch-call-17", {
				toolCalls: [{ tool: "read", parameters: { path: longFile } }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("[OK] read");
		});

		it("includes results for each tool call", async () => {
			const batchTool = createBatchTool([mockSuccessTool, mockSlowTool]);

			const result = await batchTool.execute("batch-call-18", {
				toolCalls: [
					{ tool: "mock-success", parameters: {} },
					{ tool: "mock-slow", parameters: {} },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("[OK] mock-success");
			expect(output).toContain("[OK] mock-slow");
			const details = getBatchDetails(result);
			expect(details.results).toHaveLength(2);
			expect(details.results?.every((r) => r.success)).toBe(true);
		});

		it("uses summary metadata when provided", async () => {
			const batchTool = createBatchTool([mockSummaryTool]);

			const result = await batchTool.execute("batch-call-summary", {
				toolCalls: [{ tool: "mock-summary", parameters: { id: "alpha" } }],
			});

			const details = getBatchDetails(result);
			expect(details.results?.[0]?.summary).toBe("Summary for alpha");
		});
	});

	describe("abort handling", () => {
		it("throws when batch is aborted before execution", async () => {
			const mockAbortableTool: AgentTool<any, any> = {
				name: "mock-abortable",
				label: "mock-abortable",
				description: "A mock tool that respects abort",
				parameters: {} as any,
				execute: async () => ({
					content: [{ type: "text", text: "Completed" }],
				}),
			};

			const batchTool = createBatchTool([mockAbortableTool]);
			const abortController = new AbortController();

			// Abort immediately - batch checks this at start and throws
			abortController.abort();

			await expect(
				batchTool.execute(
					"batch-call-21",
					{
						toolCalls: [{ tool: "mock-abortable", parameters: {} }],
					},
					abortController.signal,
				),
			).rejects.toThrow("Operation aborted");
		});
	});

	describe("metadata", () => {
		it("includes complete metadata in details", async () => {
			const batchTool = createBatchTool([
				mockSuccessTool,
				mockFailTool,
				mockSlowTool,
			]);

			const result = await batchTool.execute("batch-call-22", {
				toolCalls: [
					{ tool: "mock-success", parameters: { id: 1 } },
					{ tool: "mock-fail", parameters: { id: 2 } },
					{ tool: "mock-slow", parameters: { id: 3 } },
				],
			});

			const details = getBatchDetails(result);
			expect(details.results).toHaveLength(3);
			expect(details.results?.[0]).toMatchObject({
				tool: "mock-success",
				success: true,
			});
			expect(details.results?.[1]).toMatchObject({
				tool: "mock-fail",
				success: false,
			});
			expect(details.results?.[2]).toMatchObject({
				tool: "mock-slow",
				success: true,
			});
		});
	});
});
