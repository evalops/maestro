/**
 * TDD tests for ContextHandoffManager — verify context tracking
 * and handoff generation for session continuity.
 */
import { describe, expect, it } from "vitest";

import { ContextHandoffManager } from "../../../packages/core/src/index.js";

describe("ContextHandoffManager", () => {
	describe("file tracking", () => {
		it("tracks modified files", () => {
			const mgr = new ContextHandoffManager();
			mgr.recordFileModification("src/index.ts");
			mgr.recordFileModification("src/utils.ts");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.modifiedFiles).toContain("src/index.ts");
			expect(ctx.modifiedFiles).toContain("src/utils.ts");
		});

		it("tracks referenced files separately from modified", () => {
			const mgr = new ContextHandoffManager();
			mgr.recordFileModification("src/index.ts");
			mgr.recordFileReference("src/types.ts");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.modifiedFiles).toContain("src/index.ts");
			expect(ctx.modifiedFiles).not.toContain("src/types.ts");
			expect(ctx.referencedFiles).toContain("src/types.ts");
		});

		it("deduplicates file entries", () => {
			const mgr = new ContextHandoffManager();
			mgr.recordFileModification("src/index.ts");
			mgr.recordFileModification("src/index.ts");
			mgr.recordFileModification("src/index.ts");
			const ctx = mgr.generateHandoffContext("test");
			const count = ctx.modifiedFiles.filter(
				(f: string) => f === "src/index.ts",
			).length;
			expect(count).toBe(1);
		});
	});

	describe("task tracking", () => {
		it("tracks current task", () => {
			const mgr = new ContextHandoffManager();
			mgr.setCurrentTask("Implement OAuth");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.currentTask).toBe("Implement OAuth");
		});

		it("current task can be updated", () => {
			const mgr = new ContextHandoffManager();
			mgr.setCurrentTask("Task 1");
			mgr.setCurrentTask("Task 2");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.currentTask).toBe("Task 2");
		});

		it("current task is null by default", () => {
			const mgr = new ContextHandoffManager();
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.currentTask).toBeNull();
		});
	});

	describe("pending work", () => {
		it("tracks pending work items", () => {
			const mgr = new ContextHandoffManager();
			mgr.addPendingWork("Write tests");
			mgr.addPendingWork("Update docs");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.pendingWork).toContain("Write tests");
			expect(ctx.pendingWork).toContain("Update docs");
		});

		it("removes completed work", () => {
			const mgr = new ContextHandoffManager();
			mgr.addPendingWork("Write tests");
			mgr.addPendingWork("Update docs");
			mgr.completePendingWork("Write tests");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.pendingWork).not.toContain("Write tests");
			expect(ctx.pendingWork).toContain("Update docs");
		});
	});

	describe("important context", () => {
		it("tracks important context strings", () => {
			const mgr = new ContextHandoffManager();
			mgr.addImportantContext("User prefers TypeScript");
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.importantContext).toContain("User prefers TypeScript");
		});
	});

	describe("generateHandoffContext", () => {
		it("includes summary", () => {
			const mgr = new ContextHandoffManager();
			const ctx = mgr.generateHandoffContext("Working on feature X");
			expect(ctx.summary).toBe("Working on feature X");
		});

		it("includes timestamp", () => {
			const mgr = new ContextHandoffManager();
			const ctx = mgr.generateHandoffContext("test");
			expect(ctx.timestamp).toBeDefined();
			expect(ctx.timestamp).toBeInstanceOf(Date);
		});

		it("produces complete context with all fields populated", () => {
			const mgr = new ContextHandoffManager();
			mgr.setCurrentTask("Build API");
			mgr.recordFileModification("src/api.ts");
			mgr.recordFileReference("src/types.ts");
			mgr.addPendingWork("Add error handling");
			mgr.addImportantContext("Using Express.js");

			const ctx = mgr.generateHandoffContext("Session summary");
			expect(ctx.summary).toBe("Session summary");
			expect(ctx.currentTask).toBe("Build API");
			expect(ctx.modifiedFiles.length).toBe(1);
			expect(ctx.referencedFiles.length).toBe(1);
			expect(ctx.pendingWork.length).toBe(1);
			expect(ctx.importantContext.length).toBe(1);
		});
	});

	describe("checkUsage", () => {
		it("reports low utilization for small conversations", () => {
			const mgr = new ContextHandoffManager();
			const usage = mgr.checkUsage(1000, 200000);
			expect(usage.usagePercent).toBeLessThan(10);
			expect(usage.status).toBe("ok");
		});

		it("reports warning at 70% utilization", () => {
			const mgr = new ContextHandoffManager();
			const usage = mgr.checkUsage(140000, 200000);
			expect(usage.status).toBe("warning");
		});

		it("suggests handoff at 85% utilization", () => {
			const mgr = new ContextHandoffManager();
			const usage = mgr.checkUsage(170000, 200000);
			expect(usage.status).toBe("suggest_handoff");
		});

		it("forces handoff at 95% utilization", () => {
			const mgr = new ContextHandoffManager();
			const usage = mgr.checkUsage(195000, 200000);
			expect(usage.status).toBe("force_handoff");
		});
	});

	describe("reset", () => {
		it("clears all tracked state", () => {
			const mgr = new ContextHandoffManager();
			mgr.setCurrentTask("task");
			mgr.recordFileModification("file.ts");
			mgr.addPendingWork("work");
			mgr.addImportantContext("context");
			mgr.reset();

			const ctx = mgr.generateHandoffContext("after reset");
			expect(ctx.currentTask).toBeNull();
			expect(ctx.modifiedFiles.length).toBe(0);
			expect(ctx.pendingWork.length).toBe(0);
			expect(ctx.importantContext.length).toBe(0);
		});
	});

	describe("formatHandoffPrompt", () => {
		it("produces a non-empty handoff prompt", () => {
			const mgr = new ContextHandoffManager();
			mgr.setCurrentTask("Build OAuth");
			mgr.recordFileModification("src/auth.ts");
			mgr.addPendingWork("Add refresh tokens");

			const ctx = mgr.generateHandoffContext("Implementing OAuth");
			const prompt = mgr.formatHandoffPrompt(ctx);
			expect(prompt.length).toBeGreaterThan(50);
			expect(prompt).toContain("OAuth");
			expect(prompt).toContain("src/auth.ts");
		});
	});
});
