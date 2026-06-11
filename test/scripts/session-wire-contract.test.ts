import { describe, expect, it } from "vitest";
import { validateSessionToolResultCompleteness } from "../../scripts/check-session-wire-contract.js";

describe("session wire contract check", () => {
	it("rejects a fixture with an assistant tool call but no tool result", () => {
		const resultlessFixture = [
			{
				type: "session",
				id: "session-1",
				timestamp: "2024-01-15T10:30:00.000Z",
				cwd: "/tmp",
				model: "openai/gpt-5.2",
				thinkingLevel: "medium",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2024-01-15T10:30:00.000Z",
				message: {
					role: "assistant",
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.2",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "toolUse",
					timestamp: 1,
					content: [
						{
							type: "toolCall",
							id: "call-missing",
							name: "read",
							arguments: { path: "README.md" },
						},
					],
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n");

		expect(() =>
			validateSessionToolResultCompleteness(
				resultlessFixture,
				"resultless-tool-call.fixture.jsonl",
			),
		).toThrow(/call-missing/u);
	});
});
