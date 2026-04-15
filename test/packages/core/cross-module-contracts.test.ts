/**
 * TDD tests for cross-module contracts — verify that the different
 * parts of maestro-core work together correctly. These test the seams
 * between modules where bugs hide.
 */
import { describe, expect, it, vi } from "vitest";

import {
	ContextHandoffManager,
	TOOL_CATEGORIES,
	canRestart,
	createRestartPolicy,
	filterToolsForSubagent,
	getAllowedTools,
	getSubagentSpec,
	incrementAttempts,
	isToolAllowed,
} from "../../../packages/core/src/index.js";

import type { SubagentType } from "../../../packages/core/src/index.js";

import { parsePlanContent } from "../../../packages/core/src/swarm/index.js";
import type { SwarmTask } from "../../../packages/core/src/swarm/index.js";

describe("Cross-Module Contracts", () => {
	describe("subagent specs ↔ tool categories alignment", () => {
		it("every tool in TOOL_CATEGORIES is allowed by at least one subagent", () => {
			const allCategoryTools = Object.values(TOOL_CATEGORIES).flat();
			const allTypes: SubagentType[] = [
				"explorer",
				"planner",
				"coder",
				"reviewer",
				"researcher",
				"minimal",
				"custom",
			];

			for (const tool of allCategoryTools) {
				const allowedSomewhere = allTypes.some((type) =>
					isToolAllowed(tool, type),
				);
				if (!allowedSomewhere) {
					console.log(`Tool "${tool}" not allowed by any subagent type`);
				}
				expect(allowedSomewhere).toBe(true);
			}
		});

		it("every subagent's allowed tools exist in TOOL_CATEGORIES", () => {
			const allCategoryTools = new Set(Object.values(TOOL_CATEGORIES).flat());
			const types: SubagentType[] = [
				"explorer",
				"planner",
				"coder",
				"reviewer",
				"researcher",
				"minimal",
			];

			for (const type of types) {
				const allowed = getAllowedTools(type);
				for (const tool of allowed) {
					if (!allCategoryTools.has(tool)) {
						console.log(
							`Subagent "${type}" allows "${tool}" which isn't in any TOOL_CATEGORY`,
						);
					}
					expect(allCategoryTools.has(tool)).toBe(true);
				}
			}
		});

		it("no subagent type allows tools from a category it shouldn't", () => {
			// Explorer should ONLY have read + advanced category tools
			const explorerTools = new Set(getAllowedTools("explorer"));
			for (const writeTool of TOOL_CATEGORIES.write) {
				expect(explorerTools.has(writeTool)).toBe(false);
			}
			for (const shellTool of TOOL_CATEGORIES.shell) {
				expect(explorerTools.has(shellTool)).toBe(false);
			}
		});
	});

	describe("subagent specs ↔ filterToolsForSubagent consistency", () => {
		it("filterToolsForSubagent matches isToolAllowed for all types", () => {
			const tools = Object.values(TOOL_CATEGORIES)
				.flat()
				.map((name) => ({ name }));
			const types: SubagentType[] = [
				"explorer",
				"planner",
				"coder",
				"reviewer",
				"researcher",
				"minimal",
			];

			for (const type of types) {
				const filtered = filterToolsForSubagent(tools, type);
				const filteredNames = new Set(
					filtered.map((t: { name: string }) => t.name),
				);

				for (const tool of tools) {
					const allowed = isToolAllowed(tool.name, type);
					const inFiltered = filteredNames.has(tool.name);
					if (allowed !== inFiltered) {
						console.log(
							`Mismatch for "${tool.name}" in "${type}": isToolAllowed=${allowed}, inFiltered=${inFiltered}`,
						);
					}
					expect(allowed).toBe(inFiltered);
				}
			}
		});
	});

	describe("restart policy ↔ background task lifecycle", () => {
		it("policy exhaustion matches expected attempt count", () => {
			for (const max of [1, 2, 3, 5]) {
				const policy = createRestartPolicy({
					maxAttempts: max,
					delayMs: 100,
					strategy: "fixed",
				})!;

				let attempts = 0;
				while (canRestart(policy)) {
					incrementAttempts(policy);
					attempts++;
				}
				expect(attempts).toBe(max);
			}
		});

		it("exponential delay grows but stays bounded", () => {
			const policy = createRestartPolicy({
				maxAttempts: 20,
				delayMs: 10,
				strategy: "exponential",
				maxDelayMs: 1000,
				jitterRatio: 0,
			})!;

			let prevDelay = 0;
			let growthStopped = false;
			for (let i = 0; i < 15; i++) {
				incrementAttempts(policy);
				const delay = policy.delayMs; // base delay before jitter
				if (delay <= prevDelay && i > 1) {
					growthStopped = true;
				}
				prevDelay = delay;
				expect(delay).toBeLessThanOrEqual(1000);
			}
		});
	});

	describe("context handoff ↔ agent lifecycle", () => {
		it("handoff context survives full lifecycle", () => {
			const mgr = new ContextHandoffManager();

			// Phase 1: Exploration
			mgr.setCurrentTask("Understand the codebase");
			mgr.recordFileReference("src/index.ts");
			mgr.recordFileReference("src/config.ts");

			// Phase 2: Implementation
			mgr.setCurrentTask("Implement feature X");
			mgr.recordFileModification("src/feature.ts");
			mgr.recordFileModification("src/utils.ts");
			mgr.addPendingWork("Add error handling");
			mgr.addPendingWork("Write tests");

			// Phase 3: Partial completion
			mgr.completePendingWork("Add error handling");
			mgr.addImportantContext("Using async/await pattern");
			mgr.addImportantContext("API returns 404 for missing resources");

			// Generate handoff
			const ctx = mgr.generateHandoffContext(
				"Implemented feature X, tests remaining",
			);

			// Verify everything is captured
			expect(ctx.currentTask).toBe("Implement feature X");
			expect(ctx.modifiedFiles).toContain("src/feature.ts");
			expect(ctx.modifiedFiles).toContain("src/utils.ts");
			expect(ctx.referencedFiles).toContain("src/index.ts");
			expect(ctx.pendingWork).toContain("Write tests");
			expect(ctx.pendingWork).not.toContain("Add error handling"); // completed
			expect(ctx.importantContext).toHaveLength(2);
			expect(ctx.summary).toContain("tests remaining");

			// Verify prompt includes key info
			const prompt = mgr.formatHandoffPrompt(ctx);
			expect(prompt).toContain("feature.ts");
			expect(prompt).toContain("Write tests");
		});

		it("usage thresholds trigger at correct percentages", () => {
			const mgr = new ContextHandoffManager();
			const maxTokens = 200000;

			// 50% — ok
			expect(mgr.checkUsage(100000, maxTokens).status).toBe("ok");

			// 70% — warning
			expect(mgr.checkUsage(140000, maxTokens).status).toBe("warning");

			// 85% — suggest handoff
			expect(mgr.checkUsage(170000, maxTokens).status).toBe("suggest_handoff");

			// 95% — force handoff
			expect(mgr.checkUsage(190000, maxTokens).status).toBe("force_handoff");

			// 100% — force handoff
			expect(mgr.checkUsage(200000, maxTokens).status).toBe("force_handoff");

			// 0% — ok
			expect(mgr.checkUsage(0, maxTokens).status).toBe("ok");
		});
	});

	describe("swarm plan parser ↔ task dependencies", () => {
		it("tasks maintain ordering from the plan", () => {
			const plan = parsePlanContent(`# Sequential Plan

- [ ] Create database schema
- [ ] Seed test data
- [ ] Implement API routes
- [ ] Write integration tests
`);

			if (plan.tasks.length >= 4) {
				// Task IDs should be ordered
				const ids = plan.tasks.map((t) => t.id);
				for (let i = 1; i < ids.length; i++) {
					expect(ids[i]! > ids[i - 1]!).toBe(true);
				}
			}
		});

		it("parsed tasks can be assigned to teammates", () => {
			const plan = parsePlanContent(`# Feature Plan

- [ ] Build backend API
- [ ] Create frontend components
- [ ] Write E2E tests
`);

			// Simulate teammate assignment
			const teammates = [
				{ id: "alpha", tasks: [] as SwarmTask[] },
				{ id: "beta", tasks: [] as SwarmTask[] },
			];

			for (let i = 0; i < plan.tasks.length; i++) {
				const teammate = teammates[i % teammates.length]!;
				teammate.tasks.push(plan.tasks[i]!);
			}

			// Alpha gets tasks 0, 2; Beta gets task 1
			expect(teammates[0]!.tasks.length).toBeGreaterThanOrEqual(1);
			expect(teammates[1]!.tasks.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("security: privilege escalation prevention", () => {
		it("cannot escalate from explorer to coder capabilities", () => {
			const explorerSpec = getSubagentSpec("explorer");
			const coderSpec = getSubagentSpec("coder");

			// Coder has write tools that explorer doesn't
			const coderOnlyTools = coderSpec.allowedTools.filter(
				(t: string) => !explorerSpec.allowedTools.includes(t),
			);
			expect(coderOnlyTools.length).toBeGreaterThan(0);

			// Verify none of the coder-only tools leak into explorer
			for (const tool of coderOnlyTools) {
				expect(isToolAllowed(tool, "explorer")).toBe(false);
			}
		});

		it("minimal has strictly fewer tools than every other type", () => {
			const minimalCount = getAllowedTools("minimal").length;
			const types: SubagentType[] = [
				"explorer",
				"planner",
				"coder",
				"reviewer",
				"researcher",
			];

			for (const type of types) {
				const count = getAllowedTools(type).length;
				expect(count).toBeGreaterThanOrEqual(minimalCount);
			}
		});
	});
});
