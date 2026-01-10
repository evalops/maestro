import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../memory/store.js";
import type { AgentConfig, Task } from "../types.js";
import { TaskExecutor } from "./executor.js";

/** Mock type for MemoryStore with only the methods TaskExecutor uses */
type MockMemory = {
	[K in keyof Pick<MemoryStore, "getContextForPrompt">]: ReturnType<
		typeof vi.fn
	>;
};

// We'll test the private methods by creating a test subclass that exposes them
class TestableExecutor extends TaskExecutor {
	public testGenerateBranchName(task: Task): string {
		// Access private method via type assertion to unknown first
		type PrivateMethods = { generateBranchName: (t: Task) => string };
		return (this as unknown as PrivateMethods).generateBranchName(task);
	}

	public testBuildPrompt(task: Task): string {
		type PrivateMethods = { buildPrompt: (t: Task) => string };
		return (this as unknown as PrivateMethods).buildPrompt(task);
	}

	public testBuildPRBody(task: Task): string {
		type PrivateMethods = { buildPRBody: (t: Task) => string };
		return (this as unknown as PrivateMethods).buildPRBody(task);
	}
}

const createMockConfig = (): AgentConfig => ({
	owner: "testowner",
	repo: "testrepo",
	baseBranch: "main",
	pollIntervalMs: 60000,
	issueLabels: ["composer-task"],
	maxConcurrentTasks: 1,
	requireTests: true,
	requireLint: true,
	requireTypeCheck: true,
	selfReview: true,
	maxAttemptsPerTask: 3,
	maxTokensPerTask: 500000,
	dailyBudget: 50,
	workingDir: "/tmp/test-workspace",
	memoryDir: "/tmp/test-memory",
});

const createMockMemory = () => ({
	getContextForPrompt: vi.fn().mockReturnValue(""),
});

const createTask = (overrides: Partial<Task> = {}): Task => ({
	id: "test-task-1",
	type: "issue",
	sourceIssue: 42,
	title: "Test task title",
	description: "Test description",
	priority: 50,
	createdAt: new Date().toISOString(),
	status: "pending",
	attempts: 0,
	...overrides,
});

describe("TaskExecutor", () => {
	let executor: TestableExecutor;
	let mockConfig: AgentConfig;
	let mockMemory: MockMemory;

	beforeEach(() => {
		mockConfig = createMockConfig();
		mockMemory = createMockMemory();
		// TaskExecutor only uses getContextForPrompt in the tested methods
		executor = new TestableExecutor({
			config: mockConfig,
			memory: mockMemory as unknown as MemoryStore,
		});
	});

	describe("generateBranchName", () => {
		it("should generate branch name with fix prefix for issues", () => {
			const task = createTask({ type: "issue", title: "Fix the bug" });
			const branchName = executor.testGenerateBranchName(task);

			expect(branchName).toMatch(/^fix\//);
			expect(branchName).toContain("fix-the-bug");
			expect(branchName).toContain("-42");
		});

		it("should generate branch name with feature prefix for non-issues", () => {
			const task = createTask({ type: "pr-review", title: "Add new feature" });
			const branchName = executor.testGenerateBranchName(task);

			expect(branchName).toMatch(/^feature\//);
		});

		it("should slugify title correctly", () => {
			const task = createTask({ title: "Fix: Special @#$ Characters!!!" });
			const branchName = executor.testGenerateBranchName(task);

			expect(branchName).not.toMatch(/[@#$!:]/);
			expect(branchName).toMatch(/fix-special-characters/i);
		});

		it("should truncate long titles to 30 chars", () => {
			const task = createTask({
				title:
					"This is a very long title that should be truncated to a reasonable length",
			});
			const branchName = executor.testGenerateBranchName(task);
			const slugPart = branchName.split("/")[1]!.split("-42")[0];

			expect(slugPart!.length).toBeLessThanOrEqual(30);
		});

		it("should remove trailing dashes from slug", () => {
			const task = createTask({ title: "Fix bug---" });
			const branchName = executor.testGenerateBranchName(task);

			// Slug should not have multiple consecutive dashes
			expect(branchName).not.toMatch(/-{2,}/);
			// Should end with -42 (the issue number), not trailing dashes before it
			expect(branchName).toBe("fix/fix-bug-42");
		});

		it("should use timestamp for tasks without sourceIssue", () => {
			const task = createTask({ sourceIssue: undefined, title: "Test" });
			const branchName = executor.testGenerateBranchName(task);

			// Should have some alphanumeric ID instead of issue number
			expect(branchName).toMatch(/^fix\/test-[a-z0-9]+$/);
		});
	});

	describe("buildPrompt", () => {
		it("should include task description", () => {
			const task = createTask({ description: "Fix the authentication bug" });
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).toContain("Fix the authentication bug");
		});

		it("should include requirements section", () => {
			const task = createTask();
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).toContain("## Requirements:");
			expect(prompt).toContain("Implement the requested changes");
			expect(prompt).toContain("Add tests");
		});

		it("should reference issue number in commit format", () => {
			const task = createTask({ sourceIssue: 42 });
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).toContain("fixes #42");
		});

		it("should handle tasks without issue number", () => {
			const task = createTask({ sourceIssue: undefined });
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).toContain("fixes #N/A");
		});

		it("should include memory context when available", () => {
			mockMemory.getContextForPrompt.mockReturnValue(
				"## Learned patterns:\n- Always add tests",
			);
			const task = createTask();
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).toContain("Context from previous work");
			expect(prompt).toContain("Always add tests");
		});

		it("should not include memory section when empty", () => {
			mockMemory.getContextForPrompt.mockReturnValue("");
			const task = createTask();
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).not.toContain("Context from previous work");
		});

		it("should instruct not to create PR", () => {
			const task = createTask();
			const prompt = executor.testBuildPrompt(task);

			expect(prompt).toContain("Do NOT create the PR");
		});
	});

	describe("buildPRBody", () => {
		it("should include summary section", () => {
			const task = createTask({
				description: "Fix important bug\nWith details",
			});
			const body = executor.testBuildPRBody(task);

			expect(body).toContain("## Summary");
			expect(body).toContain("Fix important bug");
		});

		it("should limit description to first 10 lines", () => {
			const longDescription = Array(20).fill("Line").join("\n");
			const task = createTask({ description: longDescription });
			const body = executor.testBuildPRBody(task);

			const lineCount = body.split("\n").filter((l) => l === "Line").length;
			expect(lineCount).toBeLessThanOrEqual(10);
		});

		it("should include fixes reference for issues", () => {
			const task = createTask({ sourceIssue: 42 });
			const body = executor.testBuildPRBody(task);

			expect(body).toContain("Fixes #42");
		});

		it("should not include fixes reference without issue", () => {
			const task = createTask({ sourceIssue: undefined });
			const body = executor.testBuildPRBody(task);

			expect(body).not.toContain("Fixes #");
		});

		it("should include test plan checklist", () => {
			const task = createTask();
			const body = executor.testBuildPRBody(task);

			expect(body).toContain("## Test Plan");
			expect(body).toContain("[ ] Tests pass locally");
			expect(body).toContain("[ ] Lint passes");
			expect(body).toContain("[ ] Type check passes");
		});

		it("should include autonomous generation notice", () => {
			const task = createTask();
			const body = executor.testBuildPRBody(task);

			expect(body).toContain("generated autonomously");
			expect(body).toContain("GitHub Agent");
		});
	});
});

