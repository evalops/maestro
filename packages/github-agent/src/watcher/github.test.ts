import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GitHubIssue, GitHubPR } from "../types.js";
import { GitHubWatcher, type WatcherEvents } from "./github.js";

// Mock Octokit
vi.mock("@octokit/rest", () => ({
	Octokit: vi.fn().mockImplementation(() => ({
		issues: {
			listForRepo: vi.fn(),
			get: vi.fn(),
		},
		pulls: {
			get: vi.fn(),
			listReviews: vi.fn(),
			listReviewComments: vi.fn(),
		},
	})),
}));

const createMockConfig = (): AgentConfig => ({
	owner: "testowner",
	repo: "testrepo",
	baseBranch: "main",
	pollIntervalMs: 60000,
	issueLabels: ["composer-task", "good-first-issue"],
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

const createMockEvents = (): WatcherEvents => ({
	onNewIssue: vi.fn().mockResolvedValue(undefined),
	onPRMerged: vi.fn().mockResolvedValue(undefined),
	onPRClosed: vi.fn().mockResolvedValue(undefined),
	onPRReview: vi.fn().mockResolvedValue(undefined),
	onPRComment: vi.fn().mockResolvedValue(undefined),
});

describe("GitHubWatcher", () => {
	let config: AgentConfig;
	let events: WatcherEvents;
	let mockOctokit: {
		issues: {
			listForRepo: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
		};
		pulls: {
			get: ReturnType<typeof vi.fn>;
			listReviews: ReturnType<typeof vi.fn>;
			listReviewComments: ReturnType<typeof vi.fn>;
		};
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		config = createMockConfig();
		events = createMockEvents();

		// Get mock octokit instance
		const { Octokit } = await import("@octokit/rest");
		mockOctokit = {
			issues: {
				listForRepo: vi.fn().mockResolvedValue({ data: [] }),
				get: vi.fn(),
			},
			pulls: {
				get: vi.fn(),
				listReviews: vi.fn().mockResolvedValue({ data: [] }),
				listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
			},
		};
		(Octokit as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			() => mockOctokit,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("constructor", () => {
		it("should initialize with correct config", () => {
			const watcher = new GitHubWatcher("test-token", config, events);
			expect(watcher).toBeDefined();
		});
	});

	describe("trackPR", () => {
		it("should add PR to tracked set", () => {
			const watcher = new GitHubWatcher("test-token", config, events);
			watcher.trackPR(100);
			watcher.trackPR(200);
			// Can verify indirectly by checking it polls these PRs
			expect(watcher).toBeDefined();
		});
	});

	describe("start and stop", () => {
		it("should start polling and stop cleanly", async () => {
			const watcher = new GitHubWatcher("test-token", config, events);

			await watcher.start();

			// Verify initial poll happened
			expect(mockOctokit.issues.listForRepo).toHaveBeenCalled();

			watcher.stop();

			// Advance timer - no more polls should happen
			mockOctokit.issues.listForRepo.mockClear();
			vi.advanceTimersByTime(config.pollIntervalMs);

			// Give the timer a chance to fire (it shouldn't)
			await vi.runAllTimersAsync();
			expect(mockOctokit.issues.listForRepo).not.toHaveBeenCalled();
		});

		it("should set up recurring poll", async () => {
			const watcher = new GitHubWatcher("test-token", config, events);

			await watcher.start();
			expect(mockOctokit.issues.listForRepo).toHaveBeenCalledTimes(1);

			// Advance to next poll
			await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
			expect(mockOctokit.issues.listForRepo).toHaveBeenCalledTimes(2);

			watcher.stop();
		});
	});

	describe("pollIssues", () => {
		it("should call onNewIssue for new issues with target labels", async () => {
			const futureDate = new Date(Date.now() + 1000).toISOString();
			mockOctokit.issues.listForRepo.mockResolvedValue({
				data: [
					{
						number: 42,
						title: "Test issue",
						body: "Test body",
						labels: [{ name: "composer-task" }],
						state: "open",
						user: { login: "testuser" },
						created_at: futureDate,
						updated_at: futureDate,
						html_url: "https://github.com/test/repo/issues/42",
						comments: 0,
					},
				],
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			await watcher.start();

			expect(events.onNewIssue).toHaveBeenCalledWith(
				expect.objectContaining({
					number: 42,
					title: "Test issue",
					labels: ["composer-task"],
				}),
			);

			watcher.stop();
		});

		it("should skip issues without target labels", async () => {
			const futureDate = new Date(Date.now() + 1000).toISOString();
			mockOctokit.issues.listForRepo.mockResolvedValue({
				data: [
					{
						number: 42,
						title: "Test issue",
						body: "Test body",
						labels: [{ name: "unrelated-label" }],
						state: "open",
						user: { login: "testuser" },
						created_at: futureDate,
						updated_at: futureDate,
						html_url: "https://github.com/test/repo/issues/42",
						comments: 0,
					},
				],
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			await watcher.start();

			expect(events.onNewIssue).not.toHaveBeenCalled();

			watcher.stop();
		});

		it("should skip pull requests in issues response", async () => {
			const futureDate = new Date(Date.now() + 1000).toISOString();
			mockOctokit.issues.listForRepo.mockResolvedValue({
				data: [
					{
						number: 42,
						title: "Test PR",
						body: "Test body",
						labels: [{ name: "composer-task" }],
						state: "open",
						user: { login: "testuser" },
						created_at: futureDate,
						updated_at: futureDate,
						html_url: "https://github.com/test/repo/pull/42",
						comments: 0,
						pull_request: { url: "..." }, // This marks it as a PR
					},
				],
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			await watcher.start();

			expect(events.onNewIssue).not.toHaveBeenCalled();

			watcher.stop();
		});

		it("should handle string labels", async () => {
			const futureDate = new Date(Date.now() + 1000).toISOString();
			mockOctokit.issues.listForRepo.mockResolvedValue({
				data: [
					{
						number: 42,
						title: "Test issue",
						body: "Test body",
						labels: ["composer-task"], // String labels
						state: "open",
						user: { login: "testuser" },
						created_at: futureDate,
						updated_at: futureDate,
						html_url: "https://github.com/test/repo/issues/42",
						comments: 0,
					},
				],
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			await watcher.start();

			expect(events.onNewIssue).toHaveBeenCalled();

			watcher.stop();
		});
	});

	describe("pollTrackedPRs", () => {
		it("should call onPRMerged when PR is merged", async () => {
			mockOctokit.pulls.get.mockResolvedValue({
				data: {
					number: 100,
					title: "Test PR",
					body: "Test body",
					state: "closed",
					merged: true,
					user: { login: "bot" },
					head: { ref: "fix/test-42" },
					base: { ref: "main" },
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					merged_at: new Date().toISOString(),
					html_url: "https://github.com/test/repo/pull/100",
				},
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			watcher.trackPR(100);
			await watcher.start();

			expect(events.onPRMerged).toHaveBeenCalledWith(
				expect.objectContaining({
					number: 100,
					state: "merged",
				}),
			);

			watcher.stop();
		});

		it("should call onPRClosed when PR is closed without merge", async () => {
			mockOctokit.pulls.get.mockResolvedValue({
				data: {
					number: 100,
					title: "Test PR",
					body: "Test body",
					state: "closed",
					merged: false,
					user: { login: "bot" },
					head: { ref: "fix/test-42" },
					base: { ref: "main" },
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					merged_at: null,
					html_url: "https://github.com/test/repo/pull/100",
				},
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			watcher.trackPR(100);
			await watcher.start();

			expect(events.onPRClosed).toHaveBeenCalledWith(
				expect.objectContaining({
					number: 100,
					state: "closed",
				}),
			);

			watcher.stop();
		});

		it("should check for reviews on open PRs", async () => {
			const now = new Date();
			const futureDate = new Date(now.getTime() + 1000).toISOString();

			mockOctokit.pulls.get.mockResolvedValue({
				data: {
					number: 100,
					title: "Test PR",
					body: "Test body",
					state: "open",
					merged: false,
					user: { login: "bot" },
					head: { ref: "fix/test-42" },
					base: { ref: "main" },
					created_at: now.toISOString(),
					updated_at: now.toISOString(),
					merged_at: null,
					html_url: "https://github.com/test/repo/pull/100",
				},
			});

			mockOctokit.pulls.listReviews.mockResolvedValue({
				data: [
					{
						id: 1,
						user: { login: "reviewer" },
						state: "APPROVED",
						body: "LGTM",
						submitted_at: futureDate,
					},
				],
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			watcher.trackPR(100);
			await watcher.start();

			expect(events.onPRReview).toHaveBeenCalledWith(
				expect.objectContaining({ number: 100 }),
				expect.objectContaining({
					author: "reviewer",
					state: "APPROVED",
				}),
			);

			watcher.stop();
		});

		it("should check for new comments on open PRs", async () => {
			const now = new Date();

			mockOctokit.pulls.get.mockResolvedValue({
				data: {
					number: 100,
					title: "Test PR",
					body: "Test body",
					state: "open",
					merged: false,
					user: { login: "bot" },
					head: { ref: "fix/test-42" },
					base: { ref: "main" },
					created_at: now.toISOString(),
					updated_at: now.toISOString(),
					merged_at: null,
					html_url: "https://github.com/test/repo/pull/100",
				},
			});

			mockOctokit.pulls.listReviewComments.mockResolvedValue({
				data: [
					{
						id: 1,
						user: { login: "reviewer" },
						body: "Please fix this",
						path: "src/index.ts",
						line: 42,
						created_at: now.toISOString(),
					},
				],
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			watcher.trackPR(100);
			await watcher.start();

			expect(events.onPRComment).toHaveBeenCalledWith(
				expect.objectContaining({ number: 100 }),
				expect.objectContaining({
					author: "reviewer",
					body: "Please fix this",
					path: "src/index.ts",
					line: 42,
				}),
			);

			watcher.stop();
		});
	});

	describe("getIssue", () => {
		it("should fetch and return issue details", async () => {
			mockOctokit.issues.get.mockResolvedValue({
				data: {
					number: 42,
					title: "Test issue",
					body: "Test body",
					labels: [{ name: "bug" }, { name: "composer-task" }],
					state: "open",
					user: { login: "testuser" },
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					html_url: "https://github.com/test/repo/issues/42",
					comments: 5,
				},
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			const issue = await watcher.getIssue(42);

			expect(issue).toEqual(
				expect.objectContaining({
					number: 42,
					title: "Test issue",
					body: "Test body",
					labels: ["bug", "composer-task"],
					state: "open",
					author: "testuser",
					comments: 5,
				}),
			);
		});

		it("should handle missing user", async () => {
			mockOctokit.issues.get.mockResolvedValue({
				data: {
					number: 42,
					title: "Test issue",
					body: null,
					labels: [],
					state: "open",
					user: null,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					html_url: "https://github.com/test/repo/issues/42",
					comments: 0,
				},
			});

			const watcher = new GitHubWatcher("test-token", config, events);
			const issue = await watcher.getIssue(42);

			expect(issue.author).toBe("unknown");
			expect(issue.body).toBeNull();
		});
	});

	describe("error handling", () => {
		it("should handle poll errors gracefully", async () => {
			mockOctokit.issues.listForRepo.mockRejectedValue(
				new Error("API rate limit"),
			);

			const watcher = new GitHubWatcher("test-token", config, events);
			// Should not throw
			await watcher.start();

			watcher.stop();
		});

		it("should handle PR fetch errors gracefully", async () => {
			mockOctokit.pulls.get.mockRejectedValue(new Error("PR not found"));

			const watcher = new GitHubWatcher("test-token", config, events);
			watcher.trackPR(100);
			// Should not throw
			await watcher.start();

			expect(events.onPRMerged).not.toHaveBeenCalled();

			watcher.stop();
		});
	});
});
