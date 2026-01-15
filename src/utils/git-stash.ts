/**
 * Git Stash Integration
 *
 * Automatically stashes changes before risky operations and restores them
 * on failure, providing a safety net for destructive edits.
 *
 * ## Features
 *
 * - Auto-stash before bulk edits
 * - Restore on failure or user request
 * - Track stash history per session
 * - Integration with undo system
 *
 * ## Usage
 *
 * ```typescript
 * import { gitStash } from "./git-stash.js";
 *
 * // Auto-stash before risky operation
 * const stashId = await gitStash.createSafetyStash("Before refactoring");
 *
 * try {
 *   await riskyOperation();
 *   await gitStash.dropStash(stashId);
 * } catch (error) {
 *   await gitStash.restoreStash(stashId);
 *   throw error;
 * }
 *
 * // Or use the wrapper
 * await gitStash.withSafetyStash("refactoring", async () => {
 *   await riskyOperation();
 * });
 * ```
 */

import { execSync, spawnSync } from "node:child_process";
import { createLogger } from "./logger.js";

const logger = createLogger("utils:git-stash");

/**
 * Stash entry record
 */
export interface StashEntry {
	id: string;
	message: string;
	timestamp: number;
	ref: string;
	files: string[];
	sessionId?: string;
}

/**
 * Git stash configuration
 */
export interface GitStashConfig {
	/** Working directory (default: process.cwd()) */
	cwd?: string;
	/** Include untracked files (default: true) */
	includeUntracked?: boolean;
	/** Include ignored files (default: false) */
	includeIgnored?: boolean;
	/** Auto-drop stash on successful operation (default: true) */
	autoDropOnSuccess?: boolean;
	/** Maximum stashes to keep per session (default: 10) */
	maxStashesPerSession?: number;
}

/**
 * Check if current directory is a git repository
 */
