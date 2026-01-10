/**
 * Session Auto-Recovery System
 *
 * Provides automatic session recovery when context limits are reached or
 * sessions crash unexpectedly. Similar to Claude Code's session recovery
 * with resumable conversation state.
 *
 * Environment variables:
 * - COMPOSER_SESSION_RECOVERY_ENABLED: Enable/disable auto-recovery (default: true)
 * - COMPOSER_SESSION_BACKUP_DIR: Directory for session backups
 * - COMPOSER_SESSION_BACKUP_INTERVAL: Interval between backups in ms (default: 60000)
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import type { AppMessage } from "./types.js";

const logger = createLogger("session-recovery");

/**
 * Session backup data for recovery.
 */
export interface SessionBackup {
	/** Unique session ID */
	sessionId: string;
	/** Messages in the session */
	messages: AppMessage[];
	/** System prompt used */
	systemPrompt?: string;
	/** Model ID */
	modelId?: string;
	/** When the backup was created */
	createdAt: string;
	/** When the session started */
	sessionStartedAt: string;
	/** Git state when session started */
	gitState?: {
		branch?: string;
		commitSha?: string;
		isDirty?: boolean;
	};
	/** Recovery reason if this is a recovered session */
	recoveryReason?: string;
	/** Number of recovery attempts */
	recoveryAttempts: number;
	/** Working directory */
	cwd?: string;
	/** Summary of conversation for quick resume */
	summary?: string;
}

/**
 * Configuration for session recovery.
 */
export interface SessionRecoveryConfig {
	/** Whether recovery is enabled */
	enabled: boolean;
	/** Directory to store session backups */
	backupDir: string;
	/** Interval between automatic backups (ms) */
	backupInterval: number;
	/** Maximum number of backups to keep per session */
	maxBackupsPerSession: number;
	/** Maximum age of backups to keep (ms) */
	maxBackupAge: number;
}

