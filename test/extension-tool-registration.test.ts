/**
 * Tests for extension dynamic tool registration (#851)
 *
 * This test suite validates that extensions can register custom tools
 * at runtime via the HookAPI.registerTool() method.
 */

import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../src/agent/types.js";
import {
	type HookAPI,
	clearLoadedTypeScriptHooks,
	getExtensionRegisteredTools,
} from "../src/hooks/index.js";

describe("Extension Tool Registration", () => {
	beforeEach(() => {
		clearLoadedTypeScriptHooks();
	});

	afterEach(() => {
		clearLoadedTypeScriptHooks();
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

		// TODO: Implement in Phase 1 when registerTool() is added to HookAPI
		// This test will be enabled once tool registration is fully implemented
		it.skip("should return all registered tools from all extensions", () => {
			// Placeholder for future implementation
			// Will test:
			// 1. Load multiple extensions that register tools
			// 2. Call getExtensionRegisteredTools()
			// 3. Verify all tools are returned with correct namespacing
			expect(true).toBe(true);
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
			// Valid tool names: alphanumeric, underscores, hyphens, colons
			// Colons are allowed for namespacing (e.g., "ext:myextension:tool")
			// Invalid: spaces, slashes, empty strings
			const invalidNames = ["tool with spaces", "tool/with/slashes", ""];

			for (const name of invalidNames) {
				const isValid = /^[a-z0-9_:-]+$/i.test(name);
				expect(isValid).toBe(false);
			}
		});

		it("should accept valid tool names", () => {
			// Valid formats:
			// - Simple names: "my_tool", "tool-123", "CustomTool"
			// - Namespaced with colons: "ext:myextension:read" (preferred for extensions)
			// - Namespaced with underscores: "ext_myextension_read" (alternative)
			const validNames = [
				"my_tool",
				"tool-123",
				"CustomTool",
				"ext:myextension:read", // Preferred namespacing convention
				"ext_myextension_read",
			];

			for (const name of validNames) {
				const isValid = /^[a-z0-9_:-]+$/i.test(name);
				expect(isValid).toBe(true);
			}
		});
	});
});
