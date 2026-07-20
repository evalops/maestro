/**
 * Git Branch Tracker - File-based git branch detection
 *
 * Reads .git/HEAD directly and optionally watches for changes,
 * providing a lightweight alternative to spawning git processes.
 *
 * @module tui/utils/git-branch-tracker
 */

import { type FSWatcher, existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

/**
 * Git branch tracking utility.
 * Reads .git/HEAD directly and optionally watches for changes.
 */
export class GitBranchTracker {
	private cachedBranch: string | null | undefined = undefined;
	private gitWatcher: FSWatcher | null = null;
	private onBranchChange: (() => void) | null = null;
	private cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
	}

	/**
	 * Set up a file watcher on .git/HEAD to detect branch changes.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.onBranchChange = onBranchChange;
		this.setupGitWatcher();
	}

	private setupGitWatcher(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		const gitHeadPath = join(this.cwd, ".git", "HEAD");
		if (!existsSync(gitHeadPath)) {
			return;
		}

		try {
			this.gitWatcher = watch(gitHeadPath, () => {
				this.cachedBranch = undefined;
				if (this.onBranchChange) {
					this.onBranchChange();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
	}

	/**
	 * Invalidate cached branch so it gets re-read on next call
	 */
	invalidate(): void {
		this.cachedBranch = undefined;
	}

	/**
	 * Get current git branch by reading .git/HEAD directly.
	 * Returns null if not in a git repo, branch name otherwise.
	 */
	getCurrentBranch(): string | null {
		if (this.cachedBranch !== undefined) {
			return this.cachedBranch;
		}

		try {
			const gitHeadPath = join(this.cwd, ".git", "HEAD");
			const content = readFileSync(gitHeadPath, "utf8").trim();

			if (content.startsWith("ref: refs/heads/")) {
				this.cachedBranch = content.slice(16);
			} else {
				// Detached HEAD state - show short hash
				this.cachedBranch = content.slice(0, 7);
			}
		} catch {
			this.cachedBranch = null;
		}

		return this.cachedBranch;
	}
}
