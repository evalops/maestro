import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpManager } from "../../src/mcp/manager.js";
import { buildMcpToolCollisionName } from "../../src/mcp/names.js";
import { getAllMcpTools, getMcpToolMap } from "../../src/mcp/tool-bridge.js";

vi.mock("../../src/mcp/manager.js", () => ({
	mcpManager: {
		getAllTools: vi.fn(() => []),
		getStatus: vi.fn(() => ({
			servers: [],
		})),
		readResource: vi.fn(),
		getPrompt: vi.fn(),
	},
}));

describe("MCP helper tools", () => {
	beforeEach(() => {
		vi.mocked(mcpManager.getAllTools).mockReturnValue([]);
		vi.mocked(mcpManager.getStatus).mockReturnValue({
			servers: [
				{
					name: "docs",
					connected: true,
					transport: "stdio",
					scope: "project",
					tools: [],
					resources: ["memo://guide"],
					prompts: ["summarize"],
				},
			],
		});
		vi.mocked(mcpManager.getPrompt).mockResolvedValue({
			description: "Summarize docs",
			messages: [{ role: "user", content: "Summarize MCP" }],
		});
	});

	it("registers MCP helper tools with the main MCP tool list", () => {
		const names = getAllMcpTools().map((tool) => tool.name);

		expect(names).toContain("mcp_list_resources");
		expect(names).toContain("mcp_read_resource");
		expect(names).toContain("mcp_list_prompts");
		expect(names).toContain("mcp_get_prompt");
	});

	it("executes mcp_list_prompts using MCP manager status", async () => {
		const tool = getAllMcpTools().find(
			(entry) => entry.name === "mcp_list_prompts",
		);
		expect(tool).toBeDefined();

		const result = await tool!.execute("call-1", {});

		expect(result.isError).toBe(false);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("# Available MCP Prompts");
		expect(result.content[0]?.text).toContain("## docs");
		expect(result.content[0]?.text).toContain("summarize");
	});

	it("executes mcp_get_prompt using MCP manager prompt fetch", async () => {
		const tool = getAllMcpTools().find(
			(entry) => entry.name === "mcp_get_prompt",
		);
		expect(tool).toBeDefined();

		const result = await tool!.execute("call-2", {
			server: "docs",
			name: "summarize",
			args: { topic: "MCP" },
		});

		expect(vi.mocked(mcpManager.getPrompt)).toHaveBeenCalledWith(
			"docs",
			"summarize",
			{ topic: "MCP" },
		);
		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("Prompt: summarize");
		expect(result.content[0]?.text).toContain("Description: Summarize docs");
		expect(result.content[0]?.text).toContain("[user]");
		expect(result.content[0]?.text).toContain("Summarize MCP");
	});

	it("preserves colliding sanitized MCP tool names in the tool map", () => {
		vi.mocked(mcpManager.getAllTools).mockReturnValue([
			{
				server: "docs",
				tool: {
					name: "read",
					inputSchema: { type: "object" },
				},
				supportsParallelToolCalls: false,
				parallelSafety: {
					supportsParallelToolCalls: false,
					provenance: "none",
				},
			},
			{
				server: "docs",
				tool: {
					name: "read",
					inputSchema: { type: "object" },
				},
				supportsParallelToolCalls: false,
				parallelSafety: {
					supportsParallelToolCalls: false,
					provenance: "none",
				},
			},
		]);

		const toolNames = [...getMcpToolMap().keys()].filter((name) =>
			name.startsWith("mcp__docs__read"),
		);

		expect(toolNames).toHaveLength(2);
		expect(new Set(toolNames).size).toBe(2);
		expect(toolNames).toContain(
			`${buildMcpToolCollisionName("docs", "read")}1_`,
		);
		expect(toolNames).toContain(
			`${buildMcpToolCollisionName("docs", "read")}2_`,
		);
	});
});
