/**
 * Session Checkpoint System
 *
 * Automatically saves progress during long-running tasks so agents can
 * resume after context window clears or process restarts.
 *
 * ## Features
 *
 * - Auto-checkpoint at configurable intervals
 * - Progress summaries for context handoff
 * - Task state persistence
 * - Resume from last checkpoint
 *
 * ## Usage
 *
 * ```typescript
 * import { sessionCheckpoint } from "./session-checkpoint.js";
 *
 * // Initialize for a session
 * await sessionCheckpoint.initialize(sessionId);
 *
 * // Create checkpoint
 * await sessionCheckpoint.createCheckpoint({
 *   summary: "Completed database migration setup",
 *   completedTasks: ["schema design", "migration scripts"],
 *   pendingTasks: ["run migrations", "verify data"],
 *   context: { currentFile: "migrations/001.sql" },
 * });
 *
 * // Get latest checkpoint for resume
 * const checkpoint = await sessionCheckpoint.getLatest();
 * ```
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent:session-checkpoint");

/**
 * Checkpoint data structure
 */
export interface Checkpoint {
	/** Unique checkpoint ID */
	id: string;
	/** Session ID */
	sessionId: string;
	/** Timestamp */
	timestamp: string;
	/** Checkpoint number in sequence */
	sequence: number;
	/** Human-readable summary of progress */
	summary: string;
	/** List of completed tasks */
	completedTasks: string[];
	/** List of pending tasks */
	pendingTasks: string[];
	/** Current task being worked on */
	currentTask?: string;
	/** Arbitrary context data */
	context: Record<string, unknown>;
	/** Token usage at checkpoint */
	tokenUsage?: {
		input: number;
		output: number;
		total: number;
	};
	/** Files modified since last checkpoint */
	modifiedFiles?: string[];
	/** Errors encountered */
	errors?: string[];
}

/**
 * Checkpoint configuration
 */
export interface CheckpointConfig {
	/** Enable automatic checkpointing */
	autoCheckpoint: boolean;
	/** Interval between auto-checkpoints (ms) */
	intervalMs: number;
	/** Maximum checkpoints to keep */
	maxCheckpoints: number;
	/** Include file modifications in checkpoint */
	trackFileChanges: boolean;
}

const DEFAULT_CONFIG: CheckpointConfig = {
	autoCheckpoint: true,
	intervalMs: 5 * 60 * 1000, // 5 minutes
	maxCheckpoints: 20,
	trackFileChanges: true,
};

/**
 * Generate checkpoint ID
 */
