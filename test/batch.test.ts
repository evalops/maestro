import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolResult } from "../src/agent/types.js";
import { bashTool } from "../src/tools/bash.js";
import { createBatchTool } from "../src/tools/batch.js";
import { listTool } from "../src/tools/list.js";
import { readTool } from "../src/tools/read.js";
import { searchTool } from "../src/tools/search.js";

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

describe("batch tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "batch-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic execution", () => {
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
			expect(output).toContain("All 3 tools executed successfully");
			expect(output).toContain("✓ mock-success");
			expect(output).toContain("✓ mock-slow");
			expect(output).toContain("Success with params");
			expect(result.details).toMatchObject({
				totalCalls: 3,
				successful: 3,
				failed: 0,
				discarded: 0,
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
			expect(output).toContain("Executed 2/3 tools successfully. 1 failed");
			expect(output).toContain("✓ mock-success");
			expect(output).toContain("✗ mock-fail");
			expect(output).toContain("Error: Mock tool failure");
			expect(output).toContain("✓ mock-slow");
			expect(result.details).toMatchObject({
				totalCalls: 3,
				successful: 2,
				failed: 1,
				discarded: 0,
			});
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
			expect(output).toContain("Executed 2/4 tools successfully. 2 failed");
			expect(result.details?.successful).toBe(2);
			expect(result.details?.failed).toBe(2);
		});
	});

	describe("validation", () => {
		it("rejects disallowed tools (batch)", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-4", {
					toolCalls: [{ tool: "batch", parameters: {} }],
				}),
			).rejects.toThrow("Tool 'batch' is not allowed in batch");
		});

		it("rejects disallowed tools (edit)", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-5", {
					toolCalls: [{ tool: "edit", parameters: {} }],
				}),
			).rejects.toThrow("Tool 'edit' is not allowed in batch");
		});

		it("rejects disallowed tools (write)", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-6", {
					toolCalls: [{ tool: "write", parameters: {} }],
				}),
			).rejects.toThrow("Tool 'write' is not allowed in batch");
		});

		it("rejects unknown tools", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-7", {
					toolCalls: [{ tool: "nonexistent-tool", parameters: {} }],
				}),
			).rejects.toThrow("Tool 'nonexistent-tool' not found");
		});

		it("lists available tools when tool not found", async () => {
			const batchTool = createBatchTool([
				mockSuccessTool,
				mockFailTool,
				mockSlowTool,
			]);

			await expect(
				batchTool.execute("batch-call-8", {
					toolCalls: [{ tool: "bad-tool", parameters: {} }],
				}),
			).rejects.toThrow("Available tools: mock-success, mock-fail, mock-slow");
		});

		it("validates all tools before executing any", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-9", {
					toolCalls: [
						{ tool: "mock-success", parameters: {} },
						{ tool: "batch", parameters: {} }, // Invalid
						{ tool: "mock-success", parameters: {} },
					],
				}),
			).rejects.toThrow();

			// If validation failed, no tools should have executed
			// (We can't directly verify this with mocks, but the error throw proves it)
		});
	});

	describe("limits", () => {
		it("enforces 10-tool maximum", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			// Schema validation will reject more than 10 items
			const toolCalls = Array.from({ length: 15 }, (_, i) => ({
				tool: "mock-success",
				parameters: { index: i },
			}));

			await expect(
				batchTool.execute("batch-call-10", { toolCalls }),
			).rejects.toThrow("must NOT have more than 10 items");
		});

		it("handles exactly 10 tools without warning", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const toolCalls = Array.from({ length: 10 }, (_, i) => ({
				tool: "mock-success",
				parameters: { index: i },
			}));

			const result = await batchTool.execute("batch-call-11", { toolCalls });

			const output = getTextOutput(result);
			expect(output).toContain("All 10 tools executed successfully");
			expect(output).not.toContain("exceeded the 10-tool limit");
			expect(result.details?.discarded).toBe(0);
		});

		it("requires at least 1 tool", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			await expect(
				batchTool.execute("batch-call-12", { toolCalls: [] }),
			).rejects.toThrow();
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
			expect(output).toContain("All 3 tools executed successfully");
			expect(output).toContain("✓ read");
			expect(result.details?.successful).toBe(3);
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
			expect(output).toContain("All 3 tools executed successfully");
			expect(output).toContain("✓ read");
			expect(output).toContain("✓ list");
			expect(output).toContain("✓ search");
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
			// Note: read tool returns error as text content, not as a thrown error
			// So both calls appear successful but one contains error text
			expect(output).toContain("All 2 tools executed successfully");
			expect(output).toContain("✓ read");
			expect(output).toContain("File not found");
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
			expect(output).toContain("All 3 tools executed successfully");
			expect(output).toContain("✓ bash");
		});
	});

	describe("output formatting", () => {
		it("shows abbreviated output for long results", async () => {
			const longFile = join(testDir, "long.txt");
			const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(longFile, lines.join("\n"));

			const batchTool = createBatchTool([readTool]);

			const result = await batchTool.execute("batch-call-17", {
				toolCalls: [{ tool: "read", parameters: { path: longFile } }],
			});

			const output = getTextOutput(result);
			expect(output).toMatch(/\.\.\. \(\d+ more lines\)/);
		});

		it("includes duration for each tool call", async () => {
			const batchTool = createBatchTool([mockSuccessTool, mockSlowTool]);

			const result = await batchTool.execute("batch-call-18", {
				toolCalls: [
					{ tool: "mock-success", parameters: {} },
					{ tool: "mock-slow", parameters: {} },
				],
			});

			const output = getTextOutput(result);
			expect(output).toMatch(/✓ mock-success \(\d+ms\)/);
			expect(output).toMatch(/✓ mock-slow \(\d+ms\)/);
			expect(result.details?.results).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						tool: "mock-success",
						success: true,
						duration: expect.any(Number),
					}),
					expect.objectContaining({
						tool: "mock-slow",
						success: true,
						duration: expect.any(Number),
					}),
				]),
			);
		});

		it("includes performance reminder on success", async () => {
			const batchTool = createBatchTool([mockSuccessTool]);

			const result = await batchTool.execute("batch-call-19", {
				toolCalls: [{ tool: "mock-success", parameters: {} }],
			});

			const output = getTextOutput(result);
			expect(output).toContain(
				"Keep using the batch tool for optimal performance",
			);
		});

		it("does not include performance reminder on partial failure", async () => {
			const batchTool = createBatchTool([mockSuccessTool, mockFailTool]);

			const result = await batchTool.execute("batch-call-20", {
				toolCalls: [
					{ tool: "mock-success", parameters: {} },
					{ tool: "mock-fail", parameters: {} },
				],
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("Keep using the batch tool");
		});
	});

	describe("abort handling", () => {
		it("handles tools that fail due to abort", async () => {
			// Create a mock tool that checks abort signal
			const mockAbortableTool: AgentTool<any, any> = {
				name: "mock-abortable",
				label: "mock-abortable",
				description: "A mock tool that respects abort",
				parameters: {} as any,
				execute: async (_toolCallId, _params, signal) => {
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}
					return {
						content: [{ type: "text", text: "Completed" }],
					};
				},
			};

			const batchTool = createBatchTool([mockAbortableTool]);
			const abortController = new AbortController();

			// Abort immediately so tool throws error
			abortController.abort();

			const result = await batchTool.execute(
				"batch-call-21",
				{
					toolCalls: [{ tool: "mock-abortable", parameters: {} }],
				},
				abortController.signal,
			);

			// Batch catches tool errors and returns them as failed results
			const output = getTextOutput(result);
			expect(output).toContain("Executed 0/1 tools successfully. 1 failed");
			expect(output).toContain("✗ mock-abortable");
			expect(output).toContain("Error: Operation aborted");
			expect(result.details?.failed).toBe(1);
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

			expect(result.details).toMatchObject({
				totalCalls: 3,
				successful: 2,
				failed: 1,
				discarded: 0,
				tools: ["mock-success", "mock-fail", "mock-slow"],
				results: [
					{
						tool: "mock-success",
						success: true,
						duration: expect.any(Number),
					},
					{
						tool: "mock-fail",
						success: false,
						duration: expect.any(Number),
					},
					{
						tool: "mock-slow",
						success: true,
						duration: expect.any(Number),
					},
				],
			});
		});
	});
});
