import { spawnSync } from "node:child_process";

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
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

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

	const ahead = Number.parseInt(parts[0], 10);
	const behind = Number.parseInt(parts[1], 10);

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
