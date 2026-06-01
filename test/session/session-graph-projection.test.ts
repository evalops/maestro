import { describe, expect, it } from "vitest";
import { buildSessionGraphProjection } from "../../src/session/session-graph-projection.js";
import type { SessionEntry } from "../../src/session/types.js";

function userMessage(text: string, timestamp = Date.now()) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp,
	};
}

function assistantMessage(text: string, timestamp = Date.now()) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop" as const,
		timestamp,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("session graph projection", () => {
	it("materializes the active branch with deterministic turn lineage", () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "thread-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: userMessage("root prompt"),
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: assistantMessage("root response"),
			},
			{
				type: "message",
				id: "stale-user",
				parentId: "assistant-1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: userMessage("stale branch prompt"),
			},
			{
				type: "message",
				id: "active-user",
				parentId: "assistant-1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: userMessage("active branch prompt"),
			},
			{
				type: "message",
				id: "active-assistant",
				parentId: "active-user",
				timestamp: "2026-01-01T00:00:05.000Z",
				message: assistantMessage("active branch response"),
			},
		];

		const projection = buildSessionGraphProjection(entries);

		expect(projection).toMatchObject({
			threadId: "thread-1",
			leafEntryId: "active-assistant",
			branchId: "thread-1:active-assistant",
			activeEntryIds: [
				"user-1",
				"assistant-1",
				"active-user",
				"active-assistant",
			],
		});
		expect(projection.activeEntryIds).not.toContain("stale-user");
		expect(projection.turns.map((turn) => turn.id)).toEqual([
			"user-1",
			"active-user",
		]);
		expect(projection.turns.map((turn) => turn.parentTurnId)).toEqual([
			undefined,
			"user-1",
		]);
		expect(projection.turns[1]).toMatchObject({
			sourceEntryIds: ["active-user", "active-assistant"],
			toolCallIds: [],
		});
	});

	it("records compaction spans while keeping only the replayable active window", () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "thread-compact",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "old-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: userMessage("old prompt"),
			},
			{
				type: "message",
				id: "old-assistant",
				parentId: "old-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: assistantMessage("old response"),
			},
			{
				type: "message",
				id: "kept-user",
				parentId: "old-assistant",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: userMessage("kept prompt"),
			},
			{
				type: "message",
				id: "kept-assistant",
				parentId: "kept-user",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: assistantMessage("kept response"),
			},
			{
				type: "compaction",
				id: "compact-1",
				parentId: "kept-assistant",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: "Compacted earlier work",
				firstKeptEntryId: "kept-user",
				tokensBefore: 1200,
			},
			{
				type: "message",
				id: "new-user",
				parentId: "compact-1",
				timestamp: "2026-01-01T00:00:06.000Z",
				message: userMessage("new prompt"),
			},
		];

		const projection = buildSessionGraphProjection(entries);

		expect(projection.activeEntryIds).toEqual([
			"kept-user",
			"kept-assistant",
			"compact-1",
			"new-user",
		]);
		expect(projection.compactionSpans).toEqual([
			{
				id: "compact-1",
				firstKeptEntryId: "kept-user",
				summary: "Compacted earlier work",
				tokensBefore: 1200,
				sourceEntryIds: ["old-user", "old-assistant"],
			},
		]);
		expect(projection.turns.map((turn) => turn.id)).toEqual([
			"kept-user",
			"new-user",
		]);
		expect(projection.turns[0]?.sourceEntryIds).toEqual([
			"kept-user",
			"kept-assistant",
			"compact-1",
		]);
	});

	it("extracts tool call IDs from assistant calls and tool results per turn", () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "thread-tools",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: userMessage("inspect files"),
			},
			{
				type: "message",
				id: "assistant-tools",
				parentId: "user-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					...assistantMessage("checking"),
					content: [
						{ type: "text" as const, text: "checking" },
						{
							type: "toolCall" as const,
							id: "call-read",
							name: "read",
							arguments: { path: "README.md" },
						},
					],
				},
			},
			{
				type: "message",
				id: "tool-result",
				parentId: "assistant-tools",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as SessionEntry[];

		const projection = buildSessionGraphProjection(entries);

		expect(projection.turns).toHaveLength(1);
		expect(projection.turns[0]).toMatchObject({
			id: "user-1",
			sourceEntryIds: ["user-1", "assistant-tools", "tool-result"],
			toolCallIds: ["call-read"],
		});
	});
});
