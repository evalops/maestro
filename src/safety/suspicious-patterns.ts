/**
 * Suspicious sequence patterns for the tool sequence analyzer
 *
 * Contains the pattern definitions that detect potentially malicious
 * tool call sequences.
 *
 * @module safety/suspicious-patterns
 */

import type { SequencePattern } from "./sequence-analyzer-types.js";
import { containsSensitivePath, getToolTags } from "./tool-categorization.js";

/**
 * Suspicious sequence patterns
 */
export const SUSPICIOUS_PATTERNS: SequencePattern[] = [
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
