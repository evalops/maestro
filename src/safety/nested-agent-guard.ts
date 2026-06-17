/**
 * Nested Agent Guard
 *
 * Prevents CPU exhaustion from agents spawning nested instances of themselves.
 * This addresses the issue where Claude Code (or similar tools) can inadvertently
 * spawn child instances through bash commands, leading to exponential resource usage.
 *
 * ## Detection Methods
 *
 * 1. **Environment Variable**: Sets MAESTRO_PARENT_PID on startup, child processes
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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getComposerHome } from "../config/constants.js";
import { writePrivateFileSync } from "../oauth/private-file.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:nested-agent-guard");

/**
 * Environment variable set by parent agent instances.
 */
const PARENT_PID_ENV = "MAESTRO_PARENT_PID";
const AGENT_DEPTH_ENV = "MAESTRO_AGENT_DEPTH";
/**
 * HMAC-signed depth token (#2481 part 2). The signature binds the
 * claimed depth value to a per-host secret stored in
 * `<MAESTRO_HOME>/.runtime-trust-key` (mode 0o600). A child cannot
 * fabricate a lower depth by setting `MAESTRO_AGENT_DEPTH=0` because
 * the signature wouldn't verify — it would need the trust key.
 *
 * Stripping the env entirely is still possible
 * (`unset MAESTRO_AGENT_DEPTH MAESTRO_AGENT_DEPTH_TOKEN`), but in that
 * case the PPID-fallback below fires: if our parent process is
 * itself an agent binary we treat ourselves as nested at max depth
 * regardless of the env.
 */
const AGENT_DEPTH_TOKEN_ENV = "MAESTRO_AGENT_DEPTH_TOKEN";
const MAX_AGENT_DEPTH = 2; // Allow one level of nesting for legitimate use cases

function getTrustKeyPath(): string {
	return join(getComposerHome(), ".runtime-trust-key");
}

/**
 * Load (or lazily create) the per-host HMAC key used to sign depth
 * claims. The key is 32 random bytes, persisted with mode 0o600 so
 * other local users cannot read it. Persistent because child agent
 * processes need to verify signatures their parent created and to
 * sign their own outgoing tokens.
 */
