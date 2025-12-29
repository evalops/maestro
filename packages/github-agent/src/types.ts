/**
 * Core types for the GitHub Agent
 */

export interface GitHubIssue {
	number: number;
	title: string;
	body: string | null;
	labels: string[];
	state: "open" | "closed";
	author: string;
	createdAt: string;
	updatedAt: string;
	url: string;
	comments: number;
}

export interface GitHubPR {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed" | "merged";
	author: string;
	branch: string;
	base: string;
	createdAt: string;
	updatedAt: string;
	mergedAt: string | null;
	url: string;
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

export interface PRReview {
	id: number;
	author: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
	body: string | null;
	submittedAt: string;
}

export interface PRComment {
	id: number;
	author: string;
	body: string;
	path: string | null;
	line: number | null;
	createdAt: string;
}

export interface IssueComment {
	id: number;
	issueNumber: number;
	author: string;
	body: string;
	createdAt: string;
	url: string;
}

/**
 * Task represents work the agent should do
 */
export interface Task {
	id: string;
	type: "issue" | "pr-review" | "pr-feedback" | "self-improvement";
	sourceIssue?: number;
	sourcePR?: number;
	labels?: string[];
	title: string;
	description: string;
	priority: number; // 0-100, higher = more urgent
	createdAt: string;
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
	attempts: number;
	lastAttemptAt?: string;
	result?: TaskResult;
	reportCommentId?: number;
	checkRunId?: number;
}

export interface TaskResult {
	success: boolean;
	prNumber?: number;
	prUrl?: string;
	error?: string;
	duration: number;
	tokensUsed?: number;
	cost?: number;
}

/**
 * Outcome tracks what happened after a PR was submitted
 */
export interface Outcome {
	taskId: string;
	prNumber: number;
	status: "pending" | "merged" | "closed" | "changes_requested";
	reviewFeedback: ReviewFeedback[];
	mergedAt?: string;
	closedAt?: string;
	updatedAt: string;
}

export interface ReviewFeedback {
	reviewer: string;
	decision: "approved" | "changes_requested" | "commented";
	comments: string[];
	timestamp: string;
}

/**
 * Memory stores learned patterns
 */
export interface Memory {
	// Files that tend to cause issues
	problematicFiles: Map<string, number>; // path -> failure count

	// Successful patterns by issue label
	successfulPatterns: Map<string, string[]>; // label -> approaches that worked

	// Common review feedback to avoid
	reviewPatterns: ReviewPattern[];

	// Overall stats
	stats: AgentStats;
}

export interface ReviewPattern {
	pattern: string; // regex or keyword
	frequency: number;
	suggestion: string; // what to do instead
}

export interface AgentStats {
	totalTasks: number;
	completedTasks: number;
	mergedPRs: number;
	rejectedPRs: number;
	averageAttemptsToMerge: number;
	totalTokensUsed: number;
	totalCost: number;
	// Daily cost tracking (resets each day)
	dailyCost: number;
	dailyCostDate: string; // ISO date string (YYYY-MM-DD)
}

/**
 * Configuration for the agent
 */
export interface AgentConfig {
	// GitHub
	owner: string;
	repo: string;
	baseBranch: string;

	// Polling
	pollIntervalMs: number;

	// Issue selection
	issueLabels: string[]; // labels to pick up (e.g., "composer-task", "good-first-issue")
	maxConcurrentTasks: number;

	// Quality gates
	requireTests: boolean;
	requireLint: boolean;
	requireTypeCheck: boolean;
	selfReview: boolean;

	// Limits
	maxAttemptsPerTask: number;
	maxTokensPerTask: number;
	dailyBudget: number; // in dollars

	// Paths
	workingDir: string;
	memoryDir: string;

	// GitHub API / App / Webhooks
	githubApiUrl?: string;
	githubAppId?: string;
	githubAppPrivateKey?: string;
	githubAppPrivateKeyPath?: string;
	githubAppInstallationId?: number;
	webhookSecret?: string;
	webhookPort?: number;
	webhookPath?: string;
	webhookMode?: "poll" | "webhook" | "hybrid";
}

export const DEFAULT_CONFIG: Partial<AgentConfig> = {
	baseBranch: "main",
	pollIntervalMs: 60_000, // 1 minute
	issueLabels: ["composer-task"],
	maxConcurrentTasks: 1,
	requireTests: true,
	requireLint: true,
	requireTypeCheck: true,
	selfReview: true,
	maxAttemptsPerTask: 3,
	maxTokensPerTask: 500_000,
	dailyBudget: 50,
	webhookMode: "poll",
};
