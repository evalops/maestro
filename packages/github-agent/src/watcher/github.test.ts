import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentConfig,
	GitHubIssue,
	GitHubPR,
	IssueComment,
} from "../types.js";
import { GitHubWatcher, type WatcherEvents } from "./github.js";

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

const createMockIssue = (
	overrides: Partial<GitHubIssue> = {},
): GitHubIssue => ({
	number: 42,
	title: "Test issue",
	body: "Test body",
	labels: [],
	state: "open",
	author: "testuser",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	url: "https://github.com/test/repo/issues/42",
	comments: 0,
	...overrides,
});

const createMockPR = (overrides: Partial<GitHubPR> = {}): GitHubPR => ({
	number: 100,
	title: "Test PR",
	body: "Test body",
	state: "open",
	author: "bot",
	branch: "fix/test-42",
	base: "main",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	mergedAt: null,
	url: "https://github.com/test/repo/pull/100",
	reviewDecision: null,
	...overrides,
});

const createMockEvents = (): WatcherEvents => ({
	onNewIssue: vi.fn().mockResolvedValue(undefined),
	onPRMerged: vi.fn().mockResolvedValue(undefined),
	onPRClosed: vi.fn().mockResolvedValue(undefined),
	onPRReview: vi.fn().mockResolvedValue(undefined),
	onPRComment: vi.fn().mockResolvedValue(undefined),
	onIssueComment: vi.fn().mockResolvedValue(undefined),
});

type MockClient = {
	listIssuesUpdatedSince: ReturnType<typeof vi.fn>;
	getPullRequest: ReturnType<typeof vi.fn>;
	listPullRequestReviews: ReturnType<typeof vi.fn>;
	listPullRequestReviewComments: ReturnType<typeof vi.fn>;
	getIssue: ReturnType<typeof vi.fn>;
	listIssueCommentsSince: ReturnType<typeof vi.fn>;
};

describe("GitHubWatcher", () => {
	let config: AgentConfig;
	let events: WatcherEvents;
	let mockClient: MockClient;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		config = createMockConfig();
		events = createMockEvents();
		mockClient = {
			listIssuesUpdatedSince: vi.fn().mockResolvedValue([]),
			getPullRequest: vi.fn(),
			listPullRequestReviews: vi.fn().mockResolvedValue([]),
			listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
			getIssue: vi.fn(),
			listIssueCommentsSince: vi.fn().mockResolvedValue([]),
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("constructor", () => {
		it("should initialize with correct config", () => {
			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
			expect(watcher).toBeDefined();
		});
	});

	describe("trackPR", () => {
		it("should add PR to tracked set", () => {
			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
			watcher.trackPR(100);
			watcher.trackPR(200);
			expect(watcher).toBeDefined();
		});
	});

	describe("start and stop", () => {
		it("should start polling and stop cleanly", async () => {
			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);

			await watcher.start();

			expect(mockClient.listIssuesUpdatedSince).toHaveBeenCalled();

			watcher.stop();

			mockClient.listIssuesUpdatedSince.mockClear();
			vi.advanceTimersByTime(config.pollIntervalMs);

			await vi.runAllTimersAsync();
			expect(mockClient.listIssuesUpdatedSince).not.toHaveBeenCalled();
		});

		it("should set up recurring poll", async () => {
			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);

			await watcher.start();
			expect(mockClient.listIssuesUpdatedSince).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
			expect(mockClient.listIssuesUpdatedSince).toHaveBeenCalledTimes(2);

			watcher.stop();
		});
	});

	describe("pollIssues", () => {
		it("should call onNewIssue for new issues with target labels", async () => {
			const futureDate = new Date(Date.now() + 1000).toISOString();
			mockClient.listIssuesUpdatedSince.mockResolvedValue([
				createMockIssue({
					labels: ["composer-task"],
					createdAt: futureDate,
					updatedAt: futureDate,
				}),
			]);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
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

		it("should call onNewIssue when a target label is added after creation", async () => {
			const baseTime = Date.now();
			const createdAt = new Date(baseTime - 60_000).toISOString();
			const firstUpdate = new Date(baseTime + 1000).toISOString();
			const secondUpdate = new Date(baseTime + 2000).toISOString();

			mockClient.listIssuesUpdatedSince
				.mockResolvedValueOnce([
					createMockIssue({
						labels: [],
						createdAt,
						updatedAt: firstUpdate,
					}),
				])
				.mockResolvedValueOnce([
					createMockIssue({
						labels: ["composer-task"],
						createdAt,
						updatedAt: secondUpdate,
					}),
				]);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
			await watcher.start();

			expect(events.onNewIssue).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(config.pollIntervalMs);

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
			mockClient.listIssuesUpdatedSince.mockResolvedValue([
				createMockIssue({
					labels: ["unrelated-label"],
					createdAt: futureDate,
					updatedAt: futureDate,
				}),
			]);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
			await watcher.start();

			expect(events.onNewIssue).not.toHaveBeenCalled();

			watcher.stop();
		});
	});

	describe("pollTrackedPRs", () => {
		it("should call onPRMerged when PR is merged", async () => {
			mockClient.getPullRequest.mockResolvedValue(
				createMockPR({ state: "merged" }),
			);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
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
			mockClient.getPullRequest.mockResolvedValue(
				createMockPR({ state: "closed" }),
			);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
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
			mockClient.getPullRequest.mockResolvedValue(
				createMockPR({ state: "open" }),
			);
			mockClient.listPullRequestReviews.mockResolvedValue([
				{
					id: 1,
					author: "reviewer",
					state: "APPROVED",
					body: "LGTM",
					submittedAt: futureDate,
				},
			]);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
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
			mockClient.getPullRequest.mockResolvedValue(
				createMockPR({ state: "open" }),
			);
			mockClient.listPullRequestReviewComments.mockResolvedValue([
				{
					id: 1,
					author: "reviewer",
					body: "Please fix this",
					path: "src/index.ts",
					line: 42,
					createdAt: now.toISOString(),
				},
			]);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
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

	describe("issue comments", () => {
		it("should emit issue comments when handler is provided", async () => {
			const comment: IssueComment = {
				id: 99,
				issueNumber: 42,
				author: "alice",
				body: "@composer please pick this up",
				createdAt: new Date().toISOString(),
				url: "https://github.com/test/repo/issues/42#issuecomment-1",
			};
			mockClient.listIssueCommentsSince.mockResolvedValue([
				{ issue: createMockIssue(), comment },
			]);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
			await watcher.start();

			expect(events.onIssueComment).toHaveBeenCalledWith(
				expect.objectContaining({ number: 42 }),
				expect.objectContaining({ author: "alice" }),
			);

			watcher.stop();
		});
	});

	describe("getIssue", () => {
		it("should fetch and return issue details", async () => {
			const issue = createMockIssue({ labels: ["bug", "composer-task"] });
			mockClient.getIssue.mockResolvedValue(issue);

			const watcher = new GitHubWatcher(
				mockClient as unknown as Parameters<typeof GitHubWatcher>[0],
				config,
				events,
			);
			const result = await watcher.getIssue(42);

			expect(result).toEqual(
				expect.objectContaining({
					number: 42,
					title: "Test issue",
					labels: ["bug", "composer-task"],
					state: "open",
					author: "testuser",
				}),
			);
		});
	});
});
