/**
 * Context Handoff System.
 *
 * Manages automatic context handoff when approaching context limits.
 * Creates summarized new sessions to continue work without losing progress.
 *
 * Inspired by Amp's thread handoff feature.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("agent:context-handoff");

/** Context usage thresholds */
export interface ContextThresholds {
	/** Warn when context usage exceeds this percentage (0-1) */
	warnAt: number;
	/** Suggest handoff when context usage exceeds this percentage (0-1) */
	suggestHandoffAt: number;
	/** Force handoff when context usage exceeds this percentage (0-1) */
	forceHandoffAt: number;
}

/** Default thresholds */
export const DEFAULT_THRESHOLDS: ContextThresholds = {
	warnAt: 0.7,
	suggestHandoffAt: 0.85,
	forceHandoffAt: 0.95,
};

/** Context usage status */
export type ContextStatus =
	| "ok"
	| "warning"
	| "suggest_handoff"
	| "force_handoff";

/** Handoff context for creating a new session */
export interface HandoffContext {
	/** Summary of what was accomplished */
	summary: string;
	/** Current task/goal being worked on */
	currentTask: string | null;
	/** Key files that were modified */
	modifiedFiles: string[];
	/** Key files that were read/referenced */
	referencedFiles: string[];
	/** Any pending work or todos */
	pendingWork: string[];
	/** Important context that should carry over */
	importantContext: string[];
	/** Timestamp of handoff */
	timestamp: Date;
	/** Previous session ID if available */
	previousSessionId?: string;
}

/** Context usage tracking */
export interface ContextUsage {
	/** Current token count */
	currentTokens: number;
	/** Maximum context window */
	maxTokens: number;
	/** Usage percentage (0-1) */
	usagePercent: number;
	/** Current status */
	status: ContextStatus;
	/** Estimated tokens remaining */
	tokensRemaining: number;
}

/**
 * Context Handoff Manager.
 *
 * Tracks context usage and manages handoff when limits are approached.
 */
export class ContextHandoffManager {
	private thresholds: ContextThresholds;
	private modifiedFiles: Set<string> = new Set();
	private referencedFiles: Set<string> = new Set();
	private pendingWork: string[] = [];
	private importantContext: string[] = [];
	private currentTask: string | null = null;
	private lastStatus: ContextStatus = "ok";

	constructor(thresholds: ContextThresholds = DEFAULT_THRESHOLDS) {
		this.thresholds = thresholds;
	}

	/**
	 * Check context usage and return status.
	 */
	checkUsage(currentTokens: number, maxTokens: number): ContextUsage {
		const usagePercent = currentTokens / maxTokens;
		const tokensRemaining = maxTokens - currentTokens;

		let status: ContextStatus = "ok";
		if (usagePercent >= this.thresholds.forceHandoffAt) {
			status = "force_handoff";
		} else if (usagePercent >= this.thresholds.suggestHandoffAt) {
			status = "suggest_handoff";
		} else if (usagePercent >= this.thresholds.warnAt) {
			status = "warning";
		}

		// Log status changes
		if (status !== this.lastStatus) {
			log.info("Context status changed", {
				from: this.lastStatus,
				to: status,
				usagePercent: Math.round(usagePercent * 100),
				tokensRemaining,
			});
			this.lastStatus = status;
		}

		return {
			currentTokens,
			maxTokens,
			usagePercent,
			status,
			tokensRemaining,
		};
	}

	/**
	 * Record a file modification.
	 */
	recordFileModification(path: string): void {
		this.modifiedFiles.add(path);
	}

	/**
	 * Record a file reference.
	 */
	recordFileReference(path: string): void {
		this.referencedFiles.add(path);
	}

	/**
	 * Set the current task being worked on.
	 */
	setCurrentTask(task: string | null): void {
		this.currentTask = task;
	}

	/**
	 * Add pending work item.
	 */
	addPendingWork(item: string): void {
		if (!this.pendingWork.includes(item)) {
			this.pendingWork.push(item);
		}
	}

	/**
	 * Remove completed work item.
	 */
	completePendingWork(item: string): void {
		const index = this.pendingWork.indexOf(item);
		if (index !== -1) {
			this.pendingWork.splice(index, 1);
		}
	}

