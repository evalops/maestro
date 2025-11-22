import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentEvent,
	AssistantMessage,
	ToolResultMessage,
} from "../src/agent/types.js";
import {
	JsonlEventWriter,
	createAgentJsonlAdapter,
	emitUserTurn,
} from "../src/cli/jsonl-writer.js";

class MemoryStream extends Writable {
	chunks: string[] = [];
	_write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.chunks.push(chunk.toString());
		callback();
	}
}

const fixedAssistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "openai-completions",
	provider: "openai",
	model: "gpt-4o-mini",
	usage: {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1_733_000_000_000,
};

const toolResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "write_file",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 1_733_000_000_000,
};

describe("JsonlEventWriter adapter", () => {
	const stream = new MemoryStream();
	const writer = new JsonlEventWriter(true, stream);
	let nextTurnId: () => string;
	let adapter: ReturnType<typeof createAgentJsonlAdapter>;

	beforeEach(() => {
		stream.chunks = [];
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
		let count = 0;
		nextTurnId = () => `turn-${++count}`;
		adapter = createAgentJsonlAdapter(writer, nextTurnId);
	});

	it("emits deltas, completions, tool calls, and tool results", () => {
		const sequence: AgentEvent[] = [
			{ type: "message_start", message: fixedAssistant },
			{
				type: "message_update",
				message: { ...fixedAssistant, content: [{ type: "text", text: "he" }] },
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "he",
					partial: fixedAssistant,
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "write_file",
				args: { path: "a.ts" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "write_file",
				result: toolResult,
				isError: false,
			},
			{ type: "message_end", message: fixedAssistant },
		];

		for (const evt of sequence) {
			adapter.handle(evt);
		}

		expect(stream.chunks.join("")).toMatchSnapshot();
	});

	it("emits user turns via helper", () => {
		emitUserTurn(writer, nextTurnId, "hello");
		expect(stream.chunks.join("")).toMatchSnapshot();
	});
});
