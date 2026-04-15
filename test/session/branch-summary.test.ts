import { describe, expect, it } from "vitest";
import {
	buildBranchSummaryMessages,
	collectEntriesForBranchSummary,
} from "../../src/session/branch-summary.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomMessageEntry,
	ModelChangeEntry,
	SessionMessageEntry,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../../src/session/types.js";

// Helper to create a mock session manager
function createMockSession(entries: SessionTreeEntry[]) {
	const byId = new Map<string, SessionTreeEntry>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}

	return {
		getEntry(id: string): SessionTreeEntry | undefined {
			return byId.get(id);
		},
		getBranch(leafId: string): SessionTreeEntry[] {
			const branch: SessionTreeEntry[] = [];
			let current: string | null = leafId;
			while (current) {
				const entry = byId.get(current);
				if (!entry) break;
				branch.push(entry);
				current = entry.parentId;
			}
			return branch.reverse();
		},
	};
}

// Helper to create message entries
function createMessageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	content: string,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: "text", text: content }],
		},
	};
}

function createToolResultEntry(
	id: string,
	parentId: string | null,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			tool_use_id: "tool-1",
			content: "result",
		},
	};
}

function createCustomMessageEntry(
	id: string,
	parentId: string | null,
	customType: string,
	content: string,
): CustomMessageEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		customType,
		content,
		display: true,
	};
}

function createBranchSummaryEntry(
	id: string,
	parentId: string | null,
	fromId: string,
	summary: string,
): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		fromId,
		summary,
	};
}

function createCompactionEntry(
	id: string,
	parentId: string | null,
	summary: string,
	tokensBefore: number,
): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		tokensBefore,
		firstKeptEntryId: id,
	};
}

function createThinkingLevelChangeEntry(
	id: string,
	parentId: string | null,
	thinkingLevel: string,
): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
}

function createModelChangeEntry(
	id: string,
	parentId: string | null,
	model: string,
): ModelChangeEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		model,
	};
}

