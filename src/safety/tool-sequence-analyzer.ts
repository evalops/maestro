/**
 * Tool Sequence Analyzer - Behavioral threat detection for tool calls
 *
 * This module analyzes sequences of tool calls to detect suspicious patterns
 * that may indicate:
 *
 * 1. **Data Exfiltration**: Read sensitive data → network egress
 * 2. **Privilege Escalation**: Normal ops → system modifications
 * 3. **Reconnaissance**: Systematic exploration of sensitive paths
 * 4. **Injection Attacks**: Unusual tool combinations from injected prompts
 * 5. **Confusion Loops**: Repeated similar operations suggesting confusion
 *
 * ## How It Works
 *
 * The analyzer maintains a sliding window of recent tool calls and applies
 * pattern matching rules to detect suspicious sequences. When a suspicious
 * pattern is detected, it can:
 *
 * - Log a warning for security monitoring
 * - Require user approval before continuing
 * - Block the operation entirely (for critical patterns)
 *
 * ## Integration
 *
 * The analyzer should be called before each tool execution:
 *
 * ```typescript
 * const result = analyzer.checkTool(toolName, toolArgs);
 * if (result.action === 'block') {
 *   throw new Error(result.reason);
 * }
 * if (result.action === 'require_approval') {
 *   await requestUserApproval(result.reason);
 * }
 * analyzer.recordTool(toolName, toolArgs, result);
 * ```
 *
 * @module safety/tool-sequence-analyzer
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:tool-sequence-analyzer");

/**
 * Tool call record for sequence analysis
 */
export interface ToolCallRecord {
	/** Tool name */
	tool: string;
	/** Tool arguments (sanitized) */
	args: Record<string, unknown>;
	/** Timestamp of the call */
	timestamp: number;
	/** Tags/categories for the tool */
	tags: Set<string>;
	/** Whether the call was approved */
	approved: boolean;
	/** Whether the call succeeded */
	success?: boolean;
}

/**
 * Suspicious pattern detection result
 */
export interface SequenceAnalysisResult {
	/** Recommended action */
	action: "allow" | "require_approval" | "block";
	/** Pattern ID if detected */
	patternId?: string;
	/** Human-readable reason */
	reason?: string;
	/** Severity level */
	severity?: "low" | "medium" | "high" | "critical";
	/** Matching records that triggered the pattern */
	matchingRecords?: ToolCallRecord[];
}

/**
 * Pattern definition for suspicious sequences
 */
export interface SequencePattern {
	/** Unique identifier */
	id: string;
	/** Human-readable description */
	description: string;
	/** Severity level */
	severity: "low" | "medium" | "high" | "critical";
	/** Recommended action when detected */
	action: "log" | "require_approval" | "block";
	/** Minimum time window for the pattern (ms) */
	windowMs?: number;
	/** Detection function */
	detect: (
		records: ToolCallRecord[],
		currentTool: string,
		currentArgs: Record<string, unknown>,
	) => {
		matched: boolean;
		reason?: string;
		matchingRecords?: ToolCallRecord[];
	};
}

/**
 * Tool tags for categorization
 */
const TOOL_TAGS: Record<string, string[]> = {
	// Read operations
	read: ["read", "file_read", "cat", "head", "tail", "grep"],
	// Write operations
	write: ["write", "edit", "file_write", "touch", "mkdir"],
	// Delete operations
	delete: ["delete_file", "rm", "rmdir", "unlink"],
	// Network egress
	egress: [
		"web_fetch",
		"webfetch",
		"fetch",
		"http_request",
		"curl",
		"wget",
		"send_email",
		"send_message",
	],
	// Execution
	exec: ["bash", "exec", "run", "spawn", "shell"],
	// System paths
	system: ["sudo", "chmod", "chown", "chroot"],
	// Sensitive data access
	sensitive: ["read_env", "read_secrets", "read_config", "get_credentials"],
	// Git operations
	git: ["git", "gh", "git_push", "git_commit"],
	// Authentication
	auth: ["login", "authenticate", "verify_token", "check_password"],
};

