/**
 * Nested Agent Guard
 *
 * Prevents CPU exhaustion from agents spawning nested instances of themselves.
 * This addresses the issue where Claude Code (or similar tools) can inadvertently
 * spawn child instances through bash commands, leading to exponential resource usage.
 *
 * ## Detection Methods
 *
 * 1. **Environment Variable**: Sets COMPOSER_PARENT_PID on startup, child processes
 *    can detect they're running inside a parent instance.
 *
 * 2. **Process Tree Analysis**: Tracks child process spawns and detects recursive patterns.
 *
 * 3. **Command Pattern Detection**: Identifies commands that would spawn nested agents.
 *
 * ## Usage
 *
 * ```typescript
 * import { nestedAgentGuard } from "./nested-agent-guard.js";
 *
 * // On startup
 * nestedAgentGuard.initialize();
 *
 * // Check if we're nested
 * if (nestedAgentGuard.isNestedInstance()) {
 *   console.warn("Running inside another agent instance");
 * }
 *
 * // Before spawning commands
 * const check = nestedAgentGuard.checkCommand("claude --help");
 * if (!check.allowed) {
 *   console.error(check.reason);
 * }
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:nested-agent-guard");

/**
 * Environment variable set by parent agent instances.
 */
const PARENT_PID_ENV = "COMPOSER_PARENT_PID";
const AGENT_DEPTH_ENV = "COMPOSER_AGENT_DEPTH";
const MAX_AGENT_DEPTH = 2; // Allow one level of nesting for legitimate use cases

/**
 * Command patterns that spawn agent instances.
 */
const AGENT_SPAWN_PATTERNS = [
	// Composer/Claude Code patterns
	/\bcomposer\b/i,
	/\bclaude\b/i,
	/\bclaude-code\b/i,
	/\bcc\s/i, // cc alias

	// Other agent CLI tools
	/\baider\b/i,
	/\bcursor\b/i,
	/\bcontinue\b/i,
	/\bcody\b/i,
	/\bcopilot\b/i,

	// Generic agent spawn patterns
	/\bagent\s+run\b/i,
	/\bagent\s+start\b/i,
	/--agent\b/i,
];

/**
 * Patterns that indicate intentional recursive spawning (higher risk).
 */
const HIGH_RISK_PATTERNS = [
	// Running in a loop
	/while.*composer/i,
	/for.*composer/i,
	/xargs.*composer/i,

	// Background spawning
	/composer.*&\s*$/,
	/nohup.*composer/i,

	// Multiple instances
	/composer.*&&.*composer/i,
	/composer.*\|\|.*composer/i,
];

interface CommandCheckResult {
	allowed: boolean;
	reason?: string;
	severity: "info" | "warning" | "error";
	pattern?: string;
}

interface ChildProcessRecord {
	pid: number;
	command: string;
	timestamp: number;
	isAgentSpawn: boolean;
}

/**
 * Nested agent guard implementation.
 */
class NestedAgentGuard {
	private initialized = false;
	private isNested = false;
	private agentDepth = 0;
	private parentPid: number | null = null;
	private childProcesses: ChildProcessRecord[] = [];
	private agentSpawnCount = 0;
	private readonly maxAgentSpawns = 3; // Max agent spawns per session
	private readonly childProcessWindowMs = 60_000; // 1 minute window

	/**
	 * Initialize the guard on startup.
	 * Sets environment variables for child processes.
	 */
	initialize(): void {
		if (this.initialized) return;

		// Check if we're running inside another agent
		const parentPidStr = process.env[PARENT_PID_ENV];
		const depthStr = process.env[AGENT_DEPTH_ENV];

		if (parentPidStr) {
			this.parentPid = Number.parseInt(parentPidStr, 10);
			this.isNested = !Number.isNaN(this.parentPid);
		}

		if (depthStr) {
			this.agentDepth = Number.parseInt(depthStr, 10);
			if (Number.isNaN(this.agentDepth)) {
				this.agentDepth = 0;
			}
		}

		// Set environment for our children
		process.env[PARENT_PID_ENV] = String(process.pid);
		process.env[AGENT_DEPTH_ENV] = String(this.agentDepth + 1);

		if (this.isNested) {
			logger.warn("Running as nested agent instance", {
				parentPid: this.parentPid,
				depth: this.agentDepth,
			});
		}

		this.initialized = true;
	}

	/**
	 * Check if this instance is running inside another agent.
	 */
	isNestedInstance(): boolean {
		return this.isNested;
	}

	/**
	 * Get the current nesting depth.
	 */
	getDepth(): number {
		return this.agentDepth;
	}

	/**
	 * Check if nesting depth is at or above the limit.
	 */
	isAtMaxDepth(): boolean {
		return this.agentDepth >= MAX_AGENT_DEPTH;
	}

