/**
 * Tests for extension dynamic tool registration (#851)
 *
 * This test suite validates that extensions can register custom tools
 * at runtime via the HookAPI.registerTool() method.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../src/agent/types.js";
import {
	applyExtensionToolState,
	clearLoadedTypeScriptHooks,
	discoverAndLoadTypeScriptHooks,
	executeTypeScriptHooks,
	getExtensionRegisteredTools,
} from "../src/hooks/index.js";
import type { SessionStartHookInput } from "../src/hooks/types.js";

describe("Extension Tool Registration", () => {
	let testDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		clearLoadedTypeScriptHooks();
		testDir = mkdtempSync(join(tmpdir(), "maestro-extension-tools-"));
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");
		mkdirSync(join(testDir, ".maestro", "hooks"), { recursive: true });
	});

	afterEach(() => {
		clearLoadedTypeScriptHooks();
		rmSync(testDir, { recursive: true, force: true });
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
	});

	describe("registerTool()", () => {
		it("should register a tool with valid parameters", () => {
			const mockAPI: HookAPI = {} as HookAPI;
			const tools: AgentTool[] = [];

			// Simulate registering a tool
			const registerTool = (tool: AgentTool) => {
				tools.push(tool);
			};

			const customTool: AgentTool = {
				name: "custom_search",
				description: "Search custom database",
				parameters: Type.Object({
					query: Type.String({ description: "Search query" }),
				}),
				execute: async (toolCallId, params) => {
					return {
						content: [
							{ type: "text", text: `Search results for: ${params.query}` },
						],
					};
				},
			};

			registerTool(customTool);

			expect(tools).toHaveLength(1);
			expect(tools[0]?.name).toBe("custom_search");
			expect(tools[0]?.description).toBe("Search custom database");
		});

		it("should namespace tool names to prevent conflicts", () => {
			const tools: AgentTool[] = [];

			const registerTool = (tool: AgentTool, extensionName: string) => {
				const namespacedTool = {
					...tool,
					name: `ext:${extensionName}:${tool.name}`,
				};
				tools.push(namespacedTool);
			};

			const tool: AgentTool = {
				name: "read",
				description: "Custom read",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "custom" }],
				}),
			};

			registerTool(tool, "myextension");

			expect(tools[0]?.name).toBe("ext:myextension:read");
		});

		it("should allow tools with TypeBox parameters", () => {
			const tool: AgentTool = {
				name: "calculate",
				description: "Perform calculation",
				parameters: Type.Object({
					operation: Type.Union([
						Type.Literal("add"),
						Type.Literal("subtract"),
						Type.Literal("multiply"),
					]),
					a: Type.Number(),
					b: Type.Number(),
				}),
				execute: async (toolCallId, params) => {
					const { operation, a, b } = params as {
						operation: string;
						a: number;
						b: number;
					};
					let result = 0;
					if (operation === "add") result = a + b;
					else if (operation === "subtract") result = a - b;
					else if (operation === "multiply") result = a * b;

					return {
						content: [{ type: "text", text: `Result: ${result}` }],
					};
				},
			};

			expect(tool.parameters).toBeDefined();
			expect(tool.execute).toBeDefined();
		});

		it("should support tool execution with signal and onUpdate", async () => {
			const onUpdateMock = vi.fn();
			const abortController = new AbortController();

			const tool: AgentTool = {
				name: "long_running",
				description: "Long running task",
				parameters: Type.Object({
					duration: Type.Number(),
				}),
				execute: async (toolCallId, params, signal, context, onUpdate) => {
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: "Processing..." }],
						});
					}

					// Simulate async work
					await new Promise((resolve) => setTimeout(resolve, 10));

					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "Aborted" }],
							isError: true,
						};
					}

					return {
						content: [{ type: "text", text: "Complete" }],
					};
				},
			};

			const result = await tool.execute(
				"call_123",
				{ duration: 100 },
				abortController.signal,
				undefined,
				onUpdateMock,
			);

			expect(onUpdateMock).toHaveBeenCalledWith({
				content: [{ type: "text", text: "Processing..." }],
			});
			expect(result.content[0]).toEqual({ type: "text", text: "Complete" });
		});

		it("should handle tool execution errors gracefully", async () => {
			const tool: AgentTool = {
				name: "failing_tool",
				description: "Tool that fails",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("Tool execution failed");
				},
			};

			await expect(tool.execute("call_123", {})).rejects.toThrow(
				"Tool execution failed",
			);
		});

		it("should support tool annotations (MCP hints)", () => {
			const tool: AgentTool = {
				name: "safe_read",
				description: "Read-only tool",
				parameters: Type.Object({
					path: Type.String(),
				}),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
				execute: async () => ({
					content: [{ type: "text", text: "data" }],
				}),
			};

			expect(tool.annotations?.readOnlyHint).toBe(true);
			expect(tool.annotations?.destructiveHint).toBe(false);
			expect(tool.annotations?.idempotentHint).toBe(true);
		});
	});

	describe("getExtensionRegisteredTools()", () => {
		it("should return empty array when no tools registered", () => {
			const tools = getExtensionRegisteredTools();
			expect(tools).toEqual([]);
		});

		it("returns namespaced tools loaded from TypeScript hooks", async () => {
			writeFileSync(
				join(testDir, ".maestro", "hooks", "custom-tools.ts"),
				`export default function (pi) {
  pi.registerTool({
    name: "custom_search",
    description: "Search custom database",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Search results for: " + params.query }],
    }),
  });
}
`,
			);

			await discoverAndLoadTypeScriptHooks([], testDir);

			expect(getExtensionRegisteredTools()).toEqual([
				expect.objectContaining({
					name: "hook__custom_tools__custom_search",
					label: "custom_search",
					description: "Search custom database",
				}),
			]);
		});

		it("supports runtime registration and active tool filtering from hook handlers", async () => {
			writeFileSync(
				join(testDir, ".maestro", "hooks", "runtime-tools.ts"),
				`export default function (pi) {
  pi.on("SessionStart", async () => {
    pi.registerTool({
      name: "runtime_search",
      description: "Search after startup",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: "Runtime result: " + params.query }],
      }),
    });
    pi.setActiveTools(["read", "runtime_search"]);
    return { continue: true };
  });
}
`,
			);

			await discoverAndLoadTypeScriptHooks([], testDir);

			const baseTools: AgentTool[] = [
				{
					name: "read",
					description: "Read files",
					parameters: Type.Object({}),
					execute: async () => ({ content: [] }),
				},
				{
					name: "write",
					description: "Write files",
					parameters: Type.Object({}),
					execute: async () => ({ content: [] }),
				},
			];

			expect(
				applyExtensionToolState(baseTools).map((tool) => tool.name),
			).toEqual(["read", "write"]);

			const input: SessionStartHookInput = {
				hook_event_name: "SessionStart",
				cwd: testDir,
				timestamp: new Date().toISOString(),
				source: "cli",
			};
			await executeTypeScriptHooks("SessionStart", input);

			expect(getExtensionRegisteredTools()).toEqual([
				expect.objectContaining({
					name: "hook__runtime_tools__runtime_search",
					label: "runtime_search",
				}),
			]);
			expect(
				applyExtensionToolState(baseTools).map((tool) => tool.name),
			).toEqual(["read", "hook__runtime_tools__runtime_search"]);
		});
	});

	describe("Tool execution context", () => {
		it("should provide sandbox context to tools when available", async () => {
			let receivedContext: unknown = null;

			const tool: AgentTool = {
				name: "sandbox_tool",
				description: "Tool that uses sandbox",
				parameters: Type.Object({}),
				execute: async (toolCallId, params, signal, context) => {
					receivedContext = context;
					return {
						content: [{ type: "text", text: "done" }],
					};
				},
			};

			const mockSandbox = { type: "docker" };
			await tool.execute("call_123", {}, undefined, {
				// @ts-expect-error - mock sandbox for testing
				sandbox: mockSandbox,
			});

			expect(receivedContext).toEqual({ sandbox: mockSandbox });
		});
	});

	describe("Tool validation", () => {
		it("should require name, description, parameters, and execute", () => {
			const validTool: AgentTool = {
				name: "valid",
				description: "A valid tool",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "ok" }],
				}),
			};

			expect(validTool.name).toBeTruthy();
			expect(validTool.description).toBeTruthy();
			expect(validTool.parameters).toBeDefined();
			expect(typeof validTool.execute).toBe("function");
		});

		it("should reject tool names with invalid characters", () => {
			// Valid tool names: alphanumeric, underscores, hyphens
			// Invalid: spaces, slashes, empty strings
			const invalidNames = ["tool with spaces", "tool/with/slashes", ""];

			for (const name of invalidNames) {
				const isValid = /^[a-z0-9_:-]+$/i.test(name);
				expect(isValid).toBe(false);
			}
		});

		it("should accept valid tool names", () => {
			const validNames = ["my_tool", "tool-123", "CustomTool"];

			for (const name of validNames) {
				const isValid = /^[a-z0-9_:-]+$/i.test(name);
				expect(isValid).toBe(true);
			}
		});
	});
});