/**
 * Check if tool name matches a pattern using word-boundary logic
 * This handles cases like:
 * - "read" matches "read" (exact)
 * - "file_read" matches "read" (ends with pattern)
 * - "read_file" matches "read" (starts with pattern)
 * - "my_read_file" matches "read" (pattern in middle at word boundary)
 * But avoids false positives like:
 * - "reader" should NOT match "read" (pattern is substring, not word)
 */
function matchesToolPattern(toolName: string, pattern: string): boolean {
	// Exact match
	if (toolName === pattern) {
		return true;
	}

	// Word-boundary match using regex
	// Match pattern at start, end, or surrounded by word separators (_, -)
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wordBoundaryRegex = new RegExp(`(?:^|[_-])${escaped}(?:[_-]|$)`, "i");

	return wordBoundaryRegex.test(toolName);
}

/**
 * Get tags for a tool based on its name
 */
function getToolTags(toolName: string): Set<string> {
	const tags = new Set<string>();

	const normalizedName = toolName.toLowerCase();

	for (const [tag, patterns] of Object.entries(TOOL_TAGS)) {
		if (patterns.some((p) => matchesToolPattern(normalizedName, p))) {
			tags.add(tag);
		}
	}

	// Special cases based on tool naming conventions
	if (normalizedName.includes("mcp_")) {
		// MCP tools might need specific handling
		if (normalizedName.includes("send") || normalizedName.includes("post")) {
			tags.add("egress");
		}
		if (normalizedName.includes("read") || normalizedName.includes("get")) {
			tags.add("read");
		}
	}

	return tags;
}

/**
 * Check if args contain paths to sensitive locations
 */
function containsSensitivePath(args: Record<string, unknown>): boolean {
	const sensitivePatterns = [
		/\/etc\//,
		/\/var\/log\//,
		/\.ssh\//,
		/\.aws\//,
		/\.env/,
		/credentials/i,
		/secrets?/i,
		/password/i,
		/token/i,
		/private[_-]?key/i,
	];

	const checkValue = (value: unknown): boolean => {
		if (typeof value === "string") {
			return sensitivePatterns.some((p) => p.test(value));
		}
		if (Array.isArray(value)) {
			return value.some(checkValue);
		}
		if (value && typeof value === "object") {
			return Object.values(value).some(checkValue);
		}
		return false;
	};

	return checkValue(args);
}

/**
 * Suspicious sequence patterns
 */