function isGitRepo(cwd: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", {
			cwd,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if there are changes to stash
 */
function hasChanges(cwd: string, includeUntracked: boolean): boolean {
	try {
		const result = spawnSync(
			"git",
			["status", "--porcelain", includeUntracked ? "-u" : "-uno"],
			{ cwd, encoding: "utf-8" },
		);
		return (result.stdout || "").trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Get list of changed files
 */
function getChangedFiles(cwd: string, includeUntracked: boolean): string[] {
	try {
		const result = spawnSync(
			"git",
			["status", "--porcelain", includeUntracked ? "-u" : "-uno"],
			{ cwd, encoding: "utf-8" },
		);
		return (result.stdout || "")
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => line.slice(3));
	} catch {
		return [];
	}
}

/**
 * Git stash manager
 */
class GitStashManager {
	private sessionStashes = new Map<string, StashEntry[]>();
	private currentSessionId: string | null = null;
	private config: GitStashConfig = {
		includeUntracked: true,
		includeIgnored: false,
		autoDropOnSuccess: true,
		maxStashesPerSession: 10,
	};

	/**
	 * Configure the stash manager
	 */
	configure(config: Partial<GitStashConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Set current session ID
	 */
	setSessionId(sessionId: string): void {
		this.currentSessionId = sessionId;
		if (!this.sessionStashes.has(sessionId)) {
			this.sessionStashes.set(sessionId, []);
		}
	}

	/**
	 * Create a safety stash before risky operations
	 */
	async createSafetyStash(message: string): Promise<string | null> {
		const cwd = this.config.cwd || process.cwd();

		if (!isGitRepo(cwd)) {
			logger.debug("Not a git repository, skipping stash");
			return null;
		}

		const includeUntracked = this.config.includeUntracked ?? true;
		if (!hasChanges(cwd, includeUntracked)) {
			logger.debug("No changes to stash");
			return null;
		}

		const files = getChangedFiles(cwd, includeUntracked);
		const timestamp = Date.now();
		const stashMessage = `[composer-safety] ${message} - ${new Date(timestamp).toISOString()}`;

		try {
			const args = ["stash", "push", "-m", stashMessage];
			if (includeUntracked) {
				args.push("--include-untracked");
			}
			if (this.config.includeIgnored) {
				args.push("--all");
			}

			execSync(`git ${args.join(" ")}`, { cwd, stdio: "pipe" });

			// Get the stash ref
			const refResult = spawnSync("git", ["stash", "list", "-n", "1"], {
				cwd,
				encoding: "utf-8",
			});
			const refMatch = (refResult.stdout || "").match(/^(stash@\{\d+\})/);
			const ref = refMatch ? refMatch[1]! : "stash@{0}";

			const stashId = `stash_${timestamp}`;
			const entry: StashEntry = {
				id: stashId,
				message,
				timestamp,
				ref,
				files,
				sessionId: this.currentSessionId || undefined,
			};

			// Track in session
			if (this.currentSessionId) {
				const sessionStashes = this.sessionStashes.get(this.currentSessionId) || [];
				sessionStashes.push(entry);
				this.sessionStashes.set(this.currentSessionId, sessionStashes);

				// Limit stashes per session
				const maxStashes = this.config.maxStashesPerSession || 10;
				if (sessionStashes.length > maxStashes) {
					const toRemove = sessionStashes.slice(0, sessionStashes.length - maxStashes);
					for (const old of toRemove) {
						await this.dropStash(old.id);
					}
				}
			}

			logger.info("Safety stash created", {
				stashId,
				message,
				files: files.length,
			});

			return stashId;
		} catch (error) {
			logger.error(
				"Failed to create stash",
				error instanceof Error ? error : undefined,
			);
			return null;
		}
	}

	/**
	 * Restore a stash by ID
	 */
	async restoreStash(stashId: string): Promise<boolean> {
		const cwd = this.config.cwd || process.cwd();
		const entry = this.findStashEntry(stashId);

		if (!entry) {
			logger.warn("Stash not found", { stashId });
			return false;
		}

		try {
			// Find current ref for this stash
			const currentRef = await this.findStashRef(entry.message, cwd);
			if (!currentRef) {
				logger.warn("Stash ref not found in git", { stashId });
				return false;
			}

			execSync(`git stash pop ${currentRef}`, { cwd, stdio: "pipe" });

			// Remove from tracking
			this.removeStashEntry(stashId);

			logger.info("Stash restored", { stashId, ref: currentRef });
			return true;
		} catch (error) {
			logger.error(
				"Failed to restore stash",
				error instanceof Error ? error : undefined,
				{ stashId },
			);
			return false;
		}
	}

	/**
	 * Drop a stash by ID
	 */
	async dropStash(stashId: string): Promise<boolean> {
		const cwd = this.config.cwd || process.cwd();
		const entry = this.findStashEntry(stashId);

		if (!entry) {
			logger.debug("Stash not found, already dropped", { stashId });
			return true;
		}

		try {
			const currentRef = await this.findStashRef(entry.message, cwd);
			if (currentRef) {
				execSync(`git stash drop ${currentRef}`, { cwd, stdio: "pipe" });
			}

			this.removeStashEntry(stashId);

			logger.debug("Stash dropped", { stashId });
			return true;
		} catch (error) {
			logger.warn("Failed to drop stash", { stashId, error });
			this.removeStashEntry(stashId);
			return false;
		}
	}

	/**
	 * Execute operation with safety stash
	 */
	async withSafetyStash<T>(
		operationName: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const stashId = await this.createSafetyStash(`Before ${operationName}`);

		try {
			const result = await fn();

			// Drop stash on success if configured
			if (stashId && this.config.autoDropOnSuccess) {
				await this.dropStash(stashId);
			}

			return result;
		} catch (error) {
			// Restore stash on failure
			if (stashId) {
				logger.info("Operation failed, restoring stash", { stashId });
				await this.restoreStash(stashId);
			}
			throw error;
		}
	}

	/**
	 * List stashes for current session
	 */
	listSessionStashes(): StashEntry[] {
		if (!this.currentSessionId) {
			return [];
		}
		return this.sessionStashes.get(this.currentSessionId) || [];
	}

	/**
	 * List all git stashes
	 */
	async listGitStashes(): Promise<Array<{ ref: string; message: string }>> {
		const cwd = this.config.cwd || process.cwd();

		if (!isGitRepo(cwd)) {
			return [];
		}

		try {
			const result = spawnSync("git", ["stash", "list"], {
				cwd,
				encoding: "utf-8",
			});

			return (result.stdout || "")
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const match = line.match(/^(stash@\{\d+\}):\s*(.+)$/);
					return {
						ref: match ? match[1]! : line,
						message: match ? match[2]! : line,
					};
				});
		} catch {
			return [];
		}
	}

	/**
	 * Find stash entry by ID
	 */
	private findStashEntry(stashId: string): StashEntry | undefined {
		for (const stashes of Array.from(this.sessionStashes.values())) {
			const entry = stashes.find((s) => s.id === stashId);
			if (entry) return entry;
		}
		return undefined;
	}

	/**
	 * Remove stash entry from tracking
	 */
	private removeStashEntry(stashId: string): void {
		for (const [sessionId, stashes] of Array.from(this.sessionStashes)) {
			const filtered = stashes.filter((s) => s.id !== stashId);
			if (filtered.length !== stashes.length) {
				this.sessionStashes.set(sessionId, filtered);
				return;
			}
		}
	}

	/**
	 * Find current git ref for a stash by message
	 */
	private async findStashRef(message: string, _cwd: string): Promise<string | null> {
		const stashes = await this.listGitStashes();
		const match = stashes.find((s) => s.message.includes(message));
		return match?.ref || null;
	}

	/**
	 * Get stash statistics
	 */
	getStats(): {
		sessionStashCount: number;
		totalTrackedStashes: number;
	} {
		let totalTracked = 0;
		for (const stashes of Array.from(this.sessionStashes.values())) {
			totalTracked += stashes.length;
		}

		return {
			sessionStashCount: this.currentSessionId
				? (this.sessionStashes.get(this.currentSessionId)?.length || 0)
				: 0,
			totalTrackedStashes: totalTracked,
		};
	}

	/**
	 * Clear all tracked stashes for a session
	 */
	clearSession(sessionId: string): void {
		this.sessionStashes.delete(sessionId);
	}

	/**
	 * Reset manager state
	 */
	reset(): void {
		this.sessionStashes.clear();
		this.currentSessionId = null;
	}
}

/**
 * Global git stash manager instance
 */
export const gitStash = new GitStashManager();

/**
 * Quick wrapper for operations with safety stash
 */
export async function withSafetyStash<T>(
	operationName: string,
	fn: () => Promise<T>,
): Promise<T> {
	return gitStash.withSafetyStash(operationName, fn);
}
