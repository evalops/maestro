import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHeadlessPostKeepMessages } from "../../src/headless/prompt-recovery.js";
import { mcpManager } from "../../src/mcp/index.js";

vi.mock("../../src/mcp/index.js", () => ({
	mcpManager: {
		getStatus: vi.fn(() => ({ servers: [] })),
	},
}));

describe("withHeadlessPostKeepMessages", () => {
	beforeEach(() => {
		vi.mocked(mcpManager.getStatus)
			.mockReset()
			.mockReturnValue({ servers: [] });
	});

	it("combines MCP restoration with pending headless client requests", async () => {
		const getPostKeepMessages = withHeadlessPostKeepMessages(() => ({
			pending_approvals: [
				{
					call_id: "call_bash",
					tool: "bash",
					args: { command: "git push --force" },
				},
			],
			pending_client_tools: [
				{
					call_id: "call_client",
					tool: "artifacts",
					args: { command: "create", filename: "report.txt" },
				},
			],
			pending_user_inputs: [
				{
					call_id: "call_user_input",
					tool: "ask_user",
					args: {
						questions: [
							{
								header: "Stack",
								question: "Which schema library should we use?",
							},
						],
					},
				},
			],
			pending_tool_retries: [
				{
					call_id: "call_retry",
					request_id: "retry_1",
					tool: "bash",
					args: {
						tool_call_id: "call_retry",
						args: { command: "ls" },
						error_message: "Command failed",
						attempt: 1,
					},
				},
			],
		}));

		await expect(getPostKeepMessages([])).resolves.toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: "headless-client-requests",
				display: false,
				content: expect.stringContaining(
					"# Pending headless runtime requests restored after compaction",
				),
			}),
		]);
	});
});