const SUSPICIOUS_PATTERNS: SequencePattern[] = [
	{
		id: "read-then-egress",
		description: "Sensitive file read followed by network egress",
		severity: "high",
		action: "require_approval",
		windowMs: 60000, // 1 minute
		detect: (records, currentTool, _currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("egress")) {
				return { matched: false };
			}

			// Look for recent sensitive reads
			const sensitiveReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return (
					ageMs < 60000 && r.tags.has("read") && containsSensitivePath(r.args)
				);
			});

			if (sensitiveReads.length > 0) {
				return {
					matched: true,
					reason: `Network egress detected after reading sensitive files: ${sensitiveReads.map((r) => r.tool).join(", ")}`,
					matchingRecords: sensitiveReads,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "rapid-auth-failures",
		description: "Multiple authentication attempts in short time",
		severity: "medium",
		action: "require_approval",
		windowMs: 30000, // 30 seconds
		detect: (records, currentTool, _currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("auth")) {
				return { matched: false };
			}

			// Count recent auth operations
			const recentAuthOps = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return ageMs < 30000 && r.tags.has("auth");
			});

			if (recentAuthOps.length >= 3) {
				return {
					matched: true,
					reason: `Multiple authentication operations detected (${recentAuthOps.length + 1} in 30s)`,
					matchingRecords: recentAuthOps,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "system-path-escalation",
		description: "Normal operations followed by system path modifications",
		severity: "high",
		action: "require_approval",
		windowMs: 120000, // 2 minutes
		detect: (_records, currentTool, currentArgs) => {
			const currentTags = getToolTags(currentTool);

			// Check if current operation targets system paths
			const systemPaths = [
				"/etc/",
				"/usr/",
				"/var/",
				"/boot/",
				"/sys/",
				"/proc/",
				"/dev/",
				"C:\\Windows",
				"C:\\Program Files",
			];

			const targetPath = (currentArgs.path ||
				currentArgs.file_path ||
				currentArgs.target) as string | undefined;

			if (
				targetPath &&
				(currentTags.has("write") || currentTags.has("delete")) &&
				systemPaths.some((sp) => targetPath.startsWith(sp))
			) {
				return {
					matched: true,
					reason: `Modification of system path detected: ${targetPath}`,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "reconnaissance-pattern",
		description: "Systematic reading of configuration/credential files",
		severity: "medium",
		action: "log",
		windowMs: 120000, // 2 minutes
		detect: (records, currentTool, currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("read")) {
				return { matched: false };
			}

			// Count reads to sensitive-looking paths
			const sensitivePathReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return (
					ageMs < 120000 && r.tags.has("read") && containsSensitivePath(r.args)
				);
			});

			// If current read is also to sensitive path and we have many recent ones
			if (
				containsSensitivePath(currentArgs) &&
				sensitivePathReads.length >= 3
			) {
				return {
					matched: true,
					reason: `Reconnaissance pattern detected: ${sensitivePathReads.length + 1} reads of sensitive paths`,
					matchingRecords: sensitivePathReads,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "git-push-without-review",
		description: "Git push without apparent review or testing",
		severity: "medium",
		action: "require_approval",
		windowMs: 300000, // 5 minutes
		detect: (records, currentTool, currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			const isGitPush =
				normalizedTool === "bash" &&
				typeof currentArgs.command === "string" &&
				/git\s+push/.test(currentArgs.command);

			if (!isGitPush) {
				return { matched: false };
			}

			// Look for recent test runs or review operations
			const recentTests = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 300000) return false;

				// Check if it looks like a test or review
				const cmd = (r.args.command as string) || "";
				return (
					/test|spec|lint|check|review|verify/.test(cmd.toLowerCase()) ||
					/npm\s+test|bun\s+test|pytest|jest|vitest/.test(cmd)
				);
			});

			if (recentTests.length === 0) {
				return {
					matched: true,
					reason: "Git push detected without apparent testing or review",
				};
			}

			return { matched: false };
		},
	},
	{
		id: "rapid-file-deletions",
		description: "Multiple file deletions in rapid succession",
		severity: "high",
		action: "require_approval",
		windowMs: 30000, // 30 seconds
		detect: (records, currentTool, _currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("delete")) {
				return { matched: false };
			}

			const recentDeletes = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return ageMs < 30000 && r.tags.has("delete");
			});

			if (recentDeletes.length >= 5) {
				return {
					matched: true,
					reason: `Rapid file deletions detected (${recentDeletes.length + 1} in 30s)`,
					matchingRecords: recentDeletes,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "exec-after-download",
		description: "Execution shortly after downloading content",
		severity: "critical",
		action: "require_approval",
		windowMs: 60000, // 1 minute
		detect: (records, currentTool, currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("exec")) {
				return { matched: false };
			}

			// Look for recent downloads/fetches
			const recentDownloads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return (
					ageMs < 60000 && (r.tags.has("egress") || r.tool.includes("fetch"))
				);
			});

			// Check if current command might be executing downloaded content
			const command = (currentArgs.command as string) || "";
			const suspiciousPatterns = [
				/curl.*\|.*sh/,
				/wget.*\|.*sh/,
				/bash\s+\/tmp/,
				/sh\s+\/tmp/,
				/python.*\/tmp/,
				/node.*\/tmp/,
			];

			const isSuspiciousExec = suspiciousPatterns.some((p) => p.test(command));

			if (recentDownloads.length > 0 && isSuspiciousExec) {
				return {
					matched: true,
					reason: "Execution of potentially downloaded content detected",
					matchingRecords: recentDownloads,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "data-staging",
		description: "Multiple file reads followed by write to temporary location",
		severity: "medium",
		action: "require_approval",
		windowMs: 120000, // 2 minutes
		detect: (records, currentTool, currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("write")) {
				return { matched: false };
			}

			// Check if writing to temp/staging location
			const targetPath = (currentArgs.path ||
				currentArgs.file_path ||
				currentArgs.target) as string | undefined;
			const tempPatterns = [
				/\/tmp\//,
				/\/var\/tmp\//,
				/\/temp\//,
				/\.tmp$/,
				/staging/i,
				/upload/i,
			];
			const isWriteToTemp =
				targetPath && tempPatterns.some((p) => p.test(targetPath));

			if (!isWriteToTemp) {
				return { matched: false };
			}

			// Look for multiple recent reads
			const recentReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return ageMs < 120000 && r.tags.has("read");
			});

			if (recentReads.length >= 3) {
				return {
					matched: true,
					reason: `Data staging detected: ${recentReads.length} reads followed by write to ${targetPath}`,
					matchingRecords: recentReads,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "privilege-escalation-attempt",
		description: "Privilege escalation command after reading configuration",
		severity: "high",
		action: "require_approval",
		windowMs: 120000, // 2 minutes
		detect: (records, currentTool, currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			if (normalizedTool !== "bash") {
				return { matched: false };
			}

			const command = (currentArgs.command as string) || "";
			const escalationPatterns = [
				/sudo\s/,
				/chmod\s+[0-7]*[7][0-7]*/, // chmod with execute bit
				/chown\s/,
				/chgrp\s/,
				/setuid/,
				/setgid/,
				/visudo/,
				/passwd/,
				/usermod/,
				/groupadd/,
				/useradd/,
			];

			const isEscalationCommand = escalationPatterns.some((p) =>
				p.test(command),
			);

			if (!isEscalationCommand) {
				return { matched: false };
			}

			// Look for recent config/credential reads
			const configReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 120000) return false;

				const pathArg = (r.args.path || r.args.file_path) as string | undefined;
				const configPatterns = [
					/\/etc\//,
					/\.conf$/,
					/\.cfg$/,
					/config/i,
					/\.env/,
					/credentials/i,
				];
				return (
					r.tags.has("read") &&
					pathArg &&
					configPatterns.some((p) => p.test(pathArg))
				);
			});

			if (configReads.length > 0) {
				return {
					matched: true,
					reason: `Privilege escalation attempt after reading config: ${command.slice(0, 50)}`,
					matchingRecords: configReads,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "env-exfiltration",
		description: "Environment variable access followed by network call",
		severity: "high",
		action: "require_approval",
		windowMs: 60000, // 1 minute
		detect: (records, currentTool, _currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("egress")) {
				return { matched: false };
			}

			// Look for recent env reads or commands that access env vars
			const envAccess = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 60000) return false;

				// Check if command reads env vars
				const command = (r.args.command as string) || "";
				const envPatterns = [
					/\$\{?\w+\}?/, // Shell variable access
					/env\s/, // env command
					/printenv/, // printenv command
					/export\s/, // export (might show vars)
					/process\.env/, // Node.js env access
					/os\.environ/, // Python env access
					/ENV\[/, // Ruby env access
				];

				const pathArg = (r.args.path || r.args.file_path) as string | undefined;
				const isEnvFile = pathArg && /\.env/.test(pathArg);

				return (
					r.tags.has("sensitive") ||
					isEnvFile ||
					envPatterns.some((p) => p.test(command))
				);
			});

			if (envAccess.length > 0) {
				return {
					matched: true,
					reason: "Network egress detected after environment variable access",
					matchingRecords: envAccess,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "systematic-exploration",
		description: "Systematic directory listing and reading pattern",
		severity: "medium",
		action: "log",
		windowMs: 180000, // 3 minutes
		detect: (records, currentTool, _currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			const isListOrRead =
				normalizedTool.includes("glob") ||
				normalizedTool.includes("ls") ||
				normalizedTool.includes("read") ||
				normalizedTool.includes("list");

			if (!isListOrRead) {
				return { matched: false };
			}

			// Count alternating list/read operations
			const recentOps = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return ageMs < 180000;
			});

			// Look for list -> read -> list -> read pattern
			let listCount = 0;
			let readCount = 0;
			let alternations = 0;
			let lastWasRead = false;

			for (const r of recentOps) {
				const isRead = r.tags.has("read");
				const isList =
					r.tool.toLowerCase().includes("glob") ||
					r.tool.toLowerCase().includes("ls") ||
					r.tool.toLowerCase().includes("list");

				if (isRead) {
					readCount++;
					if (!lastWasRead && listCount > 0) alternations++;
					lastWasRead = true;
				} else if (isList) {
					listCount++;
					lastWasRead = false;
				}
			}

			if (alternations >= 3 && listCount >= 2 && readCount >= 3) {
				return {
					matched: true,
					reason: `Systematic exploration pattern: ${listCount} listings, ${readCount} reads, ${alternations} alternations`,
				};
			}

			return { matched: false };
		},
	},
	{
		id: "mass-modification",
		description: "Large number of file modifications in short period",
		severity: "high",
		action: "require_approval",
		windowMs: 60000, // 1 minute
		detect: (records, currentTool, _currentArgs) => {
			const currentTags = getToolTags(currentTool);
			if (!currentTags.has("write") && !currentTags.has("edit")) {
				return { matched: false };
			}

			// Count recent modifications
			const recentMods = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				return ageMs < 60000 && (r.tags.has("write") || r.tags.has("edit"));
			});

			// Different thresholds for edit vs write
			const threshold = 10;
			if (recentMods.length >= threshold) {
				return {
					matched: true,
					reason: `Mass file modification detected (${recentMods.length + 1} modifications in 1 minute)`,
					matchingRecords: recentMods,
				};
			}

			return { matched: false };
		},
	},
];

