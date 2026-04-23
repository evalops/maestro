import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/mcp/manager.js", () => ({
	mcpManager: {
		callTool: vi.fn(),
		getAllTools: vi.fn(() => []),
		getStatus: vi.fn(() => ({ servers: [] })),
		readResource: vi.fn(),
		getPrompt: vi.fn(),
	},
}));

vi.mock("../../src/telemetry/security-events.js", () => ({
	trackToolApprovalRequired: vi.fn(),
	trackToolBlocked: vi.fn(),
}));

import { mcpManager } from "../../src/mcp/manager.js";
import { createMcpToolWrapper } from "../../src/mcp/tool-bridge.js";
import {
	trackToolApprovalRequired,
	trackToolBlocked,
} from "../../src/telemetry/security-events.js";

const governedTool: McpTool = {
	name: "governed_tool",
	description: "Platform-governed test tool",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string" },
		},
	},
};

describe("MCP governed result handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("summarizes approval-required governed results and preserves approval metadata", async () => {
		vi.mocked(mcpManager.callTool).mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						decision: "require_approval",
						approval_id: "apr_123",
						reasons: ["Needs signoff"],
						risk_level: "high",
					}),
				},
			],
			structuredContent: {
				decision: "require_approval",
				approval_id: "apr_123",
				reasons: ["Needs signoff"],
				risk_level: "high",
			},
		});

		const tool = createMcpToolWrapper("evalops", governedTool);
		const result = await tool.execute("call-1", { query: "deploy" });

		expect(result.isError).toBe(false);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("Approval required.");
		expect(result.content[0]?.text).toContain("Approval request: apr_123");
		expect(result.details).toMatchObject({
			server: "evalops",
			tool: "governed_tool",
			governedOutcome: {
				classification: "approval_required",
				approvalRequestId: "apr_123",
				riskLevel: "high",
				reasons: ["Needs signoff"],
			},
		});
		expect(trackToolApprovalRequired).toHaveBeenCalledWith({
			toolName: "governed_tool",
			reason: "Needs signoff",
			source: "policy",
		});
		expect(trackToolBlocked).not.toHaveBeenCalled();
	});

	it("summarizes denied governed results and emits blocked telemetry", async () => {
		vi.mocked(mcpManager.callTool).mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						code: "governance_denied",
						message: "Blocked by governance policy",
						reasons: ["External network is disabled"],
					}),
				},
			],
			structuredContent: {
				code: "governance_denied",
				message: "Blocked by governance policy",
				reasons: ["External network is disabled"],
			},
			isError: true,
		});

		const tool = createMcpToolWrapper("evalops", governedTool);
		const result = await tool.execute("call-2", { query: "curl example.com" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Action denied.");
		expect(result.content[0]?.text).toContain("Blocked by governance policy");
		expect(result.details).toMatchObject({
			governedOutcome: {
				classification: "denied",
				code: "governance_denied",
				reasons: ["External network is disabled"],
			},
		});
		expect(trackToolBlocked).toHaveBeenCalledWith({
			toolName: "governed_tool",
			reason: "Blocked by governance policy",
			source: "policy",
			severity: "high",
		});
		expect(trackToolApprovalRequired).not.toHaveBeenCalled();
	});

	it("parses text-only rate-limit payloads when structured content is unavailable", async () => {
		vi.mocked(mcpManager.callTool).mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						code: "rate_limit_exceeded",
						message: "Too many requests",
						retry_after_seconds: 30,
					}),
				},
			],
			isError: true,
		});

		const tool = createMcpToolWrapper("evalops", governedTool);
		const result = await tool.execute("call-3", { query: "burst" });

		expect(result.content[0]?.text).toContain("Rate limit reached.");
		expect(result.content[0]?.text).toContain("Retry after: 30 seconds");
		expect(result.details).toMatchObject({
			governedOutcome: {
				classification: "rate_limited",
				code: "rate_limit_exceeded",
				retryAfterSeconds: 30,
			},
		});
		expect(trackToolBlocked).toHaveBeenCalledWith({
			toolName: "governed_tool",
			reason: "Too many requests",
			source: "policy",
			severity: "high",
		});
	});
});
