import { beforeEach, describe, expect, it } from "vitest";
import {
	ContextHandoffManager,
	type ContextUsage,
	DEFAULT_THRESHOLDS,
	createContextHandoffManager,
	estimateTokenCount,
	formatContextUsage,
} from "../../src/agent/context-handoff.js";

describe("agent/context-handoff", () => {
	describe("ContextHandoffManager", () => {
		let manager: ContextHandoffManager;

		beforeEach(() => {
			manager = new ContextHandoffManager();
		});

		describe("checkUsage", () => {
			it("returns ok status when usage is low", () => {
				const usage = manager.checkUsage(10000, 100000);
				expect(usage.status).toBe("ok");
				expect(usage.usagePercent).toBe(0.1);
			});

			it("returns warning status at warning threshold", () => {
				const usage = manager.checkUsage(75000, 100000);
				expect(usage.status).toBe("warning");
			});

			it("returns suggest_handoff status at handoff threshold", () => {
				const usage = manager.checkUsage(88000, 100000);
				expect(usage.status).toBe("suggest_handoff");
			});

			it("returns force_handoff status at force threshold", () => {
				const usage = manager.checkUsage(96000, 100000);
				expect(usage.status).toBe("force_handoff");
			});

			it("calculates tokens remaining correctly", () => {
				const usage = manager.checkUsage(30000, 100000);
				expect(usage.tokensRemaining).toBe(70000);
			});
		});

		describe("file tracking", () => {
			it("records file modifications", () => {
				manager.recordFileModification("/path/to/file1.ts");
				manager.recordFileModification("/path/to/file2.ts");
				manager.recordFileModification("/path/to/file1.ts"); // Duplicate

				const context = manager.generateHandoffContext("Test summary");
				expect(context.modifiedFiles).toHaveLength(2);
				expect(context.modifiedFiles).toContain("/path/to/file1.ts");
			});

			it("records file references", () => {
				manager.recordFileReference("/path/to/ref1.ts");
				manager.recordFileReference("/path/to/ref2.ts");

				const context = manager.generateHandoffContext("Test summary");
				expect(context.referencedFiles).toHaveLength(2);
			});
		});

		describe("task tracking", () => {
			it("tracks current task", () => {
				manager.setCurrentTask("Implement feature X");
				const context = manager.generateHandoffContext("Summary");
				expect(context.currentTask).toBe("Implement feature X");
			});

			it("handles null task", () => {
				manager.setCurrentTask(null);
				const context = manager.generateHandoffContext("Summary");
				expect(context.currentTask).toBeNull();
			});
		});

		describe("pending work", () => {
			it("adds pending work items", () => {
				manager.addPendingWork("Item 1");
				manager.addPendingWork("Item 2");
				manager.addPendingWork("Item 1"); // Duplicate

				const context = manager.generateHandoffContext("Summary");
				expect(context.pendingWork).toHaveLength(2);
			});

			it("completes pending work items", () => {
				manager.addPendingWork("Item 1");
				manager.addPendingWork("Item 2");
				manager.completePendingWork("Item 1");

				const context = manager.generateHandoffContext("Summary");
				expect(context.pendingWork).toHaveLength(1);
				expect(context.pendingWork).toContain("Item 2");
			});
		});

		describe("important context", () => {
			it("adds important context items", () => {
				manager.addImportantContext("Context 1");
				manager.addImportantContext("Context 2");

				const context = manager.generateHandoffContext("Summary");
				expect(context.importantContext).toHaveLength(2);
			});

			it("clears important context", () => {
				manager.addImportantContext("Context 1");
				manager.clearImportantContext();

				const context = manager.generateHandoffContext("Summary");
				expect(context.importantContext).toHaveLength(0);
			});
		});

		describe("generateHandoffContext", () => {
			it("generates complete handoff context", () => {
				manager.setCurrentTask("Test task");
				manager.recordFileModification("/file1.ts");
				manager.recordFileReference("/file2.ts");
				manager.addPendingWork("Todo 1");
				manager.addImportantContext("Important 1");

				const context = manager.generateHandoffContext(
					"Summary of work",
					"session-123",
				);

				expect(context.summary).toBe("Summary of work");
				expect(context.currentTask).toBe("Test task");
				expect(context.modifiedFiles).toContain("/file1.ts");
				expect(context.referencedFiles).toContain("/file2.ts");
				expect(context.pendingWork).toContain("Todo 1");
				expect(context.importantContext).toContain("Important 1");
				expect(context.previousSessionId).toBe("session-123");
				expect(context.timestamp).toBeInstanceOf(Date);
			});
		});

		describe("formatHandoffPrompt", () => {
			it("formats a complete handoff prompt", () => {
				manager.setCurrentTask("Test task");
				manager.recordFileModification("/file1.ts");
				manager.addPendingWork("Todo 1");

				const context = manager.generateHandoffContext("Summary of work");
				const prompt = manager.formatHandoffPrompt(context);

				expect(prompt).toContain("# Context Handoff");
				expect(prompt).toContain("Summary of work");
				expect(prompt).toContain("## Current Task");
				expect(prompt).toContain("Test task");
				expect(prompt).toContain("## Modified Files");
				expect(prompt).toContain("/file1.ts");
				expect(prompt).toContain("## Pending Work");
				expect(prompt).toContain("[ ] Todo 1");
			});

			it("handles empty sections gracefully", () => {
				const context = manager.generateHandoffContext("Just a summary");
				const prompt = manager.formatHandoffPrompt(context);

				expect(prompt).toContain("# Context Handoff");
				expect(prompt).toContain("Just a summary");
				expect(prompt).not.toContain("## Current Task");
				expect(prompt).not.toContain("## Modified Files");
			});

			it("truncates long file lists", () => {
				for (let i = 0; i < 30; i++) {
					manager.recordFileModification(`/file${i}.ts`);
				}

				const context = manager.generateHandoffContext("Summary");
				const prompt = manager.formatHandoffPrompt(context);

				expect(prompt).toContain("... and 10 more");
			});
		});

		describe("getStatusMessage", () => {
			it("returns null for ok status", () => {
				const usage: ContextUsage = {
					currentTokens: 10000,
					maxTokens: 100000,
					usagePercent: 0.1,
					status: "ok",
					tokensRemaining: 90000,
				};
				expect(manager.getStatusMessage(usage)).toBeNull();
			});

			it("returns warning message for warning status", () => {
				const usage: ContextUsage = {
					currentTokens: 75000,
					maxTokens: 100000,
					usagePercent: 0.75,
					status: "warning",
					tokensRemaining: 25000,
				};
				const msg = manager.getStatusMessage(usage);
				expect(msg).toContain("75%");
				expect(msg).toContain("Consider wrapping up");
			});

			it("returns handoff message for suggest_handoff status", () => {
				const usage: ContextUsage = {
					currentTokens: 90000,
					maxTokens: 100000,
					usagePercent: 0.9,
					status: "suggest_handoff",
					tokensRemaining: 10000,
				};
				const msg = manager.getStatusMessage(usage);
				expect(msg).toContain("90%");
				expect(msg).toContain("/handoff");
			});

			it("returns force message for force_handoff status", () => {
				const usage: ContextUsage = {
					currentTokens: 96000,
					maxTokens: 100000,
					usagePercent: 0.96,
					status: "force_handoff",
					tokensRemaining: 4000,
				};
				const msg = manager.getStatusMessage(usage);
				expect(msg).toContain("96%");
				expect(msg).toContain("required");
			});
		});

		describe("reset", () => {
			it("clears all tracking state", () => {
				manager.setCurrentTask("Task");
				manager.recordFileModification("/file.ts");
				manager.addPendingWork("Work");
				manager.addImportantContext("Context");

				manager.reset();

				const context = manager.generateHandoffContext("Summary");
				expect(context.currentTask).toBeNull();
				expect(context.modifiedFiles).toHaveLength(0);
				expect(context.pendingWork).toHaveLength(0);
				expect(context.importantContext).toHaveLength(0);
			});
		});
	});

	describe("createContextHandoffManager", () => {
		it("creates with default thresholds", () => {
			const manager = createContextHandoffManager();
			const usage = manager.checkUsage(75000, 100000);
			expect(usage.status).toBe("warning");
		});

		it("creates with custom thresholds", () => {
			const manager = createContextHandoffManager({
				warnAt: 0.5,
			});
			const usage = manager.checkUsage(55000, 100000);
			expect(usage.status).toBe("warning");
		});
	});

	describe("estimateTokenCount", () => {
		it("estimates tokens from text", () => {
			const text = "Hello, world!"; // 13 chars
			const estimate = estimateTokenCount(text);
			expect(estimate).toBe(4); // ceil(13/4)
		});

		it("handles empty text", () => {
			expect(estimateTokenCount("")).toBe(0);
		});
	});

	describe("formatContextUsage", () => {
		it("formats usage as percentage and remaining", () => {
			const usage: ContextUsage = {
				currentTokens: 50000,
				maxTokens: 100000,
				usagePercent: 0.5,
				status: "ok",
				tokensRemaining: 50000,
			};
			const formatted = formatContextUsage(usage);
			expect(formatted).toBe("50% (50K tokens remaining)");
		});
	});

	describe("DEFAULT_THRESHOLDS", () => {
		it("has expected values", () => {
			expect(DEFAULT_THRESHOLDS.warnAt).toBe(0.7);
			expect(DEFAULT_THRESHOLDS.suggestHandoffAt).toBe(0.85);
			expect(DEFAULT_THRESHOLDS.forceHandoffAt).toBe(0.95);
		});
	});
});