/**
 * Session-level statistics for temporal evasion detection
 * These persist for the entire session and don't get pruned by time
 */
interface SessionStats {
	/** Total tool calls in session */
	totalToolCalls: number;
	/** Tool call counts by type */
	toolCounts: Map<string, number>;
	/** Sensitive file accesses in session */
	sensitiveAccesses: number;
	/** Network egress operations in session */
	egressOperations: number;
	/** Session start time */
	sessionStart: number;
	/** Unique paths accessed */
	uniquePaths: Set<string>;
}

/**
 * Tool Sequence Analyzer class
 */
export class ToolSequenceAnalyzer {
	/** Sliding window of recent tool calls */
	private records: ToolCallRecord[] = [];

	/** Maximum records to keep */
	private maxRecords: number;

	/** Maximum age of records (ms) */
	private maxAgeMs: number;

	/**
	 * Session-level statistics for temporal evasion detection
	 * These persist for the entire session to detect slow-burn attacks
	 */
	private sessionStats: SessionStats = {
		totalToolCalls: 0,
		toolCounts: new Map(),
		sensitiveAccesses: 0,
		egressOperations: 0,
		sessionStart: Date.now(),
		uniquePaths: new Set(),
	};

	/**
	 * Session-level thresholds for temporal evasion detection
	 */
	private readonly sessionThresholds = {
		/** Max total tool calls per session */
		maxToolCalls: 500,
		/** Max sensitive file accesses per session */
		maxSensitiveAccesses: 50,
		/** Max network egress operations per session */
		maxEgressOperations: 20,
		/** Max unique paths to access */
		maxUniquePaths: 200,
		/** Alert after this many calls of same tool type */
		toolTypeThreshold: 100,
	};

