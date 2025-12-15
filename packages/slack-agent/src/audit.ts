/**
 * Audit Logger - File-based audit trail for Slack Agent
 *
 * Creates tamper-evident audit logs with hash chaining.
 * Supports PII redaction and configurable retention.
 */

import crypto from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import * as logger from "./logger.js";
import { ensureDirSync } from "./utils/fs.js";

// ============================================================================
// Types
// ============================================================================

export type AuditAction =
	| "message"
	| "tool_call"
	| "tool_result"
	| "approval_request"
	| "approval_granted"
	| "approval_denied"
	| "approval_timeout"
	| "scheduled_task"
	| "rate_limited"
	| "permission_denied"
	| "error"
	| "feedback";

export interface AuditEntry {
	timestamp: string;
	action: AuditAction;
	userId?: string;
	userName?: string;
	channel?: string;
	threadTs?: string;
	toolName?: string;
	inputPreview?: string;
	outputPreview?: string;
	status?: "success" | "error" | "denied" | "pending";
	tokensUsed?: number;
	model?: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
	integrityHash?: string;
	previousHash?: string;
}

export interface AuditLoggerConfig {
	enablePiiRedaction?: boolean;
	maxPreviewLength?: number;
	retentionDays?: number;
	rotateAtMB?: number;
}

// ============================================================================
// PII Detection Patterns
// ============================================================================

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
	// Email addresses
	{
		pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
		replacement: "[EMAIL]",
	},
	// Credit Card Numbers (before phone - more specific pattern)
	{
		pattern: /\b(?:\d{4}[-.\s]?){3}\d{4}\b/g,
		replacement: "[CARD]",
	},
	// Social Security Numbers (before phone - more specific)
	{
		pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
		replacement: "[SSN]",
	},
	// Phone numbers (last among digit patterns - most greedy)
	{
		pattern: /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
		replacement: "[PHONE]",
	},
	// IP Addresses
	{
		pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
		replacement: "[IP]",
	},
	// API Keys / Tokens
	{
		pattern:
			/\b(sk|pk|api|key|token|secret|password|auth)[-_]?[a-zA-Z0-9]{16,}\b/gi,
		replacement: "[REDACTED_KEY]",
	},
	// AWS Keys
	{
		pattern: /\b(AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
		replacement: "[AWS_KEY]",
	},
];

// ============================================================================
// AuditLogger Class
// ============================================================================

export class AuditLogger {
	private auditDir: string;
	private currentFile: string;
	private lastHash: string | undefined;
	private config: Required<AuditLoggerConfig>;

	constructor(workingDir: string, config: AuditLoggerConfig = {}) {
		this.auditDir = join(workingDir, "audit");
		this.config = {
			enablePiiRedaction: config.enablePiiRedaction ?? true,
			maxPreviewLength: config.maxPreviewLength ?? 500,
			retentionDays: config.retentionDays ?? 90,
			rotateAtMB: config.rotateAtMB ?? 10,
		};

		// Ensure audit directory exists
		ensureDirSync(this.auditDir);

		// Set current file based on date
		this.currentFile = this.getLogFileName(new Date());

		// Load last hash for chain integrity
		this.lastHash = this.loadLastHash();
	}

	private getLogFileName(date: Date): string {
		const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
		return join(this.auditDir, `audit-${dateStr}.jsonl`);
	}

