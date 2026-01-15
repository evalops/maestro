import { describe, expect, it } from "vitest";
import {
	READ_ONLY_TOOLS,
	WRITE_TOOLS,
	isReadOnlyTool,
	isWriteTool,
	getOptimalConcurrency,
	partitionToolCalls,
	markReadOnly,
	markDestructive,
} from "../../src/tools/parallel-execution.js";
import type { AgentTool } from "../../src/agent/types.js";

describe("parallel-execution", () => {
	describe("READ_ONLY_TOOLS", () => {
		it("contains common read operations", () => {
			expect(READ_ONLY_TOOLS.has("Read")).toBe(true);
			expect(READ_ONLY_TOOLS.has("read")).toBe(true);
			expect(READ_ONLY_TOOLS.has("Grep")).toBe(true);
			expect(READ_ONLY_TOOLS.has("search")).toBe(true);
			expect(READ_ONLY_TOOLS.has("diff")).toBe(true);
			expect(READ_ONLY_TOOLS.has("status")).toBe(true);
		});

		it("does not contain write operations", () => {
			expect(READ_ONLY_TOOLS.has("write")).toBe(false);
			expect(READ_ONLY_TOOLS.has("edit")).toBe(false);
			expect(READ_ONLY_TOOLS.has("bash")).toBe(false);
		});
	});

	describe("WRITE_TOOLS", () => {
		it("contains common write operations", () => {
			expect(WRITE_TOOLS.has("write")).toBe(true);
			expect(WRITE_TOOLS.has("Write")).toBe(true);
			expect(WRITE_TOOLS.has("edit")).toBe(true);
			expect(WRITE_TOOLS.has("bash")).toBe(true);
		});
	});

	describe("isReadOnlyTool", () => {
		it("returns true for known read-only tools", () => {
			expect(isReadOnlyTool("Read")).toBe(true);
			expect(isReadOnlyTool("Grep")).toBe(true);
			expect(isReadOnlyTool("search")).toBe(true);
		});

		it("returns false for known write tools", () => {
			expect(isReadOnlyTool("write")).toBe(false);
			expect(isReadOnlyTool("bash")).toBe(false);
		});

		it("respects explicit readOnlyHint annotation", () => {
			expect(isReadOnlyTool("custom_tool", { readOnlyHint: true })).toBe(true);
			expect(isReadOnlyTool("Read", { readOnlyHint: false })).toBe(false);
		});

		it("returns false for unknown tools without annotation", () => {
			expect(isReadOnlyTool("unknown_tool")).toBe(false);
		});
	});

	describe("isWriteTool", () => {
		it("returns true for known write tools", () => {
			expect(isWriteTool("write")).toBe(true);
			expect(isWriteTool("edit")).toBe(true);
		});

		it("returns false for read-only tools", () => {
			expect(isWriteTool("Read")).toBe(false);
			expect(isWriteTool("search")).toBe(false);
		});

		it("respects explicit destructiveHint annotation", () => {
			expect(isWriteTool("custom_tool", { destructiveHint: true })).toBe(true);
		});
	});

	describe("getOptimalConcurrency", () => {
		const mockTools: AgentTool[] = [
			{ name: "read", description: "", parameters: {} } as AgentTool,
			{ name: "write", description: "", parameters: {} } as AgentTool,
			{
				name: "custom_readonly",
				description: "",
				parameters: {},
				annotations: { readOnlyHint: true },
			} as AgentTool,
		];

		it("returns base concurrency for empty batch", () => {
			expect(getOptimalConcurrency([], mockTools)).toBe(2);
		});

		it("returns higher concurrency for all read-only tools", () => {
			const toolCalls = [{ name: "read" }, { name: "read" }, { name: "read" }];
			const concurrency = getOptimalConcurrency(toolCalls, mockTools);
			expect(concurrency).toBeGreaterThan(2);
		});

		it("returns base concurrency when write tools present", () => {
			const toolCalls = [{ name: "read" }, { name: "write" }];
			const concurrency = getOptimalConcurrency(toolCalls, mockTools);
			expect(concurrency).toBe(2);
		});

		it("respects maxReadOnlyConcurrency config", () => {
			const toolCalls = Array(20).fill({ name: "read" });
			const concurrency = getOptimalConcurrency(toolCalls, mockTools, {
				maxReadOnlyConcurrency: 4,
			});
			expect(concurrency).toBe(4);
		});

		it("respects enabled flag", () => {
			const toolCalls = [{ name: "read" }, { name: "read" }];
			const concurrency = getOptimalConcurrency(toolCalls, mockTools, {
				enabled: false,
			});
			expect(concurrency).toBe(2);
		});

		it("uses tool annotations for custom tools", () => {
			const toolCalls = [{ name: "custom_readonly" }];
			const concurrency = getOptimalConcurrency(toolCalls, mockTools);
			expect(concurrency).toBeGreaterThanOrEqual(1);
		});
	});

	describe("partitionToolCalls", () => {
		const mockTools: AgentTool[] = [
			{ name: "read", description: "", parameters: {} } as AgentTool,
			{ name: "write", description: "", parameters: {} } as AgentTool,
			{ name: "search", description: "", parameters: {} } as AgentTool,
		];

		it("partitions tools into read-only and write groups", () => {
			const toolCalls = [
				{ name: "read", id: "1" },
				{ name: "write", id: "2" },
				{ name: "search", id: "3" },
			];

			const { readOnly, write } = partitionToolCalls(toolCalls, mockTools);

			expect(readOnly).toHaveLength(2);
			expect(write).toHaveLength(1);
			expect(readOnly.map((t) => t.name)).toContain("read");
			expect(readOnly.map((t) => t.name)).toContain("search");
			expect(write.map((t) => t.name)).toContain("write");
		});

		it("preserves original tool call objects", () => {
			const toolCalls = [{ name: "read", extra: "data" }];
			const { readOnly } = partitionToolCalls(toolCalls, mockTools);
			expect(readOnly[0]?.extra).toBe("data");
		});

		it("handles empty input", () => {
			const { readOnly, write } = partitionToolCalls([], mockTools);
			expect(readOnly).toHaveLength(0);
			expect(write).toHaveLength(0);
		});
	});

	describe("markReadOnly", () => {
		it("adds readOnlyHint annotation", () => {
			const tool = { name: "test", description: "", parameters: {} } as AgentTool;
			const marked = markReadOnly(tool);
			expect(marked.annotations?.readOnlyHint).toBe(true);
		});

		it("preserves existing annotations", () => {
			const tool = {
				name: "test",
				description: "",
				parameters: {},
				annotations: { idempotentHint: true },
			} as AgentTool;
			const marked = markReadOnly(tool);
			expect(marked.annotations?.readOnlyHint).toBe(true);
			expect(marked.annotations?.idempotentHint).toBe(true);
		});
	});

	describe("markDestructive", () => {
		it("adds destructiveHint annotation", () => {
			const tool = { name: "test", description: "", parameters: {} } as AgentTool;
			const marked = markDestructive(tool);
			expect(marked.annotations?.destructiveHint).toBe(true);
		});
	});
});