	constructor(options?: { maxRecords?: number; maxAgeMs?: number }) {
		this.maxRecords = options?.maxRecords ?? 100;
		this.maxAgeMs = options?.maxAgeMs ?? 600000; // 10 minutes default
	}

	/**
	 * Get session statistics for monitoring
	 */
	getSessionStats(): Readonly<{
		totalToolCalls: number;
		sensitiveAccesses: number;
		egressOperations: number;
		uniquePathCount: number;
		sessionDurationMs: number;
	}> {
		return {
			totalToolCalls: this.sessionStats.totalToolCalls,
			sensitiveAccesses: this.sessionStats.sensitiveAccesses,
			egressOperations: this.sessionStats.egressOperations,
			uniquePathCount: this.sessionStats.uniquePaths.size,
			sessionDurationMs: Date.now() - this.sessionStats.sessionStart,
		};
	}

	/**
	 * Check session-level patterns for temporal evasion
	 * This catches attackers who space out operations over time
	 */
	private checkSessionPatterns(
		toolName: string,
		toolArgs: Record<string, unknown>,
	): SequenceAnalysisResult | null {
		const tags = getToolTags(toolName);

		// Track session stats
		this.sessionStats.totalToolCalls++;
		const toolCount =
			(this.sessionStats.toolCounts.get(toolName) ?? 0) + 1;
		this.sessionStats.toolCounts.set(toolName, toolCount);

		// Track sensitive accesses
		if (tags.has("sensitive") || tags.has("privesc")) {
			this.sessionStats.sensitiveAccesses++;
		}

		// Track egress operations
		if (tags.has("network") || tags.has("egress")) {
			this.sessionStats.egressOperations++;
		}

		// Track unique paths
		const path = this.extractPath(toolArgs);
		if (path) {
			this.sessionStats.uniquePaths.add(path);
		}

		// Check session-level thresholds
		if (this.sessionStats.totalToolCalls >= this.sessionThresholds.maxToolCalls) {
			return {
				action: "require_approval",
				patternId: "session-tool-limit",
				reason: `Session tool call limit reached (${this.sessionStats.totalToolCalls} calls). This may indicate automated abuse.`,
				severity: "high",
			};
		}

		if (
			this.sessionStats.sensitiveAccesses >=
			this.sessionThresholds.maxSensitiveAccesses
		) {
			return {
				action: "require_approval",
				patternId: "session-sensitive-limit",
				reason: `Session sensitive access limit reached (${this.sessionStats.sensitiveAccesses} accesses). Possible reconnaissance or data harvesting.`,
				severity: "high",
			};
		}

		if (
			this.sessionStats.egressOperations >=
			this.sessionThresholds.maxEgressOperations
		) {
			return {
				action: "block",
				patternId: "session-egress-limit",
				reason: `Session egress limit reached (${this.sessionStats.egressOperations} operations). Possible data exfiltration.`,
				severity: "critical",
			};
		}

		if (
			this.sessionStats.uniquePaths.size >=
			this.sessionThresholds.maxUniquePaths
		) {
			return {
				action: "require_approval",
				patternId: "session-path-limit",
				reason: `Session unique path limit reached (${this.sessionStats.uniquePaths.size} paths). Possible filesystem enumeration.`,
				severity: "high",
			};
		}

		// Check for excessive use of single tool type
		if (toolCount >= this.sessionThresholds.toolTypeThreshold) {
			return {
				action: "require_approval",
				patternId: "session-tool-type-limit",
				reason: `Excessive use of ${toolName} (${toolCount} calls). May indicate automated abuse.`,
				severity: "medium",
			};
		}

		return null;
	}

