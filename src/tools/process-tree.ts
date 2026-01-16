/**
 * Process Tree Management - Comprehensive process lifecycle control
 *
 * This module provides robust process tree killing and orphan process prevention.
 * It addresses common issues with process management:
 *
 * 1. **Orphan Processes**: Children that survive parent termination
 * 2. **Zombie Processes**: Dead processes waiting for parent to read exit status
 * 3. **Process Group Escapes**: Children that create new process groups
 * 4. **Graceful Shutdown**: Giving processes time to clean up before force kill
 *
 * ## Strategy
 *
 * 1. Build a complete tree of descendant PIDs using OS-specific methods
 * 2. Send SIGTERM to allow graceful shutdown
 * 3. Wait briefly for processes to exit
 * 4. Send SIGKILL to force termination of remaining processes
 * 5. Track spawned processes in a registry for session cleanup
 *
 * @module tools/process-tree
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tools:process-tree");

/**
 * Process info from system queries
 */
interface ProcessInfo {
	pid: number;
	ppid: number;
	command?: string;
}

/**
 * Registry of spawned processes for tracking
 */
class ProcessRegistry {
	private processes = new Map<
		number,
		{
			pid: number;
			startTime: number;
			command?: string;
			children: Set<number>;
		}
	>();

	private cleanupInterval: NodeJS.Timeout | null = null;

	constructor() {
		// Periodically clean up dead processes
		this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
		// Don't keep the event loop alive just for background cleanup.
		if (this.cleanupInterval.unref) {
			this.cleanupInterval.unref();
		}
	}

	/**
	 * Register a spawned process
	 */
	register(pid: number, command?: string): void {
		this.processes.set(pid, {
			pid,
			startTime: Date.now(),
			command,
			children: new Set(),
		});
	}

	/**
	 * Unregister a process (on clean exit)
	 */
	unregister(pid: number): void {
		this.processes.delete(pid);
	}

	/**
	 * Get all registered PIDs
	 */
	getAllPids(): number[] {
		return Array.from(this.processes.keys());
	}

	/**
	 * Check if a process is registered
	 */
	isRegistered(pid: number): boolean {
		return this.processes.has(pid);
	}

	/**
	 * Clean up dead processes from registry
	 */
	cleanup(): void {
		for (const pid of this.processes.keys()) {
			if (!isProcessAlive(pid)) {
				this.processes.delete(pid);
			}
		}
	}

	/**
	 * Kill all registered processes
	 */
	async killAll(): Promise<void> {
		const pids = this.getAllPids();
		if (pids.length === 0) return;

		logger.info("Killing all registered processes", { count: pids.length });

		for (const pid of pids) {
			await killProcessTreeGracefully(pid);
			this.unregister(pid);
		}
	}

	/**
	 * Stop the cleanup interval
	 */
	dispose(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}
}

/**
 * Global process registry instance
 */
export const processRegistry = new ProcessRegistry();

/**
 * Check if a process is still alive
 */
