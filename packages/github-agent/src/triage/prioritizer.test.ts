import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../memory/store.js";
import type { AgentStats, GitHubIssue } from "../types.js";
import { IssuePrioritizer } from "./prioritizer.js";

/** Mock type for MemoryStore with only the methods IssuePrioritizer uses */
type MockMemory = {
	hasAttemptedIssue: ReturnType<typeof vi.fn>;
	getStats: ReturnType<typeof vi.fn>;
};

// Mock MemoryStore
const createMockMemory = (
	overrides: Partial<{
		hasAttempted: boolean;
		stats: Partial<AgentStats>;
	}> = {},
): MockMemory => ({
	hasAttemptedIssue: vi.fn().mockReturnValue(overrides.hasAttempted ?? false),
	getStats: vi.fn().mockReturnValue({
		totalTasks: 0,
		completedTasks: 0,
		mergedPRs: overrides.stats?.mergedPRs ?? 0,
		rejectedPRs: 0,
		averageAttemptsToMerge: 0,
		totalTokensUsed: 0,
		totalCost: 0,
		dailyCost: 0,
		dailyCostDate: new Date().toISOString().split("T")[0],
	} satisfies AgentStats),
});

const createIssue = (overrides: Partial<GitHubIssue> = {}): GitHubIssue => ({
	number: 123,
	title: "Test issue",
	body: "Test body",
	labels: [],
	state: "open",
	author: "testuser",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	url: "https://github.com/test/repo/issues/123",
	comments: 0,
	...overrides,
});

describe("IssuePrioritizer", () => {
	describe("triage", () => {
		it("should skip already attempted issues", () => {
			const memory = createMockMemory({ hasAttempted: true });
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue();

			const result = prioritizer.triage(issue);

			expect(result.shouldProcess).toBe(false);
			expect(result.reason).toBe("Already attempted");
		});

		it("should process new issues with target labels", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({ labels: ["composer-task"] });

			const result = prioritizer.triage(issue);

			expect(result.shouldProcess).toBe(true);
		});

		it("should give higher priority to bugs", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);

			const bugIssue = createIssue({ labels: ["bug"] });
			const featureIssue = createIssue({ labels: ["feature"] });

			const bugResult = prioritizer.triage(bugIssue);
			const featureResult = prioritizer.triage(featureIssue);

			expect(bugResult.priority).toBeGreaterThan(featureResult.priority);
		});

		it("should give highest priority to security issues", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);

			const securityIssue = createIssue({ labels: ["security"] });
			const bugIssue = createIssue({ labels: ["bug"] });

			const securityResult = prioritizer.triage(securityIssue);
			const bugResult = prioritizer.triage(bugIssue);

			expect(securityResult.priority).toBeGreaterThan(bugResult.priority);
		});

		it("should detect low complexity from keywords", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({
				title: "Fix typo in documentation",
				body: "Simple typo fix",
			});

			const result = prioritizer.triage(issue);

			expect(result.complexity).toBe("low");
		});

		it("should detect high complexity from keywords", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({
				title: "Refactor authentication architecture",
				body: "This requires a major redesign of the security layer",
			});

			const result = prioritizer.triage(issue);

			expect(result.complexity).toBe("high");
		});

		it("should skip high complexity issues when agent has low experience", () => {
			const memory = createMockMemory({ stats: { mergedPRs: 2 } });
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({
				title: "Refactor the entire architecture",
				body: "Major redesign needed",
			});

			const result = prioritizer.triage(issue);

			expect(result.shouldProcess).toBe(false);
			expect(result.reason).toContain("Too complex");
		});

		it("should allow high complexity issues when agent is experienced", () => {
			const memory = createMockMemory({ stats: { mergedPRs: 10 } });
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({
				title: "Refactor the architecture",
				body: "Major redesign",
			});

			const result = prioritizer.triage(issue);

			expect(result.shouldProcess).toBe(true);
		});

		it("should give age bonus to older issues", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);

			const newIssue = createIssue({ createdAt: new Date().toISOString() });
			const oldDate = new Date();
			oldDate.setDate(oldDate.getDate() - 20);
			const oldIssue = createIssue({ createdAt: oldDate.toISOString() });

			const newResult = prioritizer.triage(newIssue);
			const oldResult = prioritizer.triage(oldIssue);

			expect(oldResult.priority).toBeGreaterThan(newResult.priority);
		});

		it("should use body length as complexity heuristic", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);

			const shortIssue = createIssue({ body: "Short body" });
			const longIssue = createIssue({ body: "x".repeat(1500) });

			const shortResult = prioritizer.triage(shortIssue);
			const longResult = prioritizer.triage(longIssue);

			expect(shortResult.complexity).toBe("low");
			expect(longResult.complexity).toBe("high");
		});

		it("should match labels case-insensitively with partial match", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);

			const issue1 = createIssue({ labels: ["BUG-critical"] });
			const issue2 = createIssue({ labels: ["type:bug"] });

			const result1 = prioritizer.triage(issue1);
			const result2 = prioritizer.triage(issue2);

			// Both should get bug priority boost
			expect(result1.priority).toBeGreaterThanOrEqual(80);
			expect(result2.priority).toBeGreaterThanOrEqual(80);
		});
	});

	describe("createTask", () => {
		it("should create a task from triaged issue", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({ number: 42, title: "Test task" });
			const triage = {
				shouldProcess: true,
				priority: 60,
				reason: "test",
				complexity: "medium" as const,
			};

			const task = prioritizer.createTask(issue, triage);

			expect(task.id).toMatch(/^issue-42-/);
			expect(task.type).toBe("issue");
			expect(task.sourceIssue).toBe(42);
			expect(task.title).toBe("Test task");
			expect(task.priority).toBe(60);
			expect(task.status).toBe("pending");
			expect(task.attempts).toBe(0);
		});

		it("should format description with issue details", () => {
			const memory = createMockMemory();
			const prioritizer = new IssuePrioritizer(
				memory as unknown as MemoryStore,
			);
			const issue = createIssue({
				number: 42,
				title: "Test task",
				body: "Task description here",
				labels: ["bug", "urgent"],
				author: "developer",
				url: "https://github.com/test/repo/issues/42",
			});
			const triage = {
				shouldProcess: true,
				priority: 60,
				reason: "test",
				complexity: "medium" as const,
			};

			const task = prioritizer.createTask(issue, triage);

			expect(task.description).toContain("Issue #42");
			expect(task.description).toContain("Test task");
			expect(task.description).toContain(
				"https://github.com/test/repo/issues/42",
			);
			expect(task.description).toContain("bug, urgent");
			expect(task.description).toContain("developer");
			expect(task.description).toContain("Task description here");
		});
	});
});