	private loadLastHash(): string | undefined {
		try {
			const files = readdirSync(this.auditDir)
				.filter((f) => f.startsWith("audit-") && f.endsWith(".jsonl"))
				.sort()
				.reverse();

			for (const file of files) {
				const content = readFileSync(join(this.auditDir, file), "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);
				if (lines.length > 0) {
					const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditEntry;
					return lastEntry.integrityHash;
				}
			}
		} catch {
			// No previous logs
		}
		return undefined;
	}

	/**
	 * Log an audit entry
	 */
	log(
		entry: Omit<AuditEntry, "timestamp" | "integrityHash" | "previousHash">,
	): void {
		// Check for log rotation
		this.checkRotation();

		// Apply PII redaction
		let processedEntry = { ...entry };
		if (this.config.enablePiiRedaction) {
			processedEntry = this.redactPii(processedEntry);
		}

		// Truncate previews
		if (processedEntry.inputPreview) {
			processedEntry.inputPreview = this.truncate(
				processedEntry.inputPreview,
				this.config.maxPreviewLength,
			);
		}
		if (processedEntry.outputPreview) {
			processedEntry.outputPreview = this.truncate(
				processedEntry.outputPreview,
				this.config.maxPreviewLength,
			);
		}

		// Build full entry with hash chain
		const fullEntry: AuditEntry = {
			...processedEntry,
			timestamp: new Date().toISOString(),
			previousHash: this.lastHash,
		};

		// Calculate integrity hash
		fullEntry.integrityHash = this.calculateHash(fullEntry);
		this.lastHash = fullEntry.integrityHash;

		// Append to log file
		try {
			appendFileSync(this.currentFile, `${JSON.stringify(fullEntry)}\n`);
		} catch (error) {
			logger.logWarning("Failed to write audit log", String(error));
		}
	}

	/**
	 * Log a message event
	 */
	logMessage(
		userId: string,
		channel: string,
		preview: string,
		threadTs?: string,
	): void {
		this.log({
			action: "message",
			userId,
			channel,
			threadTs,
			inputPreview: preview,
			status: "success",
		});
	}

	/**
	 * Log a tool call
	 */
	logToolCall(
		userId: string,
		channel: string,
		toolName: string,
		input: unknown,
		status: "success" | "error" | "denied" | "pending",
		output?: string,
		durationMs?: number,
	): void {
		this.log({
			action: "tool_call",
			userId,
			channel,
			toolName,
			inputPreview: typeof input === "string" ? input : JSON.stringify(input),
			outputPreview: output,
			status,
			durationMs,
		});
	}

	/**
	 * Log an approval event
	 */
	logApproval(
		userId: string,
		channel: string,
		action:
			| "approval_request"
			| "approval_granted"
			| "approval_denied"
			| "approval_timeout",
		command: string,
	): void {
		this.log({
			action,
			userId,
			channel,
			inputPreview: command,
			status:
				action === "approval_granted"
					? "success"
					: action === "approval_request"
						? "pending"
						: "denied",
		});
	}

	/**
	 * Log a permission denied event
	 */
	logPermissionDenied(
		userId: string,
		channel: string,
		attemptedAction: string,
		reason: string,
	): void {
		this.log({
			action: "permission_denied",
			userId,
			channel,
			inputPreview: attemptedAction,
			outputPreview: reason,
			status: "denied",
		});
	}

	/**
	 * Verify the integrity of all audit logs
	 */
	verifyIntegrity(): { valid: boolean; errors: string[] } {
		const errors: string[] = [];
		let previousHash: string | undefined;

		try {
			const files = readdirSync(this.auditDir)
				.filter((f) => f.startsWith("audit-") && f.endsWith(".jsonl"))
				.sort();

			for (const file of files) {
				const content = readFileSync(join(this.auditDir, file), "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);

				for (let i = 0; i < lines.length; i++) {
					const entry = JSON.parse(lines[i]) as AuditEntry;

					// Check chain continuity
					if (entry.previousHash !== previousHash) {
						errors.push(
							`${file}:${i + 1} - Hash chain broken (expected ${previousHash}, got ${entry.previousHash})`,
						);
					}

					// Verify hash (calculateHash automatically excludes integrityHash)
					const expectedHash = this.calculateHash(entry);
					if (entry.integrityHash !== expectedHash) {
						errors.push(
							`${file}:${i + 1} - Hash mismatch (record may be tampered)`,
						);
					}

					previousHash = entry.integrityHash;
				}
			}
		} catch (error) {
			errors.push(`Failed to verify: ${String(error)}`);
		}

		return { valid: errors.length === 0, errors };
	}

	/**
	 * Query audit logs
	 */
	query(options: {
		startDate?: Date;
		endDate?: Date;
		userId?: string;
		action?: AuditAction;
		limit?: number;
	}): AuditEntry[] {
		const results: AuditEntry[] = [];
		const limit = options.limit ?? 100;

		try {
			const files = readdirSync(this.auditDir)
				.filter((f) => f.startsWith("audit-") && f.endsWith(".jsonl"))
				.sort()
				.reverse();

			for (const file of files) {
				// Check date range from filename
				const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})\.jsonl/);
				if (dateMatch) {
					const fileDate = new Date(dateMatch[1]);
					if (options.startDate && fileDate < options.startDate) continue;
					if (options.endDate && fileDate > options.endDate) continue;
				}

				const content = readFileSync(join(this.auditDir, file), "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);

				for (const line of lines.reverse()) {
					if (results.length >= limit) break;

					const entry = JSON.parse(line) as AuditEntry;

					// Apply filters
					if (options.userId && entry.userId !== options.userId) continue;
					if (options.action && entry.action !== options.action) continue;

					results.push(entry);
				}

				if (results.length >= limit) break;
			}
		} catch (error) {
			logger.logWarning("Failed to query audit logs", String(error));
		}

		return results;
	}

