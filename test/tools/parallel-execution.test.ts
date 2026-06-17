import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../src/agent/types.js";
import {
	READ_ONLY_TOOLS,
	WRITE_TOOLS,
	getOptimalConcurrency,
	getPathScopedMutation,
	isParallelReadOnlyTool,
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

		it("does not allow MCP annotations to lower approval requirements", () => {
			expect(
				isReadOnlyTool("mcp__workspace__inspect", { readOnlyHint: true }),
			).toBe(false);
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
		it("keeps approval-gated MCP tools out of parallel lanes", () => {
			const source = {
				type: "mcp" as const,
				server: "workspace",
				tool: "mutate_state",
				supportsParallelToolCalls: true,
			};

			expect(isParallelReadOnlyTool("mcp__workspace__mutate_state")).toBe(
				false,
			);
			expect(
				isParallelSafeTool("mcp__workspace__mutate_state", undefined, source),
			).toBe(false);
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

		it("does not classify read-only hinted MCP tools as parallel read-only", () => {
			expect(
				isParallelReadOnlyTool(
					"mcp__workspace__read_state",
					{ readOnlyHint: true },
					{
						type: "mcp",
						server: "workspace",
						tool: "read_state",
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

		it("keeps approval-gated MCP reads at base concurrency", () => {
			const mcpReadTool = {
				name: "mcp__remote__read",
				description: "",
				parameters: {},
				annotations: { readOnlyHint: true },
				source: {
					type: "mcp" as const,
					server: "remote",
					tool: "read",
					supportsParallelToolCalls: true,
				},
			} as AgentTool;
			const concurrency = getOptimalConcurrency(
				[{ name: "mcp__remote__read" }, { name: "mcp__remote__read" }],
				[mcpReadTool],
			);
			expect(concurrency).toBe(2);
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

		it("does not place approval-gated MCP reads into the read-only partition", () => {
			const toolCalls = [{ name: "mcp__remote__read", id: "1" }];
			const tools = [
				{
					name: "mcp__remote__read",
					description: "",
					parameters: {},
					annotations: { readOnlyHint: true },
					source: {
						type: "mcp" as const,
						server: "remote",
						tool: "read",
						supportsParallelToolCalls: true,
					},
				} as AgentTool,
			];

			const { readOnly, write } = partitionToolCalls(toolCalls, tools);

			expect(readOnly).toHaveLength(0);
			expect(write).toHaveLength(1);
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

		it("infers paths from nested multi-edit argument envelopes", () => {
			const cwd = resolve("/tmp/maestro-nested-path-scope");
			const scope = getPathScopedMutation(
				{
					name: "MultiEdit",
					arguments: {
						edits: [
							{ file_path: "src/a.ts", old_string: "a", new_string: "b" },
							{ targetPath: "src/b.ts", old_string: "c", new_string: "d" },
						],
					},
				},
				undefined,
				cwd,
			);

			expect(scope?.source).toBe("known_tool");
			expect(scope?.argumentKeys).toContain("edits");
			expect(scope?.argumentKeys).toContain("file_path");
			expect(scope?.argumentKeys).toContain("targetPath");
			expect(scope?.paths).toEqual([
				resolve(cwd, "src/a.ts").toLowerCase(),
				resolve(cwd, "src/b.ts").toLowerCase(),
			]);
		});

		it("infers apply_patch targets from patch headers", () => {
			const cwd = resolve("/tmp/maestro-patch-path-scope");
			const scope = getPathScopedMutation(
				{
					name: "apply_patch",
					arguments: {
						patch: [
							"*** Begin Patch",
							"*** Update File: src/a.ts",
							"@@",
							"-old",
							"+new",
							"*** Add File: src/b.ts",
							"+created",
							"*** End Patch",
						].join("\n"),
					},
				},
				undefined,
				cwd,
			);

			expect(scope?.argumentKeys).toContain("patch");
			expect(scope?.paths).toEqual([
				resolve(cwd, "src/a.ts").toLowerCase(),
				resolve(cwd, "src/b.ts").toLowerCase(),
			]);
		});

		it("does not path-scope bash commands from partial shell heuristics", () => {
			const cwd = resolve("/tmp/maestro-shell-path-scope");
			const scope = getPathScopedMutation(
				{
					name: "bash",
					arguments: {
						command:
							"echo updated > src/a.ts; printf more >> 'src/b.ts'; touch src/c.ts",
					},
				},
				undefined,
				cwd,
			);

			expect(scope).toBeUndefined();
		});

		it("does not path-scope background task commands from partial shell heuristics", () => {
			const cwd = resolve("/tmp/maestro-background-path-scope");
			const scope = getPathScopedMutation(
				{
					name: "background_tasks",
					arguments: {
						action: "start",
						command: "node scripts/build.js | tee tmp/build.log",
					},
				},
				undefined,
				cwd,
			);

			expect(scope).toBeUndefined();
		});
	});
});
