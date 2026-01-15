import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "./memory/store.js";
import { Orchestrator, type OrchestratorConfig } from "./orchestrator.js";
import type { IssuePrioritizer } from "./triage/prioritizer.js";
import type {
	AgentStats,
	CheckRunSummary,
	GitHubIssue,
	GitHubPR,
	IssueComment,
	Outcome,
	PRComment,
	PRReview,
	Task,
	TaskResult,
} from "./types.js";
import type { GitHubWatcher } from "./watcher/github.js";
import type { TaskExecutor } from "./worker/executor.js";

// Mock all dependencies
vi.mock("./memory/store.js", () => ({
	MemoryStore: vi.fn(),
}));

vi.mock("./watcher/github.js", () => ({
	GitHubWatcher: vi.fn(),
}));

vi.mock("./triage/prioritizer.js", () => ({
	IssuePrioritizer: vi.fn(),
}));

vi.mock("./worker/executor.js", () => ({
	TaskExecutor: vi.fn(),
}));

vi.mock("./github/auth.js", () => ({
	GitHubAuth: vi.fn(),
}));

vi.mock("./github/client.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: Vitest requires constructable mock for `new`.
	GitHubApiClient: vi.fn().mockImplementation(function () {
		return {
			listPullRequestReviewThreads: vi.fn().mockResolvedValue([]),
			supportsCheckRuns: vi.fn().mockResolvedValue(false),
			updateCheckRun: vi.fn().mockResolvedValue(undefined),
			createCommitStatus: vi.fn().mockResolvedValue(undefined),
		};
	}),
}));

vi.mock("./github/reporter.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: Vitest requires constructable mock for `new`.
	GitHubReporter: vi.fn().mockImplementation(function () {
		return {
			upsertIssueComment: vi.fn(),
		};
	}),
}));

vi.mock("./webhooks/server.js", () => ({
	GitHubWebhookServer: vi.fn(),
}));

type MockMemoryStore = {
	[K in keyof Pick<
		MemoryStore,
		| "addTask"
		| "getTask"
		| "updateTask"
		| "updateTaskStatus"
		| "updateOutcome"
		| "recordOutcome"
		| "getOutcome"
		| "recordTaskFailure"
		| "incrementAttempts"
		| "getDailyCost"
		| "getInProgressTasks"
		| "getPendingTasks"
		| "getPendingOutcomes"
		| "getStats"
		| "save"
	>]: ReturnType<typeof vi.fn>;
};

type MockWatcher = {
	[K in keyof Pick<
		GitHubWatcher,
		"start" | "stop" | "trackPR" | "getIssue"
	>]: ReturnType<typeof vi.fn>;
};

type MockPrioritizer = {
	[K in keyof Pick<IssuePrioritizer, "triage" | "createTask">]: ReturnType<
		typeof vi.fn
	>;
};

type MockExecutor = {
	[K in keyof Pick<TaskExecutor, "execute">]: ReturnType<typeof vi.fn>;
};

const createMockConfig = (): OrchestratorConfig => ({
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
	githubToken: "test-token",
});

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
	id: "test-task-1",
	type: "issue",
	sourceIssue: 42,
	title: "Test task",
	description: "Test description",
	priority: 50,
	createdAt: new Date().toISOString(),
	status: "pending",
	attempts: 0,
	...overrides,
});

const createMockIssue = (
	overrides: Partial<GitHubIssue> = {},
): GitHubIssue => ({
	number: 42,
	title: "Test issue",
	body: "Test body",
	labels: ["composer-task"],
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
	headSha: "abc123",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	mergedAt: null,
	url: "https://github.com/test/repo/pull/100",
	reviewDecision: null,
	...overrides,
});

const createMockOutcome = (overrides: Partial<Outcome> = {}): Outcome => ({
	taskId: "test-task-1",
	prNumber: 100,
	status: "pending",
	reviewFeedback: [],
	updatedAt: new Date().toISOString(),
	...overrides,
});

