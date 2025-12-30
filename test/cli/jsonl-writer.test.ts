import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../src/agent/types.js";
import {
	JsonlEventWriter,
	createAgentJsonlAdapter,
} from "../../src/cli/jsonl-writer.js";

describe("jsonl writer", () => {
	it("includes assistant usage metadata on message_complete", () => {
		let output = "";
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		});

		const writer = new JsonlEventWriter(true, stream);
		const adapter = createAgentJsonlAdapter(writer, () => "turn-1");
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				cost: {
					input: 0.01,
					output: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.03,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as AssistantMessage;

		adapter.handle({ type: "message_end", message: assistantMessage });

		const events = output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const messageComplete = events.find(
			(event) => event.type === "item" && event.subtype === "message_complete",
		);
		expect(messageComplete).toBeTruthy();
		expect(messageComplete.data).toMatchObject({
			text: "Hello",
			usage: assistantMessage.usage,
			stopReason: "stop",
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			api: "anthropic-messages",
		});
	});
});
