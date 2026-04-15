import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../../src/agent/providers/validation.js";
import type { AgentTool, ToolCall } from "../../src/agent/types.js";

// Split tokens to avoid triggering secret scanners in the repo.
const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_OPENAI_KEY = joinParts(
	"sk",
	"-",
	"abc123def456ghi789jkl012mno345pqr678",
);

describe("validateToolArguments redaction", () => {
	it("redacts sensitive values in validation errors", () => {
		const tool: AgentTool = {
			name: "demo",
			description: "demo tool",
			parameters: Type.Object({ value: Type.Number() }),
			execute: async () => ({ content: [] }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_1",
			name: "demo",
			arguments: { value: SAMPLE_OPENAI_KEY },
		};

		let errorMessage = "";
		try {
			validateToolArguments(tool, toolCall);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}

		expect(errorMessage).toContain("Received arguments (sanitized)");
		expect(errorMessage).toContain("[REDACTED:");
		expect(errorMessage).not.toContain("abc123def456");
	});
});