	/**
	 * Clean up old audit logs based on retention policy
	 */
	cleanup(): number {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
		let deleted = 0;

		try {
			const files = readdirSync(this.auditDir).filter(
				(f) => f.startsWith("audit-") && f.endsWith(".jsonl"),
			);

			for (const file of files) {
				// Match both regular (audit-2024-01-15.jsonl) and rotated files
				// (audit-2024-01-15-1702648800000.jsonl)
				const dateMatch = file.match(
					/audit-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl/,
				);
				if (dateMatch) {
					const fileDate = new Date(dateMatch[1]);
					if (fileDate < cutoff) {
						unlinkSync(join(this.auditDir, file));
						deleted++;
						logger.logInfo(`Deleted old audit log: ${file}`);
					}
				}
			}
		} catch (error) {
			logger.logWarning("Failed to cleanup audit logs", String(error));
		}

		return deleted;
	}

	private checkRotation(): void {
		const today = this.getLogFileName(new Date());
		const isRotatedFile = this.currentFile.match(/-\d+\.jsonl$/);

		// Only reset to base daily file if:
		// 1. It's a new day (base filename changed), OR
		// 2. Current file doesn't exist yet (initial state or after cleanup)
		if (!isRotatedFile && this.currentFile !== today) {
			this.currentFile = today;
		} else if (isRotatedFile) {
			// Extract base date from rotated filename to check if day changed
			const baseFile = this.currentFile.replace(/-\d+\.jsonl$/, ".jsonl");
			if (baseFile !== today) {
				// New day - switch to new base file
				this.currentFile = today;
			}
		}

		// Check file size for rotation within same day
		try {
			if (existsSync(this.currentFile)) {
				const stats = statSync(this.currentFile);
				const sizeMB = stats.size / (1024 * 1024);
				if (sizeMB >= this.config.rotateAtMB) {
					// Rename current file with timestamp suffix
					const timestamp = Date.now();
					const rotatedName = this.currentFile.replace(
						".jsonl",
						`-${timestamp}.jsonl`,
					);
					// Rename the file
					renameSync(this.currentFile, rotatedName);
					// Keep writing to the base daily file (which is now empty/new)
					// currentFile stays as the base daily file
				}
			}
		} catch {
			// Ignore rotation check errors
		}
	}

	private redactPii<T extends Record<string, unknown>>(obj: T): T {
		const result: Record<string, unknown> = { ...obj };
		for (const key of Object.keys(result)) {
			const value = result[key];
			if (typeof value === "string") {
				let redacted = value;
				for (const { pattern, replacement } of PII_PATTERNS) {
					redacted = redacted.replace(pattern, replacement);
				}
				result[key] = redacted;
			} else if (typeof value === "object" && value !== null) {
				result[key] = this.redactPii(value as Record<string, unknown>);
			}
		}
		return result as T;
	}

	private truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return `${text.substring(0, maxLength)}... [truncated]`;
	}

	private calculateHash(
		entry: AuditEntry | Omit<AuditEntry, "integrityHash">,
	): string {
		// Exclude integrityHash from the content being hashed
		const { integrityHash: _, ...rest } = entry as AuditEntry;
		const keys = Object.keys(rest).sort();
		const content = JSON.stringify(rest, keys);
		return crypto.createHash("sha256").update(content).digest("hex");
	}
}