export function isProcessAlive(pid: number): boolean {
	if (pid <= 0) return false;

	try {
		// Signal 0 doesn't actually send a signal, just checks if process exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get all descendant PIDs of a process (Linux)
 */
function getDescendantPidsLinux(pid: number): number[] {
	const descendants: number[] = [];
	const procPath = "/proc";

	if (!existsSync(procPath)) {
		return descendants;
	}

	try {
		// Build a map of ppid -> children
		const children = new Map<number, number[]>();

		const entries = readdirSync(procPath);
		for (const entry of entries) {
			// Only process numeric directories (PIDs)
			if (!/^\d+$/.test(entry)) continue;

			const statPath = `${procPath}/${entry}/stat`;
			if (!existsSync(statPath)) continue;

			try {
				const stat = readFileSync(statPath, "utf-8");
				// Format: pid (comm) state ppid ...
				// The comm can contain spaces and parentheses, so parse carefully
				const match = stat.match(/^\d+\s+\([^)]*\)\s+\S+\s+(\d+)/);
				if (match) {
					const ppid = Number.parseInt(match[1]!, 10);
					const childPid = Number.parseInt(entry, 10);

					if (!children.has(ppid)) {
						children.set(ppid, []);
					}
					children.get(ppid)!.push(childPid);
				}
			} catch {
				// Skip unreadable process
			}
		}

		// BFS to find all descendants
		const queue = [pid];
		while (queue.length > 0) {
			const current = queue.shift()!;
			const childPids = children.get(current) || [];
			for (const childPid of childPids) {
				if (childPid !== pid) {
					descendants.push(childPid);
					queue.push(childPid);
				}
			}
		}
	} catch (error) {
		logger.debug("Failed to read /proc for descendants", {
			pid,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return descendants;
}

/**
 * Get all descendant PIDs of a process (macOS)
 */
function getDescendantPidsMacOS(pid: number): number[] {
	const descendants: number[] = [];

	try {
		// Use pgrep to find child processes recursively
		// First, get direct children
		const result = spawnSync("pgrep", ["-P", String(pid)], {
			encoding: "utf-8",
			timeout: 5000,
		});

		if (result.stdout) {
			const childPids = result.stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => Number.parseInt(line, 10))
				.filter((p) => !Number.isNaN(p) && p > 0);

			descendants.push(...childPids);

			// Recursively get descendants of each child
			for (const childPid of childPids) {
				descendants.push(...getDescendantPidsMacOS(childPid));
			}
		}
	} catch (error) {
		logger.debug("Failed to get descendants via pgrep", {
			pid,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return descendants;
}

/**
 * Get all descendant PIDs of a process (cross-platform)
 */
export function getDescendantPids(pid: number): number[] {
	if (pid <= 0) return [];

	if (process.platform === "darwin") {
		return getDescendantPidsMacOS(pid);
	}

	if (process.platform === "linux") {
		return getDescendantPidsLinux(pid);
	}

	// Windows - use tasklist
	if (process.platform === "win32") {
		try {
			// wmic process where parentprocessid=PID get processid
			const result = execSync(
				`wmic process where parentprocessid=${pid} get processid`,
				{
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);

			const childPids = result
				.split("\n")
				.slice(1) // Skip header
				.map((line) => Number.parseInt(line.trim(), 10))
				.filter((p) => !Number.isNaN(p) && p > 0);

			const descendants = [...childPids];
			for (const childPid of childPids) {
				descendants.push(...getDescendantPids(childPid));
			}
			return descendants;
		} catch {
			return [];
		}
	}

	return [];
}

/**
 * Send a signal to a process, ignoring errors
 */
function safeKill(pid: number, signal: NodeJS.Signals): boolean {
	if (pid <= 0 || pid === 1) return false;

	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait for a process to exit, with timeout
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	const checkInterval = 50; // Check every 50ms

	while (Date.now() - start < timeoutMs) {
		if (!isProcessAlive(pid)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, checkInterval));
	}

	return !isProcessAlive(pid);
}

/**
 * Kill a process tree gracefully
 *
 * Strategy:
 * 1. Get all descendant PIDs
 * 2. Send SIGTERM to all processes (bottom-up, children first)
 * 3. Wait briefly for graceful exit
 * 4. Send SIGKILL to any remaining processes
 *
 * @param pid - Root process ID to kill
 * @param gracePeriodMs - Time to wait for graceful exit (default: 1000ms)
 */
export async function killProcessTreeGracefully(
	pid: number,
	gracePeriodMs = 1000,
): Promise<{
	killed: number[];
	failed: number[];
}> {
	const result = {
		killed: [] as number[],
		failed: [] as number[],
	};

	if (pid <= 0 || pid === 1) {
		return result;
	}

	// Get all descendants first (before we start killing)
	const descendants = getDescendantPids(pid);

	// Kill in reverse order (children before parents)
	const allPids = [...descendants.reverse(), pid];

	logger.debug("Killing process tree", {
		rootPid: pid,
		totalProcesses: allPids.length,
		descendants: descendants.length,
	});

	// Phase 1: SIGTERM to all
	for (const targetPid of allPids) {
		safeKill(targetPid, "SIGTERM");
	}

	// Phase 2: Wait for graceful exit
	await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));

	// Phase 3: SIGKILL any remaining
	for (const targetPid of allPids) {
		if (isProcessAlive(targetPid)) {
			if (safeKill(targetPid, "SIGKILL")) {
				// Give a brief moment for SIGKILL to take effect
				await waitForExit(targetPid, 100);
			}
		}

		if (!isProcessAlive(targetPid)) {
			result.killed.push(targetPid);
		} else {
			result.failed.push(targetPid);
		}
	}

	if (result.failed.length > 0) {
		logger.warn("Some processes could not be killed", {
			failed: result.failed,
		});
	}

	return result;
}

/**
 * Kill a process tree immediately (SIGKILL only)
 *
 * Use this when graceful shutdown is not needed.
 */
export function killProcessTreeImmediate(pid: number): void {
	if (pid <= 0 || pid === 1) return;

	// First try process group kill (most efficient)
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {
			// Process may not be a group leader, fall through to manual tree kill
		}
	}

	// Manual tree kill
	const descendants = getDescendantPids(pid);
	const allPids = [...descendants.reverse(), pid];

	for (const targetPid of allPids) {
		safeKill(targetPid, "SIGKILL");
	}
}

/**
 * Register process exit handler to clean up spawned processes
 */
export function registerCleanupHandler(): void {
	const cleanup = async () => {
		logger.info("Process exit detected, cleaning up spawned processes");
		await processRegistry.killAll();
		processRegistry.dispose();
	};

	// Handle normal exit
	process.on("exit", () => {
		// Can't do async in exit handler, do sync cleanup
		const pids = processRegistry.getAllPids();
		for (const pid of pids) {
			killProcessTreeImmediate(pid);
		}
	});

	// Handle signals
	process.on("SIGINT", async () => {
		await cleanup();
		process.exit(130);
	});

	process.on("SIGTERM", async () => {
		await cleanup();
		process.exit(143);
	});

	// Handle uncaught exceptions
	process.on("uncaughtException", async (error) => {
		logger.error("Uncaught exception, cleaning up", error);
		await cleanup();
		process.exit(1);
	});
}

/**
 * Find orphaned processes that were spawned by us but are now parentless
 */
export function findOrphanedProcesses(): number[] {
	const registeredPids = processRegistry.getAllPids();
	const orphans: number[] = [];

	for (const pid of registeredPids) {
		if (!isProcessAlive(pid)) continue;

		// Check if parent is init (PID 1) - indicates orphan
		try {
			if (process.platform === "linux") {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
				const match = stat.match(/^\d+\s+\([^)]*\)\s+\S+\s+(\d+)/);
				if (match && Number.parseInt(match[1]!, 10) === 1) {
					orphans.push(pid);
				}
			} else if (process.platform === "darwin") {
				const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
					encoding: "utf-8",
					timeout: 1000,
				});
				if (result.stdout && Number.parseInt(result.stdout.trim(), 10) === 1) {
					orphans.push(pid);
				}
			}
		} catch {
			// Can't check, assume not orphaned
		}
	}

	return orphans;
}

/**
 * Kill any orphaned processes from our registry
 */
export async function cleanupOrphanedProcesses(): Promise<number> {
	const orphans = findOrphanedProcesses();

	if (orphans.length === 0) {
		return 0;
	}

	logger.warn("Found orphaned processes, cleaning up", {
		count: orphans.length,
		pids: orphans,
	});

	for (const pid of orphans) {
		await killProcessTreeGracefully(pid, 500);
		processRegistry.unregister(pid);
	}

	return orphans.length;
}
