import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../src/agent/types.js";
import {
	READ_ONLY_TOOLS,
	WRITE_TOOLS,
	getOptimalConcurrency,
	getPathScopedMutation,
	isParallelSafeTool,
	isReadOnlyTool,
	isWriteTool,
	markDestructive,
	markReadOnly,
	partitionToolCalls,
	pathScopesOverlap,
} from "../../src/tools/parallel-execution.js";

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

		it("does not infer read-only status from MCP server parallel support", () => {
			expect(
				isReadOnlyTool("mcp__workspace__mutate_state", undefined, {
					type: "mcp",
					server: "workspace",
					tool: "mutate_state",
					supportsParallelToolCalls: true,
				}),
			).toBe(false);
		});
	});

	describe("isParallelSafeTool", () => {
		it("allows server-opted MCP tools to run in parallel without marking them read-only", () => {
			const source = {
				type: "mcp" as const,
				server: "workspace",
				tool: "mutate_state",
				supportsParallelToolCalls: true,
			};

			expect(
				isReadOnlyTool("mcp__workspace__mutate_state", undefined, source),
			).toBe(false);
			expect(
				isParallelSafeTool("mcp__workspace__mutate_state", undefined, source),
			).toBe(true);
		});

		it("does not allow destructive MCP tools into parallel-safe waves", () => {
			expect(
				isParallelSafeTool(
					"mcp__workspace__delete",
					{ destructiveHint: true },
					{
						type: "mcp",
						server: "workspace",
						tool: "delete",
						supportsParallelToolCalls: true,
					},
				),
			).toBe(false);
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
			const tool = {
				name: "test",
				description: "",
				parameters: {},
			} as AgentTool;
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
			const tool = {
				name: "test",
				description: "",
				parameters: {},
			} as AgentTool;
			const marked = markDestructive(tool);
			expect(marked.annotations?.destructiveHint).toBe(true);
		});
	});

	describe("path-scoped mutations", () => {
		it("canonicalizes relative and absolute paths before overlap checks", () => {
			const cwd = resolve("/tmp/maestro-path-scope");
			const tool = {
				name: "path_write",
				description: "",
				parameters: {},
				annotations: {
					destructiveHint: true,
					pathScopedMutationHint: true,
				},
			} as AgentTool;

			const relativeScope = getPathScopedMutation(
				{
					name: "path_write",
					arguments: { path: "src/a.ts" },
				},
				tool,
				cwd,
			);
			const absoluteScope = getPathScopedMutation(
				{
					name: "path_write",
					arguments: { path: resolve(cwd, "src/a.ts") },
				},
				tool,
				cwd,
			);
			const siblingScope = getPathScopedMutation(
				{
					name: "path_write",
					arguments: { path: "src/b.ts" },
				},
				tool,
				cwd,
			);

			expect(relativeScope).toBeDefined();
			expect(absoluteScope).toBeDefined();
			expect(siblingScope).toBeDefined();
			expect(relativeScope?.paths).toEqual(absoluteScope?.paths);
			expect(pathScopesOverlap(relativeScope!, absoluteScope!)).toBe(true);
			expect(pathScopesOverlap(relativeScope!, siblingScope!)).toBe(false);
		});

		it("case-folds mutation paths before overlap checks", () => {
			const cwd = resolve("/tmp/Maestro-Path-Scope");
			const tool = {
				name: "path_write",
				description: "",
				parameters: {},
				annotations: {
					destructiveHint: true,
					pathScopedMutationHint: true,
				},
			} as AgentTool;

			const mixedCaseScope = getPathScopedMutation(
				{
					name: "path_write",
					arguments: { path: "Src/A.ts" },
				},
				tool,
				cwd,
			);
			const lowerCaseScope = getPathScopedMutation(
				{
					name: "path_write",
					arguments: { path: resolve("/tmp/maestro-path-scope/src/a.ts") },
				},
				tool,
				cwd,
			);

			expect(mixedCaseScope).toBeDefined();
			expect(lowerCaseScope).toBeDefined();
			expect(mixedCaseScope?.paths).toEqual(lowerCaseScope?.paths);
			expect(pathScopesOverlap(mixedCaseScope!, lowerCaseScope!)).toBe(true);
		});
	});
});