	/**
	 * Add important context that should carry over to handoff.
	 */
	addImportantContext(context: string): void {
		if (!this.importantContext.includes(context)) {
			this.importantContext.push(context);
		}
	}

	/**
	 * Clear important context.
	 */
	clearImportantContext(): void {
		this.importantContext = [];
	}

	/**
	 * Generate handoff context for creating a new session.
	 */
	generateHandoffContext(
		summary: string,
		previousSessionId?: string,
	): HandoffContext {
		return {
			summary,
			currentTask: this.currentTask,
			modifiedFiles: Array.from(this.modifiedFiles),
			referencedFiles: Array.from(this.referencedFiles),
			pendingWork: [...this.pendingWork],
			importantContext: [...this.importantContext],
			timestamp: new Date(),
			previousSessionId,
		};
	}

	/**
	 * Format handoff context as a prompt for the new session.
	 */
	formatHandoffPrompt(context: HandoffContext): string {
		const lines: string[] = [
			"# Context Handoff",
			"",
			"This session continues from a previous conversation that reached its context limit.",
			"",
			"## Summary of Previous Work",
			context.summary,
			"",
		];

		if (context.currentTask) {
			lines.push("## Current Task", context.currentTask, "");
		}

		if (context.modifiedFiles.length > 0) {
			lines.push("## Modified Files");
			for (const file of context.modifiedFiles.slice(0, 20)) {
				lines.push(`- ${file}`);
			}
			if (context.modifiedFiles.length > 20) {
				lines.push(`- ... and ${context.modifiedFiles.length - 20} more`);
			}
			lines.push("");
		}

		if (context.referencedFiles.length > 0) {
			lines.push("## Referenced Files");
			for (const file of context.referencedFiles.slice(0, 20)) {
				lines.push(`- ${file}`);
			}
			if (context.referencedFiles.length > 20) {
				lines.push(`- ... and ${context.referencedFiles.length - 20} more`);
			}
			lines.push("");
		}

		if (context.pendingWork.length > 0) {
			lines.push("## Pending Work");
			for (const item of context.pendingWork) {
				lines.push(`- [ ] ${item}`);
			}
			lines.push("");
		}

		if (context.importantContext.length > 0) {
			lines.push("## Important Context");
			for (const item of context.importantContext) {
				lines.push(`- ${item}`);
			}
			lines.push("");
		}

		lines.push(
			"---",
			"",
			"Please continue with the work described above. You can read the modified files to understand the current state.",
		);

		return lines.join("\n");
	}

	/**
	 * Get status message for user display.
	 */
	getStatusMessage(usage: ContextUsage): string | null {
		switch (usage.status) {
			case "warning":
				return `Context ${Math.round(usage.usagePercent * 100)}% used. Consider wrapping up soon.`;
			case "suggest_handoff":
				return `Context near full (${Math.round(usage.usagePercent * 100)}%). Use /handoff to continue in a new session.`;
			case "force_handoff":
				return `Context limit reached (${Math.round(usage.usagePercent * 100)}%). Handoff required to continue.`;
			default:
				return null;
		}
	}

	/**
	 * Reset tracking state (e.g., for a new session).
	 */
	reset(): void {
		this.modifiedFiles.clear();
		this.referencedFiles.clear();
		this.pendingWork = [];
		this.importantContext = [];
		this.currentTask = null;
		this.lastStatus = "ok";
	}
}

/**
 * Create a default context handoff manager.
 */
export function createContextHandoffManager(
	thresholds?: Partial<ContextThresholds>,
): ContextHandoffManager {
	return new ContextHandoffManager({
		...DEFAULT_THRESHOLDS,
		...thresholds,
	});
}

/**
 * Estimate token count from text (rough approximation).
 * Uses ~4 characters per token as a rough estimate.
 */
export function estimateTokenCount(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Format context usage for display.
 */
export function formatContextUsage(usage: ContextUsage): string {
	const percent = Math.round(usage.usagePercent * 100);
	const remaining = Math.round(usage.tokensRemaining / 1000);
	return `${percent}% (${remaining}K tokens remaining)`;
}