	/**
	 * Extract file path from tool arguments
	 */
	private extractPath(args: Record<string, unknown>): string | null {
		// Common path argument names
		const pathKeys = ["path", "file", "file_path", "filePath", "target", "source"];
		for (const key of pathKeys) {
			const value = args[key];
			if (typeof value === "string") {
				return value;
			}
		}
		return null;
	}

	/**
	 * Check a tool call against suspicious patterns
	 */
	checkTool(
		toolName: string,
		toolArgs: Record<string, unknown>,
	): SequenceAnalysisResult {
		// Clean old records first
		this.pruneOldRecords();

		// Check session-level patterns first (for temporal evasion detection)
		const sessionResult = this.checkSessionPatterns(toolName, toolArgs);
		if (sessionResult) {
			logger.warn("Session-level pattern detected", {
				patternId: sessionResult.patternId,
				severity: sessionResult.severity,
				tool: toolName,
				reason: sessionResult.reason,
			});
			return sessionResult;
		}

		// Check each pattern with fail-closed error handling
		for (const pattern of SUSPICIOUS_PATTERNS) {
			try {
				const result = pattern.detect(this.records, toolName, toolArgs);

				if (result.matched) {
					logger.warn("Suspicious tool sequence detected", {
						patternId: pattern.id,
						severity: pattern.severity,
						tool: toolName,
						reason: result.reason,
					});

					const action =
						pattern.action === "log"
							? "allow"
							: pattern.action === "require_approval"
								? "require_approval"
								: "block";

					return {
						action,
						patternId: pattern.id,
						reason: result.reason ?? pattern.description,
						severity: pattern.severity,
						matchingRecords: result.matchingRecords,
					};
				}
			} catch (err) {
				// Fail-closed: if a pattern detection throws, require approval
				// This prevents attackers from crafting inputs that crash patterns
				logger.error(
					`Pattern detection error - failing closed [pattern=${pattern.id}, tool=${toolName}]`,
					err instanceof Error ? err : new Error(String(err)),
				);
				return {
					action: "require_approval",
					patternId: pattern.id,
					reason: `Security pattern check failed: ${pattern.description}. Manual review required.`,
					severity: "high",
				};
			}
		}

		return { action: "allow" };
	}

