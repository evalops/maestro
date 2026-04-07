/**
 * Git Utilities - Repository State and Information Helpers
 *
 * This module provides utilities for querying Git repository state,
 * including branch information, commit history, and working tree status.
 * It uses synchronous spawns for reliability in various contexts.
 *
 * ## Key Functions
 *
 * | Function                 | Description                          |
 * |--------------------------|--------------------------------------|
 * | isInsideGitRepository()  | Check if cwd is in a git repo        |
 * | getGitState()            | Get comprehensive repository state   |
 * | getCurrentCommitSha()    | Get current commit SHA               |
 * | getCurrentBranch()       | Get current branch name              |
 * | hasUncommittedChanges()  | Check for uncommitted changes        |
 * | getUpstreamStatus()      | Get ahead/behind counts              |
 *
 * ## GitState Interface
 *
 * The `getGitState()` function returns:
 * - `isRepo`: Whether in a git repository
 * - `branch`: Current branch name
 * - `commitSha`: Full 40-character SHA
 * - `shortSha`: Abbreviated 7-character SHA
 * - `isDirty`: Whether there are uncommitted changes
 * - `ahead`/`behind`: Commit counts relative to upstream
 * - `upstream`: Remote tracking branch name
 *
 * ## Example
 *
 * ```typescript
 * import { getGitState } from './git';
 *
 * const state = getGitState();
 * if (state.isRepo) {
 *   console.log(`On branch ${state.branch} at ${state.shortSha}`);
 *   if (state.isDirty) {
 *     console.log('Working tree has uncommitted changes');
 *   }
 * }
 * ```
 *
 * @module utils/git
 */

import { spawnSync } from "node:child_process";

const DEFAULT_GIT_STATUS_MAX_CHARS = 2000;
const DEFAULT_GIT_RECENT_COMMIT_COUNT = 5;

