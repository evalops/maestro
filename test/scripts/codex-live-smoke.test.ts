import { describe, expect, it } from "vitest";
import {
	assertBoundedDynamicToolUse,
	getFinalAssistantText,
	parseJsonlEvents,
	summarizeDynamicToolCalls,
} from "../../scripts/smoke-codex-app-server-live.mjs";

function jsonl(events: unknown[]): string {
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const token = "visible non secret smoke token";

function successfulEvents() {
	return [
		{
			type: "item",
			subtype: "tool_call",
			data: {
				toolCallId: "call-read-1",
				toolName: "read",
				args: { path: "/tmp/token.txt" },
			},
		},
		{
			type: "item",
			subtype: "tool_result",
			data: {
				toolCallId: "call-read-1",
				toolName: "read",
				isError: false,
			},
		},
		{
			type: "item",
			subtype: "message_complete",
			data: { text: token },
		},
	];
}

describe("Codex live smoke evidence helpers", () => {
	it("parses JSONL events and extracts the final assistant text", () => {
		const events = parseJsonlEvents(jsonl(successfulEvents()));

		expect(events).toHaveLength(3);
		expect(getFinalAssistantText(events)).toBe(token);
	});

	it("fails fast on malformed JSONL smoke output", () => {
		expect(() =>
			parseJsonlEvents(`${JSON.stringify(successfulEvents()[0])}\nnot-json\n`),
		).toThrow("non-JSON output");
	});

	it("summarizes dynamic tool call cardinality by stable arguments", () => {
		const events = parseJsonlEvents(
			jsonl([
				...successfulEvents(),
				{
					type: "item",
					subtype: "tool_call",
					data: {
						toolCallId: "call-read-2",
						toolName: "read",
						args: { path: "/tmp/token.txt" },
					},
				},
			]),
		);

		expect(summarizeDynamicToolCalls(events)).toMatchObject({
			totalCalls: 2,
			uniqueCalls: 1,
			maxIdenticalCalls: 2,
		});
	});

	it("summarizes Codex dynamic callbacks by operation args, not volatile IDs", () => {
		const events = parseJsonlEvents(
			jsonl([
				{
					type: "item",
					subtype: "tool_call",
					data: {
						toolCallId: "call-read-1",
						toolName: "read",
						args: {
							codexTool: "read",
							threadId: "thread-1",
							turnId: "turn-1",
							callId: "call-read-1",
							arguments: { path: "/tmp/token.txt" },
						},
					},
				},
				{
					type: "item",
					subtype: "tool_call",
					data: {
						toolCallId: "call-read-2",
						toolName: "read",
						args: {
							codexTool: "read",
							threadId: "thread-1",
							turnId: "turn-1",
							callId: "call-read-2",
							arguments: { path: "/tmp/token.txt" },
						},
					},
				},
			]),
		);

		expect(summarizeDynamicToolCalls(events)).toMatchObject({
			totalCalls: 2,
			uniqueCalls: 1,
			maxIdenticalCalls: 2,
		});
	});

	it("accepts a bounded dynamic read-tool smoke transcript", () => {
		expect(
			assertBoundedDynamicToolUse({
				stdout: jsonl(successfulEvents()),
				expectedToken: token,
				maxTotalToolCalls: 2,
				maxIdenticalToolCalls: 1,
			}),
		).toMatchObject({
			totalCalls: 1,
			uniqueCalls: 1,
			maxIdenticalCalls: 1,
		});
	});

	it("rejects live transcripts with loop-detector warnings", () => {
		expect(() =>
			assertBoundedDynamicToolUse({
				stdout: jsonl(successfulEvents()),
				stderr: "Exact repetition loop detected",
				expectedToken: token,
			}),
		).toThrow("loop warning");
	});

	it("rejects repeated identical dynamic tool calls", () => {
		expect(() =>
			assertBoundedDynamicToolUse({
				stdout: jsonl([
					...successfulEvents(),
					{
						type: "item",
						subtype: "tool_call",
						data: {
							toolCallId: "call-read-2",
							toolName: "read",
							args: { path: "/tmp/token.txt" },
						},
					},
				]),
				expectedToken: token,
				maxIdenticalToolCalls: 1,
			}),
		).toThrow("repeated an identical dynamic tool call 2 times");
	});

	it("requires the final assistant message to exactly match the token", () => {
		expect(() =>
			assertBoundedDynamicToolUse({
				stdout: jsonl([
					...successfulEvents().slice(0, 2),
					{
						type: "item",
						subtype: "message_complete",
						data: { text: `${token}\nextra` },
					},
				]),
				expectedToken: token,
			}),
		).toThrow("did not exactly match expected token");
	});
});
