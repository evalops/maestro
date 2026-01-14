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
interface SequencePattern {
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
	) => { matched: boolean; reason?: string; matchingRecords?: ToolCallRecord[] };
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
	egress: ["web_fetch", "http_request", "curl", "wget", "send_email", "send_message"],
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
 * Get tags for a tool based on its name
 */
function getToolTags(toolName: string): Set<string> {
	const tags = new Set<string>();

	const normalizedName = toolName.toLowerCase();

	for (const [tag, patterns] of Object.entries(TOOL_TAGS)) {
		if (
			patterns.some(
				(p) =>
					normalizedName.includes(p) ||
					normalizedName === p ||
					p.includes(normalizedName),
			)
		) {
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
					ageMs < 60000 &&
					r.tags.has("read") &&
					containsSensitivePath(r.args)
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
				return ageMs < 60000 && (r.tags.has("egress") || r.tool.includes("fetch"));
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
];

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

	constructor(options?: { maxRecords?: number; maxAgeMs?: number }) {
		this.maxRecords = options?.maxRecords ?? 100;
		this.maxAgeMs = options?.maxAgeMs ?? 600000; // 10 minutes default
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

		// Check each pattern
		for (const pattern of SUSPICIOUS_PATTERNS) {
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
	private sanitizeArgs(
		args: Record<string, unknown>,
	): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string") {
				// Truncate long strings
				sanitized[key] = value.length > 200 ? value.slice(0, 200) + "..." : value;
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