describe("branch-summary", () => {
	describe("collectEntriesForBranchSummary", () => {
		it("returns empty plan when oldLeafId is null", () => {
			const session = createMockSession([]);
			const result = collectEntriesForBranchSummary(session, null, "target");
			expect(result.entries).toEqual([]);
			expect(result.commonAncestorId).toBeNull();
		});

		it("collects entries from diverged branch", () => {
			// Tree structure:
			//   A -> B -> C (old branch, oldLeafId = C)
			//        \-> D -> E (target branch, targetId = E)
			// Common ancestor: B
			// Should collect: C (entries between old leaf and common ancestor)
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Hello"),
				createMessageEntry("B", "A", "assistant", "Hi"),
				createMessageEntry("C", "B", "user", "Old branch"),
				createMessageEntry("D", "B", "assistant", "New branch"),
				createMessageEntry("E", "D", "user", "Target"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "C", "E");

			expect(result.commonAncestorId).toBe("B");
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.id).toBe("C");
		});

		it("collects multiple entries from diverged branch", () => {
			// Tree:
			//   A -> B -> C -> D -> E (old branch)
			//        \-> F -> G (target branch)
			// Common ancestor: B
			// Should collect: C, D, E
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Start"),
				createMessageEntry("B", "A", "assistant", "Common"),
				createMessageEntry("C", "B", "user", "Old 1"),
				createMessageEntry("D", "C", "assistant", "Old 2"),
				createMessageEntry("E", "D", "user", "Old leaf"),
				createMessageEntry("F", "B", "assistant", "New 1"),
				createMessageEntry("G", "F", "user", "Target"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "E", "G");

			expect(result.commonAncestorId).toBe("B");
			expect(result.entries).toHaveLength(3);
			expect(result.entries.map((e) => e.id)).toEqual(["C", "D", "E"]);
		});

		it("handles branch at root (no common ancestor except root)", () => {
			// Tree:
			//   A -> B -> C (old branch)
			//   \-> D -> E (target branch)
			// Common ancestor: A
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Root"),
				createMessageEntry("B", "A", "assistant", "Old 1"),
				createMessageEntry("C", "B", "user", "Old leaf"),
				createMessageEntry("D", "A", "assistant", "New 1"),
				createMessageEntry("E", "D", "user", "Target"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "C", "E");

			expect(result.commonAncestorId).toBe("A");
			expect(result.entries).toHaveLength(2);
			expect(result.entries.map((e) => e.id)).toEqual(["B", "C"]);
		});

		it("handles navigating back within same branch (target is ancestor)", () => {
			// Tree: A -> B -> C -> D (old leaf = D, target = B)
			// Common ancestor: B
			// Should collect: C, D
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Start"),
				createMessageEntry("B", "A", "assistant", "Target"),
				createMessageEntry("C", "B", "user", "Middle"),
				createMessageEntry("D", "C", "assistant", "Old leaf"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "D", "B");

			expect(result.commonAncestorId).toBe("B");
			expect(result.entries).toHaveLength(2);
			expect(result.entries.map((e) => e.id)).toEqual(["C", "D"]);
		});

		it("returns empty entries when old leaf equals target", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Start"),
				createMessageEntry("B", "A", "assistant", "Same"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "B", "B");

			expect(result.commonAncestorId).toBe("B");
			expect(result.entries).toHaveLength(0);
		});

		it("handles no common ancestor (disjoint trees - defensive)", () => {
			// This is an edge case that shouldn't happen in practice
			// Old branch: A -> B
			// Target branch: X -> Y (no connection)
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Old root"),
				createMessageEntry("B", "A", "assistant", "Old leaf"),
				createMessageEntry("X", null, "user", "New root"),
				createMessageEntry("Y", "X", "assistant", "Target"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "B", "Y");

			expect(result.commonAncestorId).toBeNull();
			expect(result.entries).toHaveLength(2);
			expect(result.entries.map((e) => e.id)).toEqual(["A", "B"]);
		});

		it("handles missing entry gracefully", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Root"),
				createMessageEntry("B", "A", "assistant", "Node"),
				// Entry "C" is referenced but missing
				createMessageEntry("D", "C", "user", "Orphan"),
			];
			const session = createMockSession(entries);

			// Old leaf references missing parent
			const result = collectEntriesForBranchSummary(session, "D", "B");

			// Should stop at missing entry
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.id).toBe("D");
		});

		it("preserves order of entries (oldest to newest)", () => {
			// Tree: A -> B -> C -> D (old leaf)
			//       \-> E (target)
			const entries: SessionTreeEntry[] = [
				createMessageEntry("A", null, "user", "Root"),
				createMessageEntry("B", "A", "assistant", "B"),
				createMessageEntry("C", "B", "user", "C"),
				createMessageEntry("D", "C", "assistant", "D"),
				createMessageEntry("E", "A", "user", "Target"),
			];
			const session = createMockSession(entries);

			const result = collectEntriesForBranchSummary(session, "D", "E");

			expect(result.commonAncestorId).toBe("A");
			// Should be in chronological order (oldest first)
			expect(result.entries.map((e) => e.id)).toEqual(["B", "C", "D"]);
		});
	});

	describe("buildBranchSummaryMessages", () => {
		it("converts message entries to AppMessages", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("1", null, "user", "Hello"),
				createMessageEntry("2", "1", "assistant", "Hi there"),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(2);
			expect(messages[0]?.role).toBe("user");
			expect(messages[1]?.role).toBe("assistant");
		});

		it("filters out toolResult messages", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("1", null, "user", "Run tool"),
				createToolResultEntry("2", "1"),
				createMessageEntry("3", "2", "assistant", "Done"),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(2);
			expect(messages[0]?.role).toBe("user");
			expect(messages[1]?.role).toBe("assistant");
		});

		it("converts custom_message entries to AppMessages", () => {
			const entries: SessionTreeEntry[] = [
				createCustomMessageEntry("1", null, "hook.test", "Hook content"),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("hookMessage");
		});

		it("converts branch_summary entries to AppMessages", () => {
			const entries: SessionTreeEntry[] = [
				createBranchSummaryEntry("1", null, "old-id", "Branch summary text"),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("branchSummary");
		});

		it("converts compaction entries to AppMessages", () => {
			const entries: SessionTreeEntry[] = [
				createCompactionEntry("1", null, "Compaction summary", 50000),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("compactionSummary");
		});

		it("filters out thinking_level_change entries", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("1", null, "user", "Hello"),
				createThinkingLevelChangeEntry("2", "1", "high"),
				createMessageEntry("3", "2", "assistant", "Response"),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(2);
		});

		it("filters out model_change entries", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("1", null, "user", "Hello"),
				createModelChangeEntry("2", "1", "claude-3-opus"),
				createMessageEntry("3", "2", "assistant", "Response"),
			];

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(2);
		});

		it("respects maxMessages limit", () => {
			const entries: SessionTreeEntry[] = [];
			for (let i = 0; i < 50; i++) {
				entries.push(
					createMessageEntry(
						`${i}`,
						i > 0 ? `${i - 1}` : null,
						i % 2 === 0 ? "user" : "assistant",
						`Message ${i}`,
					),
				);
			}

			const messages = buildBranchSummaryMessages(entries, 10);

			expect(messages).toHaveLength(10);
			// Should keep the most recent messages (last 10)
			expect(messages[0]?.role).toBe("user"); // Message 40
			expect(messages[9]?.role).toBe("assistant"); // Message 49
		});

		it("returns all messages when under maxMessages limit", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("1", null, "user", "Hello"),
				createMessageEntry("2", "1", "assistant", "Hi"),
			];

			const messages = buildBranchSummaryMessages(entries, 10);

			expect(messages).toHaveLength(2);
		});

		it("returns all messages when maxMessages is 0 (no limit)", () => {
			const entries: SessionTreeEntry[] = [];
			for (let i = 0; i < 50; i++) {
				entries.push(
					createMessageEntry(
						`${i}`,
						i > 0 ? `${i - 1}` : null,
						i % 2 === 0 ? "user" : "assistant",
						`Message ${i}`,
					),
				);
			}

			const messages = buildBranchSummaryMessages(entries, 0);

			expect(messages).toHaveLength(50);
		});

		it("uses default maxMessages of 40", () => {
			const entries: SessionTreeEntry[] = [];
			for (let i = 0; i < 50; i++) {
				entries.push(
					createMessageEntry(
						`${i}`,
						i > 0 ? `${i - 1}` : null,
						i % 2 === 0 ? "user" : "assistant",
						`Message ${i}`,
					),
				);
			}

			const messages = buildBranchSummaryMessages(entries);

			expect(messages).toHaveLength(40);
		});

		it("handles empty entries array", () => {
			const messages = buildBranchSummaryMessages([]);
			expect(messages).toEqual([]);
		});

		it("handles mixed entry types correctly", () => {
			const entries: SessionTreeEntry[] = [
				createMessageEntry("1", null, "user", "Start"),
				createThinkingLevelChangeEntry("2", "1", "high"),
				createMessageEntry("3", "2", "assistant", "Response"),
				createModelChangeEntry("4", "3", "opus"),
				createCompactionEntry("5", "4", "Compacted", 10000),
				createBranchSummaryEntry("6", "5", "old", "Summary"),
				createCustomMessageEntry("7", "6", "hook", "Hook msg"),
				createToolResultEntry("8", "7"),
				createMessageEntry("9", "8", "user", "Final"),
			];

			const messages = buildBranchSummaryMessages(entries);

			// Should include: message(1), message(3), compaction(5), branch_summary(6), custom_message(7), message(9)
			// Should exclude: thinking_level_change(2), model_change(4), toolResult(8)
			expect(messages).toHaveLength(6);
		});
	});
});