describe("Orchestrator", () => {
	let config: OrchestratorConfig;
	let mockMemory: MockMemoryStore;
	let mockWatcher: MockWatcher;
	let mockPrioritizer: MockPrioritizer;
	let mockExecutor: MockExecutor;
	let watcherCallbacks: {
		onNewIssue?: (issue: GitHubIssue) => Promise<void>;
		onIssueComment?: (
			issue: GitHubIssue,
			comment: IssueComment,
		) => Promise<void>;
		onPRMerged?: (pr: GitHubPR) => Promise<void>;
		onPRClosed?: (pr: GitHubPR) => Promise<void>;
		onPRReview?: (pr: GitHubPR, review: PRReview) => Promise<void>;
		onPRComment?: (pr: GitHubPR, comment: PRComment) => Promise<void>;
		onPRCheckRuns?: (pr: GitHubPR, runs: CheckRunSummary[]) => Promise<void>;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		config = createMockConfig();
		watcherCallbacks = {};

		// Setup mock memory
		mockMemory = {
			addTask: vi.fn(),
			getTask: vi.fn(),
			updateTask: vi.fn(),
			updateTaskStatus: vi.fn(),
			updateOutcome: vi.fn(),
			recordOutcome: vi.fn(),
			getOutcome: vi.fn(),
			recordTaskFailure: vi.fn(),
			incrementAttempts: vi.fn(),
			getDailyCost: vi.fn().mockReturnValue(0),
			getInProgressTasks: vi.fn().mockReturnValue([]),
			getPendingTasks: vi.fn().mockReturnValue([]),
			getPendingOutcomes: vi.fn().mockReturnValue([]),
			getStats: vi.fn().mockReturnValue({
				totalTasks: 0,
				completedTasks: 0,
				mergedPRs: 0,
				rejectedPRs: 0,
				averageAttemptsToMerge: 0,
				totalTokensUsed: 0,
				totalCost: 0,
				dailyCost: 0,
				dailyCostDate: new Date().toISOString().split("T")[0]!,
			} satisfies AgentStats),
			save: vi.fn(),
		};

		// Setup mock watcher - capture callbacks
		mockWatcher = {
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn(),
			trackPR: vi.fn(),
			getIssue: vi.fn(),
		};

		// Setup mock prioritizer
		mockPrioritizer = {
			triage: vi.fn().mockReturnValue({
				shouldProcess: true,
				priority: 50,
				reason: "Test",
				complexity: "medium",
			}),
			createTask: vi
				.fn()
				.mockImplementation((issue: GitHubIssue) =>
					createMockTask({ sourceIssue: issue.number, title: issue.title }),
				),
		};

		// Setup mock executor
		mockExecutor = {
			execute: vi.fn().mockResolvedValue({
				success: true,
				prNumber: 100,
				prUrl: "https://github.com/test/repo/pull/100",
				duration: 1000,
			} satisfies TaskResult),
		};

		// Wire up mocks to constructors
		const { MemoryStore } = await import("./memory/store.js");
		(MemoryStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			// biome-ignore lint/complexity/useArrowFunction: Vitest requires constructable mock for `new`.
			function () {
				return mockMemory;
			},
		);

		const { GitHubWatcher } = await import("./watcher/github.js");
		(GitHubWatcher as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			// biome-ignore lint/complexity/useArrowFunction: Vitest requires constructable mock for `new`.
			function (
				_client: unknown,
				_config: unknown,
				callbacks: typeof watcherCallbacks,
			) {
				watcherCallbacks = callbacks;
				return mockWatcher;
			},
		);

		const { IssuePrioritizer } = await import("./triage/prioritizer.js");
		const issuePrioritizerCtor = IssuePrioritizer as unknown as ReturnType<
			typeof vi.fn
		>;
		// biome-ignore lint/complexity/useArrowFunction: Vitest requires constructable mock for `new`.
		issuePrioritizerCtor.mockImplementation(function () {
			return mockPrioritizer;
		});

		const { TaskExecutor } = await import("./worker/executor.js");
		(TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			// biome-ignore lint/complexity/useArrowFunction: Vitest requires constructable mock for `new`.
			function () {
				return mockExecutor;
			},
		);
	});

	describe("constructor", () => {
		it("should initialize all components", () => {
			const orchestrator = new Orchestrator(config);
			expect(orchestrator).toBeDefined();
		});
	});

	describe("event handlers", () => {
		describe("handleNewIssue", () => {
			it("should triage and create task for processable issues", async () => {
				new Orchestrator(config);
				const issue = createMockIssue();

				await watcherCallbacks.onNewIssue?.(issue);

				expect(mockPrioritizer.triage).toHaveBeenCalledWith(issue);
				expect(mockPrioritizer.createTask).toHaveBeenCalled();
				expect(mockMemory.addTask).toHaveBeenCalled();
			});

			it("should skip issues that fail triage", async () => {
				mockPrioritizer.triage.mockReturnValue({
					shouldProcess: false,
					priority: 0,
					reason: "Already attempted",
					complexity: "low",
				});

				new Orchestrator(config);
				const issue = createMockIssue();

				await watcherCallbacks.onNewIssue?.(issue);

				expect(mockPrioritizer.triage).toHaveBeenCalledWith(issue);
				expect(mockPrioritizer.createTask).not.toHaveBeenCalled();
				expect(mockMemory.addTask).not.toHaveBeenCalled();
			});
		});

		describe("handleIssueComment", () => {
			it("should create task when comment contains trigger", async () => {
				new Orchestrator(config);
				const issue = createMockIssue();
				const comment: IssueComment = {
					id: 99,
					issueNumber: issue.number,
					author: "alice",
					body: "@composer please handle",
					createdAt: new Date().toISOString(),
					url: issue.url,
				};

				await watcherCallbacks.onIssueComment?.(issue, comment);

				expect(mockPrioritizer.triage).toHaveBeenCalledWith(issue);
				expect(mockMemory.addTask).toHaveBeenCalled();
			});
		});

		describe("handlePRMerged", () => {
			it("should update outcome when task found", async () => {
				const task = createMockTask();
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });

				await watcherCallbacks.onPRMerged?.(pr);

				expect(mockMemory.updateOutcome).toHaveBeenCalledWith(
					task.id,
					"merged",
				);
			});

			it("should do nothing when task not found", async () => {
				mockMemory.getPendingOutcomes.mockReturnValue([]);

				new Orchestrator(config);
				const pr = createMockPR({ number: 999 });

				await watcherCallbacks.onPRMerged?.(pr);

				expect(mockMemory.updateOutcome).not.toHaveBeenCalled();
			});
		});

		describe("handlePRClosed", () => {
			it("should update outcome to closed when task found", async () => {
				const task = createMockTask();
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100, state: "closed" });

				await watcherCallbacks.onPRClosed?.(pr);

				expect(mockMemory.updateOutcome).toHaveBeenCalledWith(
					task.id,
					"closed",
				);
			});
		});

		describe("handlePRReview", () => {
			it("should record approved review", async () => {
				const task = createMockTask();
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });
				const review: PRReview = {
					id: 1,
					author: "reviewer",
					state: "APPROVED",
					body: "LGTM",
					submittedAt: new Date().toISOString(),
				};

				await watcherCallbacks.onPRReview?.(pr, review);

				expect(mockMemory.updateOutcome).toHaveBeenCalledWith(
					task.id,
					"pending",
					expect.objectContaining({
						reviewer: "reviewer",
						decision: "approved",
					}),
				);
			});

			it("should mark task pending for retry on changes requested", async () => {
				const task = createMockTask({ attempts: 1 });
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });
				const review: PRReview = {
					id: 1,
					author: "reviewer",
					state: "CHANGES_REQUESTED",
					body: "Please fix",
					submittedAt: new Date().toISOString(),
				};

				await watcherCallbacks.onPRReview?.(pr, review);

				expect(mockMemory.updateOutcome).toHaveBeenCalledWith(
					task.id,
					"changes_requested",
					expect.objectContaining({
						decision: "changes_requested",
					}),
				);
				expect(mockMemory.updateTaskStatus).toHaveBeenCalledWith(
					task.id,
					"pending",
				);
			});

			it("should not retry if max attempts reached", async () => {
				const task = createMockTask({ attempts: 3 });
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });
				const review: PRReview = {
					id: 1,
					author: "reviewer",
					state: "CHANGES_REQUESTED",
					body: "Please fix",
					submittedAt: new Date().toISOString(),
				};

				await watcherCallbacks.onPRReview?.(pr, review);

				expect(mockMemory.updateOutcome).toHaveBeenCalled();
				expect(mockMemory.updateTaskStatus).not.toHaveBeenCalled();
			});
		});

		describe("handlePRComment", () => {
			it("should store comment as feedback", async () => {
				const task = createMockTask();
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });
				const comment: PRComment = {
					id: 1,
					author: "reviewer",
					body: "Nice work!",
					path: null,
					line: null,
					createdAt: new Date().toISOString(),
				};

				await watcherCallbacks.onPRComment?.(pr, comment);

				expect(mockMemory.updateOutcome).toHaveBeenCalledWith(
					task.id,
					"pending",
					expect.objectContaining({
						reviewer: "reviewer",
						decision: "commented",
						comments: ["Nice work!"],
					}),
				);
			});
		});

		describe("handlePRCheckRuns", () => {
			it("should record check run failures and retry", async () => {
				const task = createMockTask({ attempts: 1 });
				const outcome = createMockOutcome({ taskId: task.id, prNumber: 100 });
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);
				mockMemory.getOutcome.mockReturnValue(outcome);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });
				const checkRuns: CheckRunSummary[] = [
					{
						id: 1,
						name: "CI",
						status: "completed",
						conclusion: "failure",
						detailsUrl: "https://github.com/test/repo/actions/runs/1",
						startedAt: new Date().toISOString(),
						completedAt: new Date().toISOString(),
					},
				];

				await watcherCallbacks.onPRCheckRuns?.(pr, checkRuns);

				expect(mockMemory.updateOutcome).toHaveBeenCalledWith(
					task.id,
					"changes_requested",
					expect.objectContaining({
						reviewer: "github-checks",
						decision: "changes_requested",
					}),
				);
				expect(mockMemory.updateTaskStatus).toHaveBeenCalledWith(
					task.id,
					"pending",
				);
			});

			it("should avoid duplicate check run feedback", async () => {
				const task = createMockTask();
				const outcome = createMockOutcome({
					taskId: task.id,
					prNumber: 100,
					reviewFeedback: [
						{
							reviewer: "github-checks",
							decision: "changes_requested",
							comments: [
								'Check run "CI" concluded failure. Details: https://github.com/test/repo/actions/runs/1',
							],
							timestamp: new Date().toISOString(),
						},
					],
				});
				mockMemory.getPendingOutcomes.mockReturnValue([outcome]);
				mockMemory.getTask.mockReturnValue(task);
				mockMemory.getOutcome.mockReturnValue(outcome);

				new Orchestrator(config);
				const pr = createMockPR({ number: 100 });
				const checkRuns: CheckRunSummary[] = [
					{
						id: 1,
						name: "CI",
						status: "completed",
						conclusion: "failure",
						detailsUrl: "https://github.com/test/repo/actions/runs/1",
						startedAt: new Date().toISOString(),
						completedAt: new Date().toISOString(),
					},
				];

				await watcherCallbacks.onPRCheckRuns?.(pr, checkRuns);

				expect(mockMemory.updateOutcome).not.toHaveBeenCalled();
			});
		});
	});

	describe("processIssue", () => {
		it("should skip if daily budget exceeded", async () => {
			mockMemory.getDailyCost.mockReturnValue(100);

			const orchestrator = new Orchestrator(config);
			await orchestrator.processIssue(42);

			expect(mockWatcher.getIssue).not.toHaveBeenCalled();
		});

		it("should skip if triage rejects issue", async () => {
			mockPrioritizer.triage.mockReturnValue({
				shouldProcess: false,
				priority: 0,
				reason: "Not suitable",
				complexity: "high",
			});
			mockWatcher.getIssue.mockResolvedValue(createMockIssue());

			const orchestrator = new Orchestrator(config);
			await orchestrator.processIssue(42);

			expect(mockMemory.addTask).not.toHaveBeenCalled();
		});

		it("should execute task and record success", async () => {
			const issue = createMockIssue();
			mockWatcher.getIssue.mockResolvedValue(issue);

			const orchestrator = new Orchestrator(config);
			await orchestrator.processIssue(42);

			expect(mockMemory.addTask).toHaveBeenCalled();
			expect(mockMemory.updateTaskStatus).toHaveBeenCalledWith(
				expect.any(String),
				"in_progress",
			);
			expect(mockMemory.incrementAttempts).toHaveBeenCalled();
			expect(mockExecutor.execute).toHaveBeenCalled();
			expect(mockMemory.updateTaskStatus).toHaveBeenCalledWith(
				expect.any(String),
				"completed",
				expect.objectContaining({ success: true }),
			);
			expect(mockMemory.recordOutcome).toHaveBeenCalled();
		});

		it("should handle execution failure with retry", async () => {
			const issue = createMockIssue();
			mockWatcher.getIssue.mockResolvedValue(issue);
			mockExecutor.execute.mockResolvedValue({
				success: false,
				error: "Test error",
				duration: 1000,
			});

			const orchestrator = new Orchestrator(config);
			await orchestrator.processIssue(42);

			// Task should be set to pending for retry (attempts = 1, max = 3)
			expect(mockMemory.updateTaskStatus).toHaveBeenCalledWith(
				expect.any(String),
				"pending",
				expect.objectContaining({ success: false }),
			);
		});

		it("should handle exception with retry", async () => {
			const issue = createMockIssue();
			mockWatcher.getIssue.mockResolvedValue(issue);
			mockExecutor.execute.mockRejectedValue(new Error("Unexpected error"));

			const orchestrator = new Orchestrator(config);
			await orchestrator.processIssue(42);

			// Task should be set to pending for retry on exception
			expect(mockMemory.updateTaskStatus).toHaveBeenCalledWith(
				expect.any(String),
				"pending",
				expect.objectContaining({
					success: false,
					error: "Unexpected error",
				}),
			);
		});

		it("should mark as failed when max attempts reached", async () => {
			const issue = createMockIssue();
			mockWatcher.getIssue.mockResolvedValue(issue);
			mockExecutor.execute.mockResolvedValue({
				success: false,
				error: "Test error",
				duration: 1000,
			});
			// Override createTask to return task at max attempts
			// The check is `task.attempts < maxAttemptsPerTask` (3 < 3 = false)
			mockPrioritizer.createTask.mockReturnValue(
				createMockTask({ attempts: 3 }),
			);

			const orchestrator = new Orchestrator(config);
			await orchestrator.processIssue(42);

			// Should be marked failed since attempts >= maxAttemptsPerTask after increment
			expect(mockMemory.updateTaskStatus).toHaveBeenLastCalledWith(
				expect.any(String),
				"failed",
				expect.objectContaining({ success: false }),
			);
		});
	});

	describe("getStats", () => {
		it("should return memory stats", () => {
			const orchestrator = new Orchestrator(config);
			const stats = orchestrator.getStats();

			expect(mockMemory.getStats).toHaveBeenCalled();
			expect(stats).toBeDefined();
		});
	});

	describe("start and stop", () => {
		it("should start watcher and resume pending work", async () => {
			const pendingOutcome = createMockOutcome();
			mockMemory.getPendingOutcomes.mockReturnValue([pendingOutcome]);
			mockMemory.getPendingTasks.mockReturnValue([createMockTask()]);

			const orchestrator = new Orchestrator(config);

			// Start but don't await to avoid infinite loop
			const startPromise = orchestrator.start();

			// Give it a tick to start
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockWatcher.start).toHaveBeenCalled();
			expect(mockWatcher.trackPR).toHaveBeenCalledWith(pendingOutcome.prNumber);

			// Stop to clean up
			await orchestrator.stop();

			expect(mockWatcher.stop).toHaveBeenCalled();
			expect(mockMemory.save).toHaveBeenCalled();

			await startPromise.catch(() => {});
		});
	});
});