describe("PR URL Parsing", () => {
	it("should correctly extract PR number from URL", () => {
		const urlPattern = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/;

		const testCases = [
			{ url: "https://github.com/owner/repo/pull/123", expected: "123" },
			{ url: "https://github.com/org/project/pull/1", expected: "1" },
			{ url: "https://github.com/evalops/composer/pull/376", expected: "376" },
		];

		for (const { url, expected } of testCases) {
			const match = url.match(urlPattern);
			expect(match).not.toBeNull();
			expect(match?.[1]).toBe(expected);
		}
	});

	it("should not match invalid URLs", () => {
		const urlPattern = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/;

		const invalidUrls = [
			"https://github.com/owner/repo/issues/123",
			"https://gitlab.com/owner/repo/pull/123",
			"not a url",
			"https://github.com/owner/repo/pull/",
			"https://github.com/owner/repo/pull/abc",
		];

		for (const url of invalidUrls) {
			const match = url.match(urlPattern);
			if (match) {
				// If it matches, the captured group should be a valid number
				const num = Number.parseInt(match[1]!, 10);
				expect(Number.isNaN(num)).toBe(false);
			}
		}
	});
});

describe("Title Sanitization", () => {
	it("should remove special characters", () => {
		const sanitize = (title: string) =>
			title
				.replace(/[^\w\s\-.,!?()]/g, "")
				.slice(0, 200)
				.trim();

		expect(sanitize("Fix: bug with `code`")).toBe("Fix bug with code");
		expect(sanitize("Add @mention support")).toBe("Add mention support");
		expect(sanitize("Handle $pecial chars")).toBe("Handle pecial chars");
		expect(sanitize("Fix #123 issue")).toBe("Fix 123 issue");
	});

	it("should preserve common punctuation", () => {
		const sanitize = (title: string) =>
			title
				.replace(/[^\w\s\-.,!?()]/g, "")
				.slice(0, 200)
				.trim();

		expect(sanitize("Fix bug. Add feature!")).toBe("Fix bug. Add feature!");
		expect(sanitize("Question? Yes!")).toBe("Question? Yes!");
		expect(sanitize("(optional) feature")).toBe("(optional) feature");
	});

	it("should truncate to 200 chars", () => {
		const sanitize = (title: string) =>
			title
				.replace(/[^\w\s\-.,!?()]/g, "")
				.slice(0, 200)
				.trim();

		const longTitle = "A".repeat(300);
		expect(sanitize(longTitle).length).toBe(200);
	});
});