	/**
	 * Check if a command would spawn a nested agent.
	 */
	checkCommand(command: string): CommandCheckResult {
		// Clean up old child process records
		this.cleanupOldRecords();

		// Check for high-risk patterns first
		for (const pattern of HIGH_RISK_PATTERNS) {
			if (pattern.test(command)) {
				logger.warn("High-risk nested agent spawn pattern detected", {
					commandPreview: command.slice(0, 100),
					patternSource: pattern.source,
				});
				return {
					allowed: false,
					reason:
						"Blocked: Command matches high-risk recursive agent spawn pattern. This could cause CPU exhaustion.",
					severity: "error",
					pattern: pattern.source,
				};
			}
		}

		// Check for agent spawn patterns
		for (const pattern of AGENT_SPAWN_PATTERNS) {
			if (pattern.test(command)) {
				// Check depth limit
				if (this.isAtMaxDepth()) {
					logger.warn("Agent spawn blocked due to depth limit", {
						command: command.slice(0, 100),
						depth: this.agentDepth,
						maxDepth: MAX_AGENT_DEPTH,
					});
					return {
						allowed: false,
						reason: `Blocked: Maximum agent nesting depth (${MAX_AGENT_DEPTH}) reached. Cannot spawn another agent instance.`,
						severity: "error",
						pattern: pattern.source,
					};
				}

				// Check spawn count limit
				if (this.agentSpawnCount >= this.maxAgentSpawns) {
					logger.warn("Agent spawn blocked due to count limit", {
						command: command.slice(0, 100),
						spawnCount: this.agentSpawnCount,
						maxSpawns: this.maxAgentSpawns,
					});
					return {
						allowed: false,
						reason: `Blocked: Maximum agent spawns (${this.maxAgentSpawns}) reached in this session. This prevents runaway process spawning.`,
						severity: "error",
						pattern: pattern.source,
					};
				}

				// Allow but warn
				logger.info("Agent spawn command detected", {
					command: command.slice(0, 100),
					pattern: pattern.source,
					depth: this.agentDepth,
					spawnCount: this.agentSpawnCount,
				});

				return {
					allowed: true,
					reason: "Warning: This command may spawn a nested agent instance.",
					severity: "warning",
					pattern: pattern.source,
				};
			}
		}

		return { allowed: true, severity: "info" };
	}

	/**
	 * Record a child process spawn.
	 */
	recordChildProcess(
		pid: number,
		command: string,
		isAgentSpawn: boolean,
	): void {
		this.childProcesses.push({
			pid,
			command,
			timestamp: Date.now(),
			isAgentSpawn,
		});

		if (isAgentSpawn) {
			this.agentSpawnCount++;
			logger.info("Agent child process spawned", {
				pid,
				command: command.slice(0, 100),
				totalAgentSpawns: this.agentSpawnCount,
			});
		}
	}

	/**
	 * Clean up old child process records.
	 */
	private cleanupOldRecords(): void {
		const cutoff = Date.now() - this.childProcessWindowMs;
		const before = this.childProcesses.length;
		this.childProcesses = this.childProcesses.filter(
			(r) => r.timestamp > cutoff,
		);
		const removed = before - this.childProcesses.length;
		if (removed > 0) {
			logger.debug("Cleaned up child process records", { removed });
		}
	}

	/**
	 * Get statistics about child processes.
	 */
	getStats(): {
		isNested: boolean;
		depth: number;
		parentPid: number | null;
		agentSpawnCount: number;
		recentChildProcesses: number;
	} {
		this.cleanupOldRecords();
		return {
			isNested: this.isNested,
			depth: this.agentDepth,
			parentPid: this.parentPid,
			agentSpawnCount: this.agentSpawnCount,
			recentChildProcesses: this.childProcesses.length,
		};
	}

	/**
	 * Reset spawn count (e.g., for testing or manual override).
	 */
	resetSpawnCount(): void {
		this.agentSpawnCount = 0;
		logger.info("Agent spawn count reset");
	}

	/**
	 * Check if spawning another agent is allowed.
	 */
	canSpawnAgent(): boolean {
		return !this.isAtMaxDepth() && this.agentSpawnCount < this.maxAgentSpawns;
	}
}

/**
 * Global nested agent guard instance.
 */
export const nestedAgentGuard = new NestedAgentGuard();

/**
 * Utility function to check if a bash command should be allowed.
 * Returns an error message if blocked, or null if allowed.
 */
export function checkBashCommandForNestedAgent(command: string): string | null {
	const result = nestedAgentGuard.checkCommand(command);
	if (!result.allowed) {
		return result.reason ?? "Command blocked due to nested agent detection";
	}
	return null;
}