function getOrCreateTrustKey(): Buffer {
	const keyPath = getTrustKeyPath();
	if (existsSync(keyPath)) {
		try {
			const hex = readFileSync(keyPath, "utf-8").trim();
			if (hex.length === 64) {
				return Buffer.from(hex, "hex");
			}
		} catch (error) {
			logger.warn("Failed to read runtime trust key; rotating", {
				errorType: error instanceof Error ? error.name : "unknown",
			});
		}
	}
	const dir = dirname(keyPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const fresh = randomBytes(32);
	writePrivateFileSync(keyPath, fresh.toString("hex"));
	try {
		chmodSync(keyPath, 0o600);
	} catch {
		// Best-effort — writePrivateFileSync already applies 0o600.
	}
	return fresh;
}

function signDepth(depth: number, key: Buffer): string {
	const mac = createHmac("sha256", key).update(String(depth)).digest("hex");
	return `${depth}.${mac}`;
}

function verifyDepth(token: string, key: Buffer): number | null {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const claimedStr = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const depth = Number.parseInt(claimedStr, 10);
	if (Number.isNaN(depth) || depth < 0) return null;
	const expected = createHmac("sha256", key).update(String(depth)).digest();
	// Decode the supplied signature to a buffer of the same length as
	// `expected`. A wrong length is a verification failure, but we
	// still feed `timingSafeEqual` two equal-length buffers so the
	// length-mismatch path does not leak via early-return timing.
	let sigBuf: Buffer;
	try {
		sigBuf = Buffer.from(sig, "hex");
	} catch {
		sigBuf = Buffer.alloc(0);
	}
	const padded =
		sigBuf.length === expected.length ? sigBuf : Buffer.alloc(expected.length);
	const matched = timingSafeEqual(expected, padded);
	return matched && sigBuf.length === expected.length ? depth : null;
}

/**
 * Command patterns that spawn agent instances.
 */
const AGENT_SPAWN_PATTERNS = [
	// Maestro/Claude Code patterns
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
	/**
	 * Generic descendant-process counter. Tracks every bash command
	 * the guard sees, not just commands that match an agent-spawn
	 * regex. This is the fail-closed defense against fork bombs that
	 * obfuscate the agent-spawn so the regex never matches: even if
	 * we can't tell what they're running, we cap the total number of
	 * subprocesses per session (#2481).
	 */
	private totalBashSpawnCount = 0;
	/**
	 * Rolling window of bash-spawn timestamps. Used to enforce a
	 * spawn-rate cap independent of total count, so a slow-burn fork
	 * bomb still triggers.
	 */
	private bashSpawnTimestamps: number[] = [];
	private readonly maxAgentSpawns = 3; // Max agent spawns per session
	private readonly childProcessWindowMs = 60_000; // 1 minute window
	private readonly maxTotalBashSpawns = 500; // Hard cap per session
	private readonly maxBashSpawnsPerMinute = 120; // Rate cap

	/**
	 * Initialize the guard on startup.
	 * Sets environment variables for child processes.
	 */
	initialize(): void {
		if (this.initialized) return;

		// Read the inherited env. The token binds depth to the host
		// trust key, so a child cannot lower its depth without the key.
		const parentPidStr = process.env[PARENT_PID_ENV];
		const depthStr = process.env[AGENT_DEPTH_ENV];
		const tokenStr = process.env[AGENT_DEPTH_TOKEN_ENV];

		if (parentPidStr) {
			this.parentPid = Number.parseInt(parentPidStr, 10);
			this.isNested = !Number.isNaN(this.parentPid);
		}

		let key: Buffer;
		try {
			key = getOrCreateTrustKey();
		} catch (error) {
			// If we can't acquire the trust key for any reason, fail
			// closed: assume we're at max depth so spawn-checks block.
			logger.warn("Failed to acquire runtime trust key; failing closed", {
				errorType: error instanceof Error ? error.name : "unknown",
			});
			this.agentDepth = MAX_AGENT_DEPTH;
			this.isNested = true;
			process.env[PARENT_PID_ENV] = String(process.pid);
			process.env[AGENT_DEPTH_ENV] = String(MAX_AGENT_DEPTH);
			this.initialized = true;
			return;
		}

		if (tokenStr) {
			const verified = verifyDepth(tokenStr, key);
			if (verified === null) {
				// Token present but doesn't verify — someone tampered.
				// Fail closed at max depth so we refuse to spawn further.
				logger.warn(
					"MAESTRO_AGENT_DEPTH_TOKEN failed to verify; failing closed at max depth",
				);
				this.agentDepth = MAX_AGENT_DEPTH;
				this.isNested = true;
			} else {
				this.agentDepth = verified;
				this.isNested = true;
			}
		} else if (depthStr) {
			// Depth claimed without a signing token. Older releases
			// didn't issue tokens, but the issue (#2481) requires we
			// not trust un-signed depth claims. Fail closed.
			logger.warn(
				"MAESTRO_AGENT_DEPTH set without signing token; failing closed at max depth",
			);
			this.agentDepth = MAX_AGENT_DEPTH;
			this.isNested = true;
		}
		// Adversarial review: the PPID-comm heuristic that used to live
		// here was both bypassable (`bash -c "unset MAESTRO_*; exec
		// maestro"` produces a PPID whose comm is not in
		// AGENT_BINARY_NAMES) and false-positive-prone (anyone running
		// maestro from a Cursor / VS Code / claude-code terminal got
		// the PPID's comm matching `cursor-*` / `claude-code-*` and
		// was flagged nested with no opt-out). The hard bash-spawn
		// rate cap (recordBashSpawn + maxBashSpawnsPerMinute /
		// maxTotalBashSpawns) is the real defense against fork bombs
		// regardless of how the agent identifies itself. The signed
		// depth token covers env-fabrication; env-stripping is
		// genuinely undetectable in-process from inside a child, and
		// the spawn cap stops the damage either way.

		// Set environment for our children — both depth AND token.
		// Cap at MAX_AGENT_DEPTH so a max-depth process does NOT mint
		// a legitimately-signed depth+1 token. The bash-tool firewall
		// gates on `>=`, but anything that spawns a child outside the
		// firewall (a direct `spawn` from another tool) would happily
		// pass the signed token along. Capping ensures the chain stays
		// at the limit forever once we hit it.
		const nextDepth = Math.min(this.agentDepth + 1, MAX_AGENT_DEPTH);
		process.env[PARENT_PID_ENV] = String(process.pid);
		process.env[AGENT_DEPTH_ENV] = String(nextDepth);
		process.env[AGENT_DEPTH_TOKEN_ENV] = signDepth(nextDepth, key);

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
		this.cleanupOldBashSpawnTimestamps();

		// Hard descendant cap — applied to EVERY bash command before
		// any pattern match. This is the fail-closed defense against
		// fork bombs that hide the agent name (e.g. `$(echo cl)aude`,
		// base64-decode-to-sh) so the regex never matches. See #2481.
		if (this.totalBashSpawnCount >= this.maxTotalBashSpawns) {
			logger.warn("Bash command blocked: session spawn cap reached", {
				commandPreview: command.slice(0, 100),
				totalBashSpawnCount: this.totalBashSpawnCount,
				maxTotalBashSpawns: this.maxTotalBashSpawns,
			});
			return {
				allowed: false,
				reason: `Blocked: maximum bash subprocesses per session (${this.maxTotalBashSpawns}) reached. This prevents fork-bomb-style runaway spawning regardless of command shape.`,
				severity: "error",
			};
		}
		if (this.bashSpawnTimestamps.length >= this.maxBashSpawnsPerMinute) {
			logger.warn("Bash command blocked: spawn-rate cap reached", {
				commandPreview: command.slice(0, 100),
				windowMs: this.childProcessWindowMs,
				recentSpawns: this.bashSpawnTimestamps.length,
				maxBashSpawnsPerMinute: this.maxBashSpawnsPerMinute,
			});
			return {
				allowed: false,
				reason: `Blocked: bash spawn rate cap (${this.maxBashSpawnsPerMinute}/min) reached. This prevents slow-burn fork bombs regardless of command shape.`,
				severity: "error",
			};
		}

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
	 * Record that a bash command is about to be executed. Caller is
	 * the bash-tool firewall layer. Increments the generic descendant
	 * counter independent of pattern matching, so a fork bomb that
	 * obfuscates the agent name still trips the hard cap. See #2481.
	 */
	recordBashSpawn(): void {
		this.totalBashSpawnCount++;
		this.bashSpawnTimestamps.push(Date.now());
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
	 * Drop bash-spawn timestamps outside the rolling rate window.
	 */
	private cleanupOldBashSpawnTimestamps(): void {
		const cutoff = Date.now() - this.childProcessWindowMs;
		this.bashSpawnTimestamps = this.bashSpawnTimestamps.filter(
			(ts) => ts > cutoff,
		);
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
		this.totalBashSpawnCount = 0;
		this.bashSpawnTimestamps = [];
		logger.info("Agent spawn count reset");
	}

	/** Test helper — force re-initialization on next `initialize()`. */
	resetForTests(): void {
		this.initialized = false;
		this.isNested = false;
		this.agentDepth = 0;
		this.parentPid = null;
		this.agentSpawnCount = 0;
		this.totalBashSpawnCount = 0;
		this.bashSpawnTimestamps = [];
		this.childProcesses = [];
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