function generateCheckpointId(): string {
	return `ckpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Session checkpoint manager
 */
class SessionCheckpointManager {
	private sessionId: string | null = null;
	private checkpointDir: string | null = null;
	private config: CheckpointConfig = DEFAULT_CONFIG;
	private sequence = 0;
	private autoCheckpointTimer: ReturnType<typeof setInterval> | null = null;
	private modifiedFiles = new Set<string>();
	private completedTasks: string[] = [];
	private pendingTasks: string[] = [];
	private currentTask: string | null = null;
	private errors: string[] = [];

	/**
	 * Initialize checkpoint system for a session
	 */
	async initialize(
		sessionId: string,
		config?: Partial<CheckpointConfig>,
	): Promise<void> {
		this.sessionId = sessionId;
		this.config = { ...DEFAULT_CONFIG, ...config };

		this.checkpointDir = join(
			PATHS.COMPOSER_HOME,
			"sessions",
			sessionId,
			"checkpoints",
		);

		if (!existsSync(this.checkpointDir)) {
			mkdirSync(this.checkpointDir, { recursive: true });
		}

		// Load existing sequence number
		const existing = await this.listCheckpoints();
		this.sequence = existing.length;

		// Start auto-checkpoint timer
		if (this.config.autoCheckpoint) {
			this.startAutoCheckpoint();
		}

		logger.info("Checkpoint system initialized", {
			sessionId,
			checkpointDir: this.checkpointDir,
			existingCheckpoints: existing.length,
		});
	}

	/**
	 * Start automatic checkpointing
	 */
	private startAutoCheckpoint(): void {
		if (this.autoCheckpointTimer) return;

		this.autoCheckpointTimer = setInterval(async () => {
			try {
				await this.createCheckpoint({
					summary: "Auto-checkpoint",
					completedTasks: [...this.completedTasks],
					pendingTasks: [...this.pendingTasks],
					context: { auto: true },
				});
			} catch (error) {
				logger.warn("Auto-checkpoint failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, this.config.intervalMs);

		logger.info("Auto-checkpoint started", {
			intervalMs: this.config.intervalMs,
		});
	}

	/**
	 * Stop automatic checkpointing
	 */
	stopAutoCheckpoint(): void {
		if (this.autoCheckpointTimer) {
			clearInterval(this.autoCheckpointTimer);
			this.autoCheckpointTimer = null;
			logger.info("Auto-checkpoint stopped");
		}
	}

	/**
	 * Create a checkpoint
	 */
	async createCheckpoint(data: {
		summary: string;
		completedTasks?: string[];
		pendingTasks?: string[];
		currentTask?: string;
		context?: Record<string, unknown>;
		tokenUsage?: Checkpoint["tokenUsage"];
	}): Promise<Checkpoint> {
		if (!this.sessionId || !this.checkpointDir) {
			throw new Error("Checkpoint system not initialized");
		}

		this.sequence++;

		const checkpoint: Checkpoint = {
			id: generateCheckpointId(),
			sessionId: this.sessionId,
			timestamp: new Date().toISOString(),
			sequence: this.sequence,
			summary: data.summary,
			completedTasks: data.completedTasks || [...this.completedTasks],
			pendingTasks: data.pendingTasks || [...this.pendingTasks],
			currentTask: data.currentTask || this.currentTask || undefined,
			context: data.context || {},
			tokenUsage: data.tokenUsage,
			modifiedFiles: this.config.trackFileChanges
				? Array.from(this.modifiedFiles)
				: undefined,
			errors: this.errors.length > 0 ? [...this.errors] : undefined,
		};

		// Save checkpoint
		const filename = `${String(this.sequence).padStart(4, "0")}_${checkpoint.id}.json`;
		const filepath = join(this.checkpointDir, filename);
		writeFileSync(filepath, JSON.stringify(checkpoint, null, 2));

		// Cleanup old checkpoints
		await this.cleanupOldCheckpoints();

		// Clear modified files after checkpoint
		this.modifiedFiles.clear();
		this.errors = [];

		logger.info("Checkpoint created", {
			id: checkpoint.id,
			sequence: checkpoint.sequence,
			summary: checkpoint.summary,
		});

		return checkpoint;
	}

	/**
	 * Get the latest checkpoint
	 */
	async getLatest(): Promise<Checkpoint | null> {
		const checkpoints = await this.listCheckpoints();
		return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1]! : null;
	}

	/**
	 * Get checkpoint by ID
	 */
	async getById(id: string): Promise<Checkpoint | null> {
		const checkpoints = await this.listCheckpoints();
		return checkpoints.find((c) => c.id === id) || null;
	}

	/**
	 * List all checkpoints
	 */
	async listCheckpoints(): Promise<Checkpoint[]> {
		if (!this.checkpointDir || !existsSync(this.checkpointDir)) {
			return [];
		}

		const files = readdirSync(this.checkpointDir)
			.filter((f) => f.endsWith(".json"))
			.sort();

		const checkpoints: Checkpoint[] = [];
		for (const file of files) {
			try {
				const content = readFileSync(join(this.checkpointDir, file), "utf-8");
				checkpoints.push(JSON.parse(content));
			} catch (error) {
				logger.warn("Failed to read checkpoint", { file });
			}
		}

		return checkpoints;
	}

	/**
	 * Generate resume prompt from latest checkpoint
	 */
	async generateResumePrompt(): Promise<string | null> {
		const checkpoint = await this.getLatest();
		if (!checkpoint) return null;

		const lines = [
			"## Session Resume Context",
			"",
			`Last checkpoint: ${checkpoint.timestamp}`,
			"",
			"### Summary",
			checkpoint.summary,
			"",
		];

		if (checkpoint.completedTasks.length > 0) {
			lines.push("### Completed Tasks");
			for (const task of checkpoint.completedTasks) {
				lines.push(`- ✅ ${task}`);
			}
			lines.push("");
		}

		if (checkpoint.pendingTasks.length > 0) {
			lines.push("### Pending Tasks");
			for (const task of checkpoint.pendingTasks) {
				lines.push(`- ⏳ ${task}`);
			}
			lines.push("");
		}

		if (checkpoint.currentTask) {
			lines.push(`### Current Task: ${checkpoint.currentTask}`);
			lines.push("");
		}

		if (checkpoint.modifiedFiles && checkpoint.modifiedFiles.length > 0) {
			lines.push("### Recently Modified Files");
			for (const file of checkpoint.modifiedFiles.slice(-10)) {
				lines.push(`- ${file}`);
			}
			lines.push("");
		}

		if (checkpoint.errors && checkpoint.errors.length > 0) {
			lines.push("### Recent Errors");
			for (const error of checkpoint.errors.slice(-5)) {
				lines.push(`- ⚠️ ${error}`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Track a completed task
	 */
	markTaskComplete(task: string): void {
		this.completedTasks.push(task);
		const idx = this.pendingTasks.indexOf(task);
		if (idx >= 0) {
			this.pendingTasks.splice(idx, 1);
		}
		if (this.currentTask === task) {
			this.currentTask = null;
		}
	}

	/**
	 * Add pending tasks
	 */
	addPendingTasks(tasks: string[]): void {
		for (const task of tasks) {
			if (!this.pendingTasks.includes(task)) {
				this.pendingTasks.push(task);
			}
		}
	}

	/**
	 * Set current task
	 */
	setCurrentTask(task: string): void {
		this.currentTask = task;
	}

	/**
	 * Track a file modification
	 */
	trackFileModification(filepath: string): void {
		this.modifiedFiles.add(filepath);
	}

	/**
	 * Track an error
	 */
	trackError(error: string): void {
		this.errors.push(error);
		// Keep only last 20 errors
		if (this.errors.length > 20) {
			this.errors = this.errors.slice(-20);
		}
	}

	/**
	 * Cleanup old checkpoints beyond max limit
	 */
	private async cleanupOldCheckpoints(): Promise<void> {
		if (!this.checkpointDir) return;

		const files = readdirSync(this.checkpointDir)
			.filter((f) => f.endsWith(".json"))
			.sort();

		const toRemove = files.slice(
			0,
			Math.max(0, files.length - this.config.maxCheckpoints),
		);

		for (const file of toRemove) {
			try {
				const { unlinkSync } = await import("node:fs");
				unlinkSync(join(this.checkpointDir, file));
				logger.debug("Removed old checkpoint", { file });
			} catch {
				// Ignore removal errors
			}
		}
	}

	/**
	 * Get checkpoint statistics
	 */
	getStats(): {
		totalCheckpoints: number;
		completedTasks: number;
		pendingTasks: number;
		modifiedFiles: number;
		errors: number;
	} {
		return {
			totalCheckpoints: this.sequence,
			completedTasks: this.completedTasks.length,
			pendingTasks: this.pendingTasks.length,
			modifiedFiles: this.modifiedFiles.size,
			errors: this.errors.length,
		};
	}

	/**
	 * Cleanup resources
	 */
	cleanup(): void {
		this.stopAutoCheckpoint();
		this.sessionId = null;
		this.checkpointDir = null;
		this.sequence = 0;
		this.modifiedFiles.clear();
		this.completedTasks = [];
		this.pendingTasks = [];
		this.currentTask = null;
		this.errors = [];
	}
}

/**
 * Global session checkpoint manager
 */
export const sessionCheckpoint = new SessionCheckpointManager();

/**
 * Format checkpoint for display
 */
export function formatCheckpoint(checkpoint: Checkpoint): string {
	const lines = [
		`Checkpoint #${checkpoint.sequence}: ${checkpoint.summary}`,
		`  ID: ${checkpoint.id}`,
		`  Time: ${checkpoint.timestamp}`,
		`  Completed: ${checkpoint.completedTasks.length} tasks`,
		`  Pending: ${checkpoint.pendingTasks.length} tasks`,
	];

	if (checkpoint.currentTask) {
		lines.push(`  Current: ${checkpoint.currentTask}`);
	}

	if (checkpoint.modifiedFiles) {
		lines.push(`  Files modified: ${checkpoint.modifiedFiles.length}`);
	}

	return lines.join("\n");
}