const DEFAULT_CONFIG: SessionRecoveryConfig = {
	enabled: true,
	backupDir: join(PATHS.COMPOSER_HOME, "session-backups"),
	backupInterval: 60000, // 1 minute
	maxBackupsPerSession: 3,
	maxBackupAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Get session recovery configuration from environment.
 */
export function getSessionRecoveryConfig(): SessionRecoveryConfig {
	const enabled = process.env.COMPOSER_SESSION_RECOVERY_ENABLED !== "false";
	const backupDir =
		resolveEnvPath(process.env.COMPOSER_SESSION_BACKUP_DIR) ??
		DEFAULT_CONFIG.backupDir;
	const backupInterval = Number.parseInt(
		process.env.COMPOSER_SESSION_BACKUP_INTERVAL || "60000",
		10,
	);

	return {
		...DEFAULT_CONFIG,
		enabled,
		backupDir,
		backupInterval: Number.isNaN(backupInterval)
			? DEFAULT_CONFIG.backupInterval
			: Math.max(10000, backupInterval), // Min 10 seconds
	};
}

/**
 * Ensure the backup directory exists.
 */
function ensureBackupDir(config: SessionRecoveryConfig): void {
	if (!existsSync(config.backupDir)) {
		mkdirSync(config.backupDir, { recursive: true });
	}
}

/**
 * Generate a backup file path.
 */
function getBackupFilePath(
	sessionId: string,
	config: SessionRecoveryConfig,
	timestamp?: string,
): string {
	const ts = timestamp || new Date().toISOString().replace(/[:.]/g, "-");
	return join(config.backupDir, `${sessionId}-${ts}.json`);
}

/**
 * Save a session backup.
 */
export function saveSessionBackup(
	backup: SessionBackup,
	config: SessionRecoveryConfig = getSessionRecoveryConfig(),
): string | null {
	if (!config.enabled) {
		return null;
	}

	try {
		ensureBackupDir(config);
		const filePath = getBackupFilePath(backup.sessionId, config);
		writeFileSync(filePath, JSON.stringify(backup, null, 2));
		logger.info("Session backup saved", {
			sessionId: backup.sessionId,
			messageCount: backup.messages.length,
		});

		// Clean up old backups
		cleanupOldBackups(backup.sessionId, config);

		return filePath;
	} catch (err) {
		logger.error(
			"Failed to save session backup",
			err instanceof Error ? err : new Error(String(err)),
		);
		return null;
	}
}

/**
 * Load the most recent backup for a session.
 */
export function loadSessionBackup(
	sessionId: string,
	config: SessionRecoveryConfig = getSessionRecoveryConfig(),
): SessionBackup | null {
	try {
		if (!existsSync(config.backupDir)) {
			return null;
		}

		const files = readdirSync(config.backupDir)
			.filter((f) => f.startsWith(sessionId) && f.endsWith(".json"))
			.sort()
			.reverse();

		if (files.length === 0) {
			return null;
		}

		const filePath = join(config.backupDir, files[0]!);
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as SessionBackup;
	} catch (err) {
		logger.warn("Failed to load session backup", {
			reason: err instanceof Error ? err.message : String(err),
			sessionId,
		});
		return null;
	}
}

/**
 * List all available session backups.
 */
export function listSessionBackups(
	config: SessionRecoveryConfig = getSessionRecoveryConfig(),
): SessionBackup[] {
	try {
		if (!existsSync(config.backupDir)) {
			return [];
		}

		const files = readdirSync(config.backupDir)
			.filter((f) => f.endsWith(".json"))
			.sort()
			.reverse();

		const backups: SessionBackup[] = [];
		const seenSessions = new Set<string>();

		for (const file of files) {
			try {
				const filePath = join(config.backupDir, file);
				const raw = readFileSync(filePath, "utf-8");
				const backup = JSON.parse(raw) as SessionBackup;

				// Only include the most recent backup per session
				if (!seenSessions.has(backup.sessionId)) {
					seenSessions.add(backup.sessionId);
					backups.push(backup);
				}
			} catch {
				// Skip invalid files
			}
		}

		return backups;
	} catch (err) {
		logger.warn("Failed to list session backups", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

/**
 * Clean up old backups for a session.
 */
function cleanupOldBackups(
	sessionId: string,
	config: SessionRecoveryConfig,
): void {
	try {
		if (!existsSync(config.backupDir)) {
			return;
		}

		const files = readdirSync(config.backupDir)
			.filter((f) => f.startsWith(sessionId) && f.endsWith(".json"))
			.sort()
			.reverse();

		// Keep only the most recent backups
		const toDelete = files.slice(config.maxBackupsPerSession);
		for (const file of toDelete) {
			try {
				unlinkSync(join(config.backupDir, file));
			} catch {
				// Ignore deletion errors
			}
		}
	} catch (err) {
		logger.warn("Failed to clean up old backups", {
			reason: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Clean up all expired backups.
 */
export function cleanupExpiredBackups(
	config: SessionRecoveryConfig = getSessionRecoveryConfig(),
): number {
	try {
		if (!existsSync(config.backupDir)) {
			return 0;
		}

		const now = Date.now();
		const files = readdirSync(config.backupDir).filter((f) =>
			f.endsWith(".json"),
		);

		let deleted = 0;
		for (const file of files) {
			try {
				const filePath = join(config.backupDir, file);
				const raw = readFileSync(filePath, "utf-8");
				const backup = JSON.parse(raw) as SessionBackup;
				const createdAt = new Date(backup.createdAt).getTime();

				if (now - createdAt > config.maxBackupAge) {
					unlinkSync(filePath);
					deleted++;
				}
			} catch {
				// Skip invalid files
			}
		}

		if (deleted > 0) {
			logger.info("Cleaned up expired backups", { deleted });
		}

		return deleted;
	} catch (err) {
		logger.warn("Failed to clean up expired backups", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return 0;
	}
}

/**
 * Delete a specific session's backups.
 */
export function deleteSessionBackups(
	sessionId: string,
	config: SessionRecoveryConfig = getSessionRecoveryConfig(),
): number {
	try {
		if (!existsSync(config.backupDir)) {
			return 0;
		}

		const files = readdirSync(config.backupDir).filter(
			(f) => f.startsWith(sessionId) && f.endsWith(".json"),
		);

		let deleted = 0;
		for (const file of files) {
			try {
				unlinkSync(join(config.backupDir, file));
				deleted++;
			} catch {
				// Ignore deletion errors
			}
		}

		if (deleted > 0) {
			logger.info("Deleted session backups", { sessionId, deleted });
		}

		return deleted;
	} catch (err) {
		logger.warn("Failed to delete session backups", {
			reason: err instanceof Error ? err.message : String(err),
			sessionId,
		});
		return 0;
	}
}

/**
 * Session recovery manager that handles automatic backups.
 */
export class SessionRecoveryManager {
	private config: SessionRecoveryConfig;
	private backupTimer: ReturnType<typeof setInterval> | null = null;
	private currentBackup: SessionBackup | null = null;

	constructor(config?: Partial<SessionRecoveryConfig>) {
		this.config = { ...getSessionRecoveryConfig(), ...config };
	}

	/**
	 * Start a new session for backup tracking.
	 */
	startSession(options: {
		sessionId: string;
		systemPrompt?: string;
		modelId?: string;
		cwd?: string;
		gitState?: SessionBackup["gitState"];
	}): void {
		const now = new Date().toISOString();
		this.currentBackup = {
			sessionId: options.sessionId,
			messages: [],
			systemPrompt: options.systemPrompt,
			modelId: options.modelId,
			createdAt: now,
			sessionStartedAt: now,
			gitState: options.gitState,
			recoveryAttempts: 0,
			cwd: options.cwd,
		};

		// Start automatic backup timer
		this.startAutoBackup();

		logger.info("Session started for recovery tracking", {
			sessionId: options.sessionId,
		});
	}

	/**
	 * Update messages in the current backup.
	 */
	updateMessages(messages: AppMessage[]): void {
		if (this.currentBackup) {
			this.currentBackup.messages = messages;
			this.currentBackup.createdAt = new Date().toISOString();
		}
	}

	/**
	 * Update the summary for quick resume.
	 */
	updateSummary(summary: string): void {
		if (this.currentBackup) {
			this.currentBackup.summary = summary;
		}
	}

	/**
	 * Force an immediate backup.
	 */
	forceBackup(): string | null {
		if (!this.currentBackup) {
			return null;
		}
		return saveSessionBackup(this.currentBackup, this.config);
	}

	/**
	 * Mark the current session as recovered.
	 */
	markRecovered(reason: string): void {
		if (this.currentBackup) {
			this.currentBackup.recoveryReason = reason;
			this.currentBackup.recoveryAttempts++;
		}
	}

	/**
	 * End the current session.
	 */
	endSession(): void {
		if (this.backupTimer) {
			clearInterval(this.backupTimer);
			this.backupTimer = null;
		}

		// Final backup
		if (this.currentBackup) {
			this.forceBackup();
		}

		this.currentBackup = null;
		logger.info("Session ended");
	}

	/**
	 * Start automatic periodic backups.
	 */
	private startAutoBackup(): void {
		if (this.backupTimer) {
			clearInterval(this.backupTimer);
		}

		if (!this.config.enabled || this.config.backupInterval <= 0) {
			return;
		}

		this.backupTimer = setInterval(() => {
			if (this.currentBackup && this.currentBackup.messages.length > 0) {
				this.forceBackup();
			}
		}, this.config.backupInterval);

		// Ensure timer doesn't keep process alive
		if (this.backupTimer.unref) {
			this.backupTimer.unref();
		}
	}

	/**
	 * Get the current backup state.
	 */
	getCurrentBackup(): SessionBackup | null {
		return this.currentBackup;
	}

	/**
	 * Check if there's a recoverable session.
	 */
	hasRecoverableSession(sessionId: string): boolean {
		const backup = loadSessionBackup(sessionId, this.config);
		return backup !== null && backup.messages.length > 0;
	}

	/**
	 * Recover a session.
	 */
	recoverSession(sessionId: string): SessionBackup | null {
		const backup = loadSessionBackup(sessionId, this.config);
		if (!backup) {
			return null;
		}

		// Start tracking the recovered session
		this.currentBackup = {
			...backup,
			recoveryReason: "manual_recovery",
			recoveryAttempts: backup.recoveryAttempts + 1,
			createdAt: new Date().toISOString(),
		};

		this.startAutoBackup();

		logger.info("Session recovered", {
			sessionId,
			messageCount: backup.messages.length,
			attempts: this.currentBackup.recoveryAttempts,
		});

		return this.currentBackup;
	}
}

/**
 * Create a default session recovery manager.
 */
export function createSessionRecoveryManager(
	config?: Partial<SessionRecoveryConfig>,
): SessionRecoveryManager {
	return new SessionRecoveryManager(config);
}
