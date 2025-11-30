import { describe, expect, it } from "vitest";

import {
	type RawMessage,
	convertToComposerMessage,
} from "../lib/message-converter.js";

describe("convertToComposerMessage", () => {
	it("normalizes tool role and timestamp when content is a string", () => {
		const message: RawMessage = {
			role: "toolResult",
			content: "result text",
			timestamp: 0,
			toolName: "example",
		};

		const converted = convertToComposerMessage(message);

		expect(converted.role).toBe("tool");
		expect(converted.content).toBe("result text");
		expect(converted.timestamp).toBe(new Date(0).toISOString());
		expect(converted.toolName).toBe("example");
	});

	it("preserves usage data from the message", () => {
		const message: RawMessage = {
			role: "assistant",
			content: "Hello",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 10,
			},
		};

		const converted = convertToComposerMessage(message);

		expect(converted.usage).toEqual({
			input: 100,
			output: 50,
			cacheRead: 10,
		});
	});
});
