/**
 * Approval Workflow - Request confirmation for destructive operations
 *
 * When the agent wants to perform a potentially destructive operation,
 * it can request approval from the user via Slack reactions.
 */

import * as logger from "./logger.js";

export interface PendingApproval {
	id: string;
	channelId: string;
	messageTs: string;
	operation: string;
	description: string;
	createdAt: number;
	/** Callback when approved */
	onApprove: () => Promise<void>;
	/** Callback when rejected */
	onReject: () => Promise<void>;
	/** Timeout in ms (default 5 minutes) */
	timeout: number;
}

export interface ApprovalManagerConfig {
	/** Default timeout for approvals in ms */
	defaultTimeout?: number;
}

/**
 * Patterns that indicate potentially destructive operations
 */
export const DESTRUCTIVE_PATTERNS = [
	// File operations
	/\brm\s+-rf?\b/i,
	/\brm\s+.*\*/i,
	/\brmdir\b/i,
	/\bunlink\b/i,
	// Git operations
	/\bgit\s+push\s+.*--force\b/i,
	/\bgit\s+push\s+-f\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-fd\b/i,
	/\bgit\s+branch\s+-[dD]\b/i,
	// Database operations
	/\bDROP\s+(TABLE|DATABASE|INDEX)\b/i,
	/\bTRUNCATE\b/i,
	/\bDELETE\s+FROM\b.*WHERE.*=.*\*/i,
	// System operations
	/\bsudo\b/i,
	/\bchmod\s+777\b/i,
	/\bkill\s+-9\b/i,
	/\bpkill\b/i,
	// Package operations
	/\bnpm\s+unpublish\b/i,
	/\byarn\s+remove\b.*--all\b/i,
	// Docker operations
	/\bdocker\s+rm\b/i,
	/\bdocker\s+rmi\b/i,
	/\bdocker\s+system\s+prune\b/i,
];

/**
 * Check if a command might be destructive
 */
export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Extract a human-readable description of what's destructive
 */
export function describeDestructiveOperation(command: string): string {
	if (/\brm\s+-rf?\b/i.test(command)) {
		return "Delete files/directories";
	}
	if (
		/\bgit\s+push\s+.*--force\b/i.test(command) ||
		/\bgit\s+push\s+-f\b/i.test(command)
	) {
		return "Force push to git remote";
	}
	if (/\bgit\s+reset\s+--hard\b/i.test(command)) {
		return "Hard reset git repository";
	}
	if (/\bDROP\s+(TABLE|DATABASE)\b/i.test(command)) {
		return "Drop database table/database";
	}
	if (/\bTRUNCATE\b/i.test(command)) {
		return "Truncate database table";
	}
	if (/\bsudo\b/i.test(command)) {
		return "Run command with sudo";
	}
	if (/\bdocker\s+rm\b/i.test(command)) {
		return "Remove Docker container";
	}
	if (/\bdocker\s+system\s+prune\b/i.test(command)) {
		return "Prune Docker system";
	}
	return "Potentially destructive operation";
}

export class ApprovalManager {
	private pending: Map<string, PendingApproval> = new Map();
	private defaultTimeout: number;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: ApprovalManagerConfig = {}) {
		this.defaultTimeout = config.defaultTimeout ?? 5 * 60 * 1000; // 5 minutes
	}

	/**
	 * Start the cleanup interval for expired approvals
	 */
	start(): void {
		if (this.cleanupInterval) return;

		// Check for expired approvals every 30 seconds
		this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30000);
	}

	/**
	 * Stop the cleanup interval
	 */
	stop(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}

	/**
	 * Request approval for an operation
	 * Returns an ID that can be used to check status or cancel
	 */
	requestApproval(
		channelId: string,
		messageTs: string,
		operation: string,
		description: string,
		onApprove: () => Promise<void>,
		onReject: () => Promise<void>,
		timeout?: number,
	): string {
		const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		const approval: PendingApproval = {
			id,
			channelId,
			messageTs,
			operation,
			description,
			createdAt: Date.now(),
			onApprove,
			onReject,
			timeout: timeout ?? this.defaultTimeout,
		};

		this.pending.set(id, approval);
		logger.logInfo(`Approval requested: ${id} - ${description}`);

		return id;
	}

	/**
	 * Handle a reaction that might be an approval/rejection
	 * Returns true if the reaction was handled
	 */
	async handleReaction(
		channelId: string,
		messageTs: string,
		reaction: string,
	): Promise<boolean> {
		// Find pending approval for this message
		const approval = Array.from(this.pending.values()).find(
			(a) => a.channelId === channelId && a.messageTs === messageTs,
		);

		if (!approval) {
			return false;
		}

		// Check for approval reactions
		const approveReactions = [
			"white_check_mark",
			"heavy_check_mark",
			"thumbsup",
			"+1",
			"ok",
			"approved",
		];
		const rejectReactions = [
			"x",
			"no_entry",
			"thumbsdown",
			"-1",
			"no_entry_sign",
			"rejected",
		];

		if (approveReactions.includes(reaction)) {
			logger.logInfo(`Approval granted: ${approval.id}`);
			this.pending.delete(approval.id);
			try {
				await approval.onApprove();
			} catch (error) {
				logger.logWarning(
					`Approval callback failed: ${approval.id}`,
					String(error),
				);
			}
			return true;
		}

		if (rejectReactions.includes(reaction)) {
			logger.logInfo(`Approval rejected: ${approval.id}`);
			this.pending.delete(approval.id);
			try {
				await approval.onReject();
			} catch (error) {
				logger.logWarning(
					`Rejection callback failed: ${approval.id}`,
					String(error),
				);
			}
			return true;
		}

		return false;
	}

	/**
	 * Cancel a pending approval
	 */
	cancel(id: string): boolean {
		return this.pending.delete(id);
	}

	/**
	 * Get pending approvals for a channel
	 */
	getPendingForChannel(channelId: string): PendingApproval[] {
		return Array.from(this.pending.values()).filter(
			(a) => a.channelId === channelId,
		);
	}

	/**
	 * Clean up expired approvals
	 */
	private async cleanupExpired(): Promise<void> {
		const now = Date.now();

		for (const approval of this.pending.values()) {
			if (now - approval.createdAt > approval.timeout) {
				logger.logInfo(`Approval expired: ${approval.id}`);
				this.pending.delete(approval.id);
				try {
					await approval.onReject();
				} catch (error) {
					logger.logWarning(
						`Expiration callback failed: ${approval.id}`,
						String(error),
					);
				}
			}
		}
	}
}
