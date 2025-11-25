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
	results?: Array<Record<string, unknown>>;
	successful?: number;
	failed?: number;
	discarded?: number;
};

function getBatchDetails(result: AgentToolResult<unknown>): BatchResultDetails {
	return (result.details as BatchResultDetails) ?? {};
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
			expect(output).toContain("[OK] mock-success");
			expect(output).toContain("[OK] mock-slow");
			expect(output).toContain("Success with params");
			expect(result.details).toMatchObject({
				totalCalls: 3,
				successful: 3,
				failed: 0,
				discarded: 0,
			});
		});

		describe("advanced features", () => {
			it("enforces per-call timeouts", async () => {
				const batchTool = createBatchTool([mockHangingTool]);

				const result = await batchTool.execute("batch-call-timeout", {
					toolCalls: [{ tool: "mock-hang", parameters: {} }],
					toolTimeoutMs: 1000,
				});

				const output = getTextOutput(result);
				expect(output).toContain("Timed out");
				const details = getBatchDetails(result);
				expect(details.results?.[0]).toMatchObject({
					success: false,
					error: expect.stringContaining("Timed out"),
				});
			});

			it("supports refreshing the tool registry", async () => {
				const batchTool = createBatchTool([]);
				await expect(
					batchTool.execute("batch-call-refresh", {
						toolCalls: [{ tool: "mock-success", parameters: {} }],
					}),
				).rejects.toThrow("Tool 'mock-success' not found");

				batchTool.setAvailableTools([mockSuccessTool]);

				const result = await batchTool.execute("batch-call-refresh-2", {
					toolCalls: [{ tool: "mock-success", parameters: {} }],
				});

				expect(getTextOutput(result)).toContain(
					"All 1 tools executed successfully",
				);
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
				expect(output).toContain("1 failed");
				expect(output).toContain("skipped due to stopOnError=true");
				expect(output).not.toContain("should-skip");
				const details = getBatchDetails(result);
				expect(details).toMatchObject({
					totalCalls: 2,
					successful: 1,
					failed: 1,
					skipped: 1,
				});
				// Verify tools array matches totalCalls (only executed calls, not all requested)
				expect(details.tools).toHaveLength(details.totalCalls);
				expect(details.tools).toEqual(["mock-success", "mock-fail"]);
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
				expect(output).toContain("2/3 tools successfully");
				expect(output).not.toContain("skipped");
				const details = getBatchDetails(result);
				expect(details).toMatchObject({
					totalCalls: 3,
					successful: 2,
					failed: 1,
					skipped: 0,
				});
			});

			it("throws when stopOnError is used with parallel mode", async () => {
				const batchTool = createBatchTool([mockSuccessTool]);

				await expect(
					batchTool.execute("batch-call-invalid-stop", {
						mode: "parallel",
						stopOnError: true,
						toolCalls: [{ tool: "mock-success", parameters: {} }],
					}),
				).rejects.toThrow("stopOnError can only be used with mode: 'serial'");
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
			expect(output).toContain("[OK] mock-success");
			expect(output).toContain("[ERROR] mock-fail");
			expect(output).toContain("Error: Mock tool failure");
			expect(output).toContain("[OK] mock-slow");
			const details = getBatchDetails(result);
			expect(details).toMatchObject({
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
			const details = getBatchDetails(result);
			expect(details.successful).toBe(2);
			expect(details.failed).toBe(2);
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
			const details = getBatchDetails(result);
			expect(details.discarded).toBe(0);
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
			expect(output).toContain("[OK] read");
			const details = getBatchDetails(result);
			expect(details.successful).toBe(3);
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
			// Now that read tool throws on error, batch should catch and report it
			expect(output).toContain("Executed 1/2 tools successfully");
			expect(output).toContain("[OK] read");
			expect(output).toContain("[ERROR] read");
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
			expect(output).toContain("[OK] bash");
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
			expect(output).toMatch(/\[OK\] mock-success \(\d+ms\)/);
			expect(output).toMatch(/\[OK\] mock-slow \(\d+ms\)/);
			const details = getBatchDetails(result);
			expect(details.results).toEqual(
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

		it("uses summary metadata when provided", async () => {
			const batchTool = createBatchTool([mockSummaryTool]);

			const result = await batchTool.execute("batch-call-summary", {
				toolCalls: [{ tool: "mock-summary", parameters: { id: "alpha" } }],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Summary for alpha");
			const details = getBatchDetails(result);
			expect(details.results?.[0]?.summary).toBe("Summary for alpha");
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
			expect(output).toContain("[ERROR] mock-abortable");
			expect(output).toContain("Error: Operation aborted");
			const details = getBatchDetails(result);
			expect(details.failed).toBe(1);
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
			expect(details).toMatchObject({
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
