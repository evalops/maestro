import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";
import {
	SemanticJudge,
	type SemanticJudgeContext,
} from "../../src/safety/semantic-judge.js";

// Mock judge function
const mockJudgeFunc = vi.fn();

describe("SemanticJudge", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("approves safe actions", async () => {
		const judge = new SemanticJudge(mockJudgeFunc);
		mockJudgeFunc.mockResolvedValue(
			JSON.stringify({ safe: true, reason: "Command is safe" }),
		);

		const result = await judge.evaluate({
			userIntent: "List files",
			toolName: "bash",
			toolArgs: { command: "ls -la" },
		});

		expect(result.safe).toBe(true);
		expect(result.reason).toBe("Command is safe");
	});

	it("flags unsafe actions", async () => {
		const judge = new SemanticJudge(mockJudgeFunc);
		mockJudgeFunc.mockResolvedValue(
			JSON.stringify({
				safe: false,
				reason: "Command deletes entire filesystem",
			}),
		);

		const result = await judge.evaluate({
			userIntent: "Delete logs",
			toolName: "bash",
			toolArgs: { command: "rm -rf /" },
		});

		expect(result.safe).toBe(false);
		expect(result.reason).toBe("Command deletes entire filesystem");
	});

	it("handles invalid JSON gracefully (fails open)", async () => {
		const judge = new SemanticJudge(mockJudgeFunc);
		mockJudgeFunc.mockResolvedValue("Not JSON");

		const result = await judge.evaluate({
			userIntent: "Test",
			toolName: "test",
			toolArgs: {},
		});

		expect(result.safe).toBe(true); // Fails open
		expect(result.reason).toContain("response invalid");
	});

	it("handles markdown code blocks in response", async () => {
		const judge = new SemanticJudge(mockJudgeFunc);
		mockJudgeFunc.mockResolvedValue(
			`\`\`\`json\n${JSON.stringify({ safe: true, reason: "Cleaned markdown" })}\n\`\`\``,
		);

		const result = await judge.evaluate({
			userIntent: "Test",
			toolName: "test",
			toolArgs: {},
		});

		expect(result.safe).toBe(true);
		expect(result.reason).toBe("Cleaned markdown");
	});
});
