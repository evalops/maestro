/**
 * @evalops/github-agent
 *
 * Autonomous GitHub agent for Composer building Composer
 */

// Types
export type {
	GitHubIssue,
	GitHubPR,
	PRReview,
	PRComment,
	PRReviewThread,
	PRReviewThreadComment,
	Task,
	TaskResult,
	Outcome,
	ReviewFeedback,
	Memory,
	ReviewPattern,
	AgentStats,
	AgentConfig,
} from "./types.js";

export { DEFAULT_CONFIG } from "./types.js";

// Core components
export { Orchestrator, type OrchestratorConfig } from "./orchestrator.js";
export { MemoryStore } from "./memory/store.js";
export { GitHubWatcher, type WatcherEvents } from "./watcher/github.js";
export { IssuePrioritizer, type TriageResult } from "./triage/prioritizer.js";
export { TaskExecutor, type ExecutorOptions } from "./worker/executor.js";
export { GitHubAuth } from "./github/auth.js";
export { GitHubApiClient } from "./github/client.js";
export { GitHubReporter, type TaskProgress } from "./github/reporter.js";
export { GitHubWebhookServer } from "./webhooks/server.js";