	/**
	 * Record a tool call (call after execution)
	 */
	recordTool(
		toolName: string,
		toolArgs: Record<string, unknown>,
		approved: boolean,
		success?: boolean,
	): void {
		const record: ToolCallRecord = {
			tool: toolName,
			args: this.sanitizeArgs(toolArgs),
			timestamp: Date.now(),
			tags: getToolTags(toolName),
			approved,
			success,
		};

		this.records.push(record);
		this.pruneOldRecords();
	}

	/**
	 * Remove old records from the window
	 */
	private pruneOldRecords(): void {
		const cutoff = Date.now() - this.maxAgeMs;

		// Remove records older than cutoff
		this.records = this.records.filter((r) => r.timestamp > cutoff);

		// Trim to max size
		if (this.records.length > this.maxRecords) {
			this.records = this.records.slice(-this.maxRecords);
		}
	}

	/**
	 * Sanitize args for storage (remove large values)
	 */
	private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string") {
				// Truncate long strings
				sanitized[key] =
					value.length > 200 ? `${value.slice(0, 200)}...` : value;
			} else if (typeof value === "number" || typeof value === "boolean") {
				sanitized[key] = value;
			} else if (Array.isArray(value)) {
				sanitized[key] = `[Array: ${value.length} items]`;
			} else if (value && typeof value === "object") {
				sanitized[key] = "[Object]";
			}
		}

		return sanitized;
	}

	/**
	 * Get current record count
	 */
	getRecordCount(): number {
		return this.records.length;
	}

	/**
	 * Clear all records
	 */
	clear(): void {
		this.records = [];
	}

	/**
	 * Get a summary of recent activity
	 */
	getSummary(): {
		totalCalls: number;
		byTool: Record<string, number>;
		byTag: Record<string, number>;
	} {
		const byTool: Record<string, number> = {};
		const byTag: Record<string, number> = {};

		for (const record of this.records) {
			byTool[record.tool] = (byTool[record.tool] || 0) + 1;
			for (const tag of record.tags) {
				byTag[tag] = (byTag[tag] || 0) + 1;
			}
		}

		return {
			totalCalls: this.records.length,
			byTool,
			byTag,
		};
	}
}

/**
 * Default analyzer instance
 */
export const defaultToolSequenceAnalyzer = new ToolSequenceAnalyzer();