function runGitText(
	cwd: string,
	args: string[],
): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	return {
		ok: !result.error && result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

function truncateGitText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, maxChars)}\n... (truncated because it exceeds ${maxChars} characters. Run git status for full output.)`;
}

export function isInsideGitRepository(cwd: string = process.cwd()): boolean {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error || result.status !== 0) {
		return false;
	}

	return (result.stdout ?? "").trim() === "true";
}

/**
 * Git state information for tracking repository context.
 */
export interface GitState {
	/** Whether currently inside a git repository */
	isRepo: boolean;
	/** Current branch name */
	branch?: string;
	/** Current commit SHA (full 40-char) */
	commitSha?: string;
	/** Short commit SHA (7 chars) */
	shortSha?: string;
	/** Whether there are uncommitted changes */
	isDirty?: boolean;
	/** Number of commits ahead of upstream */
	ahead?: number;
	/** Number of commits behind upstream */
	behind?: number;
	/** Remote tracking branch (e.g., "origin/main") */
	upstream?: string;
}

export interface GitSnapshotOptions {
	maxStatusChars?: number;
	recentCommitCount?: number;
}

export function getDefaultBranch(
	cwd: string = process.cwd(),
): string | undefined {
	const remoteHead = runGitText(cwd, [
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	if (remoteHead.ok && remoteHead.stdout) {
		const branch = remoteHead.stdout.replace(/^origin\//, "").trim();
		if (branch) {
			return branch;
		}
	}

	const configuredDefault = runGitText(cwd, ["config", "init.defaultBranch"]);
	if (configuredDefault.ok && configuredDefault.stdout) {
		return configuredDefault.stdout;
	}

	return undefined;
}

export function getGitUserName(
	cwd: string = process.cwd(),
): string | undefined {
	const result = runGitText(cwd, ["config", "user.name"]);
	return result.ok && result.stdout ? result.stdout : undefined;
}

/**
 * Get the current commit SHA.
 */
export function getCommitSha(cwd: string = process.cwd()): string | undefined {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error || result.status !== 0) {
		return undefined;
	}

	return (result.stdout ?? "").trim() || undefined;
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(
	cwd: string = process.cwd(),
): string | undefined {
	const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error || result.status !== 0) {
		return undefined;
	}

	const branch = (result.stdout ?? "").trim();
	return branch === "HEAD" ? undefined : branch || undefined;
}

/**
 * Check if there are uncommitted changes (dirty working tree).
 */
export function isDirtyWorkingTree(cwd: string = process.cwd()): boolean {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "status", "--porcelain"],
		{
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	if (result.error || result.status !== 0) {
		return false;
	}

	return (result.stdout ?? "").trim().length > 0;
}

/**
 * Get ahead/behind counts relative to upstream.
 */
export function getAheadBehind(
	cwd: string = process.cwd(),
): { ahead: number; behind: number; upstream: string } | undefined {
	// Get the upstream tracking branch
	const upstreamResult = spawnSync(
		"git",
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
		{
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	if (upstreamResult.error || upstreamResult.status !== 0) {
		return undefined;
	}

	const upstream = (upstreamResult.stdout ?? "").trim();
	if (!upstream) {
		return undefined;
	}

	// Get ahead/behind counts
	const countResult = spawnSync(
		"git",
		["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
		{
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	if (countResult.error || countResult.status !== 0) {
		return undefined;
	}

	const output = (countResult.stdout ?? "").trim();
	const parts = output.split(/\s+/);
	if (parts.length !== 2) {
		return undefined;
	}

	const ahead = Number.parseInt(parts[0]!, 10);
	const behind = Number.parseInt(parts[1]!, 10);

	if (Number.isNaN(ahead) || Number.isNaN(behind)) {
		return undefined;
	}

	return { ahead, behind, upstream };
}

/**
 * Get comprehensive git state for the current repository.
 * Used for tracking repository context in sessions and telemetry.
 */
export function getGitState(cwd: string = process.cwd()): GitState {
	const isRepo = isInsideGitRepository(cwd);

	if (!isRepo) {
		return { isRepo: false };
	}

	const commitSha = getCommitSha(cwd);
	const branch = getCurrentBranch(cwd);
	const isDirty = isDirtyWorkingTree(cwd);
	const aheadBehind = getAheadBehind(cwd);

	return {
		isRepo: true,
		branch,
		commitSha,
		shortSha: commitSha?.slice(0, 7),
		isDirty,
		ahead: aheadBehind?.ahead,
		behind: aheadBehind?.behind,
		upstream: aheadBehind?.upstream,
	};
}

/**
 * Get the root directory of the git repository.
 */
export function getGitRoot(cwd: string = process.cwd()): string | undefined {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error || result.status !== 0) {
		return undefined;
	}

	return (result.stdout ?? "").trim() || undefined;
}

export function getGitSnapshot(
	cwd: string = process.cwd(),
	options: GitSnapshotOptions = {},
): string | null {
	const state = getGitState(cwd);
	if (!state.isRepo) {
		return null;
	}

	const maxStatusChars = options.maxStatusChars ?? DEFAULT_GIT_STATUS_MAX_CHARS;
	const recentCommitCount =
		options.recentCommitCount ?? DEFAULT_GIT_RECENT_COMMIT_COUNT;

	const statusResult = runGitText(cwd, [
		"--no-optional-locks",
		"status",
		"--short",
	]);
	const logResult = runGitText(cwd, [
		"--no-optional-locks",
		"log",
		"--oneline",
		"-n",
		String(recentCommitCount),
	]);

	const statusText = statusResult.ok
		? truncateGitText(statusResult.stdout || "(clean)", maxStatusChars)
		: "(git status unavailable)";
	const recentCommits = logResult.ok
		? logResult.stdout || "(no commits yet)"
		: "(git log unavailable)";

	const branch = state.branch ?? "(detached HEAD)";
	const defaultBranch = getDefaultBranch(cwd);
	const gitUser = getGitUserName(cwd);
	const upstream = state.upstream
		? `Upstream: ${state.upstream} (ahead ${state.ahead ?? 0}, behind ${state.behind ?? 0})`
		: "Upstream: (none)";
	const workingTree = state.isDirty ? "dirty" : "clean";

	return [
		"# Repository Snapshot",
		"This is the git status snapshot at the start of the session. It does not update automatically during the conversation.",
		`Current branch: ${branch}`,
		`Main branch (usually the PR target): ${defaultBranch ?? "(unknown)"}`,
		...(gitUser ? ["Git user is configured for this repository."] : []),
		upstream,
		`Working tree: ${workingTree}`,
		`Status:\n${statusText}`,
		`Recent commits:\n${recentCommits}`,
	].join("\n\n");
}
