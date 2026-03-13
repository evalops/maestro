/**
 * Background Tasks Tool - Long-running process management with resource monitoring
 *
 * This module provides infrastructure for running, monitoring, and managing
 * background processes (dev servers, watchers, build tasks, etc.). It's designed
 * for reliability and observability in an AI agent context where processes may
 * run for extended periods without direct human oversight.
 *
 * ## Architecture Overview
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    BackgroundTaskManager                            │
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
 * │  │ Task Start  │→ │ Process     │→ │ Resource Monitor            │ │
 * │  │ & Spawn     │  │ Lifecycle   │  │ (CPU/Memory Polling)        │ │
 * │  └─────────────┘  └─────────────┘  └─────────────────────────────┘ │
 * │        ↓                ↓                       ↓                  │
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
 * │  │ Log Writer  │  │ Restart     │  │ Limit Enforcement           │ │
 * │  │ (Rotating)  │  │ Controller  │  │ (Kill on Breach)            │ │
 * │  └─────────────┘  └─────────────┘  └─────────────────────────────┘ │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Features
 *
 * ### 1. Resource Monitoring
 * Polls /proc/<pid>/stat (Linux) or ps (macOS) to track:
 * - Resident Set Size (RSS) memory usage
 * - User and system CPU time
 * - Enforces configurable limits with automatic termination
 *
 * ### 2. Automatic Restart
 * Configurable restart policy with:
 * - Fixed or exponential backoff delays
 * - Jitter to prevent thundering herd
 * - Maximum attempt limits
 * - Notifications on restart threshold
 *
 * ### 3. Log Management
 * - Per-task log files with configurable size limits
 * - Automatic rotation with gzip compression
 * - Tail access for recent output retrieval
 * - Secret redaction in log output
 *
 * ### 4. Lifecycle Management
 * - Graceful shutdown with process tree killing
 * - Automatic cleanup of finished task metadata
 * - Task retention period for post-mortem analysis
 *
 * ## Configuration via Environment Variables
 *
 * | Variable                              | Description                      | Default    |
 * |---------------------------------------|----------------------------------|------------|
 * | COMPOSER_BACKGROUND_TASK_MAX          | Max concurrent tasks             | 4          |
 * | COMPOSER_BACKGROUND_TASK_LOG_BYTES    | Per-task log size limit          | 5MB        |
 * | COMPOSER_BACKGROUND_TASK_RETENTION_MS | How long to keep finished tasks  | 10 min     |
 * | COMPOSER_BACKGROUND_TASK_MAX_RSS_KB   | Memory limit per task            | 768MB      |
 * | COMPOSER_BACKGROUND_TASK_MAX_CPU_MS   | CPU time limit per task          | 10 min     |
 * | COMPOSER_BACKGROUND_TASK_TICKS        | Clock ticks per second (Linux)   | 100        |
 *
 * @module tools/background-tasks
 */

import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

import { PATHS } from "../config/constants.js";
import {
	type BackgroundTaskSettings,
	getBackgroundTaskSettings,
	subscribeBackgroundTaskSettings,
} from "../runtime/background-settings.js";
import {
	getBackgroundTaskHistory,
	recordBackgroundTaskEvent,
} from "../telemetry.js";
import {
	readNonNegativeInt,
	readPositiveInt,
	readThresholdEnv,
} from "../utils/env-parser.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { safejoin } from "../utils/path-validation.js";
import { redactSecrets } from "../utils/secret-redactor.js";
import { resolveShellEnvironment } from "../utils/shell-env.js";
import {
	type RestartPolicy,
	createRestartPolicy,
	shouldNotifyRestart,
	updateNotifyThreshold,
} from "./background/index.js";
import {
	deleteArchives,
	previewLastLine,
	tailLogs,
} from "./background/log-files.js";
import { BackgroundTaskRuntime } from "./background/task-runtime.js";
import {
	type BackgroundTask,
	type BackgroundTaskHealth,
	type BackgroundTaskHistoryEntry,
	type BackgroundTaskLimits,
	type BackgroundTaskNotification,
	type BackgroundTaskStatus,
	type ResourceLimitBreach,
	type TaskLimitOverrides,
	type TaskRuntimeLimits,
	type TaskStartOptions,
	formatTaskSummary,
} from "./background/task-types.js";
import { killProcessTree, validateShellParams } from "./shell-utils.js";
import { ToolError } from "./tool-dsl.js";

const LOG_TAIL_BYTES = 200_000;
const DEFAULT_RSS_KB = readNonNegativeInt(
	"COMPOSER_BACKGROUND_TASK_MAX_RSS_KB",
	768 * 1024,
);
const DEFAULT_CPU_MS = readNonNegativeInt(
	"COMPOSER_BACKGROUND_TASK_MAX_CPU_MS",
	10 * 60 * 1000,
);
const RESTART_NOTIFY_THRESHOLD = readThresholdEnv(
	"COMPOSER_BACKGROUND_TASK_NOTIFY_RESTARTS",
	2,
);

const MAX_CONCURRENT_TASKS = readPositiveInt(
	"COMPOSER_BACKGROUND_TASK_MAX",
	4,
	1,
);
const MAX_LOG_FILE_BYTES = readPositiveInt(
	"COMPOSER_BACKGROUND_TASK_LOG_BYTES",
	5 * 1024 * 1024,
	50_000,
);
const TASK_RETENTION_MS = readPositiveInt(
	"COMPOSER_BACKGROUND_TASK_RETENTION_MS",
	10 * 60 * 1000,
	1_000,
);
const MAX_LOG_SEGMENTS = readPositiveInt(
	"COMPOSER_BACKGROUND_TASK_LOG_SEGMENTS",
	2,
	0,
);
// Re-export for backwards compatibility
export {
	extractProcStatFields,
	type TaskResourceUsage,
} from "./background/index.js";

export { evaluateResourceLimitBreach } from "./background/resource-limits.js";

class BackgroundTaskManager extends EventEmitter {
	private limits: BackgroundTaskLimits;
	private readonly defaultLimits: BackgroundTaskLimits;
	private tasks = new Map<string, BackgroundTask>();
	private cleanupTimers = new Map<string, NodeJS.Timeout>();
	private logDir: string | null = null;
	private logDirBase: string | null = null;
	private notificationBucket = new Map<
		string,
		{ count: number; reset: number }
	>();
	private settings: BackgroundTaskSettings;
	private unsubscribeSettings?: () => void;
	private secretCounter = 0;
	private readonly logger = createLogger("background-tasks");
	private readonly runtime = new BackgroundTaskRuntime({
		emitTaskNotification: (payload) => this.emitTaskNotification(payload),
		emitTaskTelemetry: (task, event) => this.emitTaskTelemetry(task, event),
		maybeNotifyRestart: (task, policy) => this.maybeNotifyRestart(task, policy),
		notifyFailure: (task, code, signal) =>
			this.notifyFailure(task, code, signal),
		scheduleCleanup: (task) => this.scheduleCleanup(task),
		setFailureReason: (task, reason) => this.setFailureReason(task, reason),
	});

	private ensureSettingsSubscription(): void {
		if (this.unsubscribeSettings) {
			return;
		}
		this.unsubscribeSettings = subscribeBackgroundTaskSettings((next) => {
			this.settings = next;
		});
	}

	constructor() {
		super();
		const initialLimits: BackgroundTaskLimits = {
			maxTasks: MAX_CONCURRENT_TASKS,
			logSizeLimit: MAX_LOG_FILE_BYTES,
			retentionMs: TASK_RETENTION_MS,
			logSegments: MAX_LOG_SEGMENTS,
			maxRssKb: DEFAULT_RSS_KB,
			maxCpuMs: DEFAULT_CPU_MS,
		};
		this.limits = initialLimits;
		this.defaultLimits = { ...initialLimits };
		this.settings = getBackgroundTaskSettings();
		this.ensureSettingsSubscription();
	}

	private shouldNotify(): boolean {
		return this.settings.notificationsEnabled;
	}

	private shouldEmitNotification(taskId: string): boolean {
		const now = Date.now();
		const bucket = this.notificationBucket.get(taskId);
		if (!bucket || now > bucket.reset) {
			this.notificationBucket.set(taskId, { count: 1, reset: now + 60_000 });
			return true;
		}
		if (bucket.count >= 10) {
			return false;
		}
		bucket.count += 1;
		return true;
	}

	private emitTaskNotification(payload: BackgroundTaskNotification): void {
		if (!this.shouldNotify() || !this.shouldEmitNotification(payload.taskId)) {
			return;
		}
		this.emit("notification", payload);
		if (this.settings.notificationsEnabled) {
			const logMethod =
				payload.level === "warn" ? this.logger.warn : this.logger.info;
			logMethod.call(this.logger, payload.message, {
				taskId: payload.taskId,
				reason: payload.reason,
			});
		}
	}

	private maybeNotifyRestart(
		task: BackgroundTask,
		policy: RestartPolicy,
	): void {
		if (!Number.isFinite(RESTART_NOTIFY_THRESHOLD)) {
			return;
		}
		if (!shouldNotifyRestart(policy)) {
			return;
		}
		this.emitTaskNotification({
			taskId: task.id,
			status: task.status,
			command: task.command,
			kind: "restart",
			level: "warn",
			attempts: policy.attempts,
			maxAttempts: policy.maxAttempts,
			message: `restarting (${policy.attempts}/${policy.maxAttempts})`,
			reason:
				task.exitCode !== undefined
					? `last exit ${task.exitCode}`
					: task.signal
						? `signal ${task.signal}`
						: undefined,
		});
		updateNotifyThreshold(policy);
	}

	private notifyFailure(
		task: BackgroundTask,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (task.failureReason) {
			return;
		}
		const parts: string[] = [];
		if (code !== null && code !== undefined) {
			parts.push(`exit ${code}`);
		}
		if (signal) {
			parts.push(`signal ${signal}`);
		}
		this.emitTaskNotification({
			taskId: task.id,
			status: task.status,
			command: task.command,
			kind: "failure",
			level: "warn",
			reason: parts.join(", ") || undefined,
			message: "failed without restart",
		});
	}

	configureLimits(overrides: Partial<BackgroundTaskLimits>): void {
		this.limits = { ...this.limits, ...overrides };
	}

	resetLimits(): void {
		this.limits = { ...this.defaultLimits };
	}

	private resolveTaskLimits(overrides?: TaskLimitOverrides): TaskRuntimeLimits {
		const defaults = this.limits;
		const maxBytes = 50 * 1024 * 1024;
		const limit = overrides?.logSizeLimit;
		const segments = overrides?.logSegments;
		const retention = overrides?.retentionMs;
		const rssLimit = overrides?.maxRssKb ?? defaults.maxRssKb ?? 0;
		const cpuLimit = overrides?.maxCpuMs ?? defaults.maxCpuMs ?? 0;
		const maxRssCap = 4 * 1024 * 1024; // 4 GB
		const maxCpuCap = 24 * 60 * 60 * 1000; // 24h
		return {
			logSizeLimit: Math.min(
				Math.max(limit ?? defaults.logSizeLimit, 0),
				maxBytes,
			),
			logSegments: Math.min(Math.max(segments ?? defaults.logSegments, 0), 10),
			retentionMs: Math.min(
				Math.max(retention ?? defaults.retentionMs, 1_000),
				24 * 60 * 60 * 1000,
			),
			maxRssKb: Math.min(Math.max(rssLimit, 0), maxRssCap),
			maxCpuMs: Math.min(Math.max(cpuLimit, 0), maxCpuCap),
		};
	}

	private normalizeRestartOptions(
		restart?: TaskStartOptions["restart"],
	): RestartPolicy | undefined {
		if (!restart) {
			return undefined;
		}
		return createRestartPolicy(restart, RESTART_NOTIFY_THRESHOLD);
	}

	private getLogDir(): string {
		const expanded =
			resolveEnvPath(process.env.COMPOSER_BACKGROUND_LOG_DIR) ??
			PATHS.BACKGROUND_TASK_LOG_DIR;
		const shouldRefresh =
			this.logDir === null ||
			this.logDirBase !== expanded ||
			!existsSync(this.logDir);
		if (shouldRefresh) {
			if (!existsSync(expanded)) {
				mkdirSync(expanded, { recursive: true });
			}
			this.logDir = expanded;
			this.logDirBase = expanded;
		}
		if (this.logDir === null) {
			throw new ToolError("Failed to initialize background task log directory");
		}
		return this.logDir;
	}

	private createLogPath(id: string): string {
		const dir = this.getLogDir();
		return safejoin(dir, `${id}.log`);
	}

	private emitTaskTelemetry(
		task: BackgroundTask,
		event: "started" | "restarted" | "exited" | "failed" | "stopped",
	): void {
		const failureReason = this.sanitizeFailureReason(task.failureReason);
		const command = this.sanitizeLogSnippet(task.command);
		recordBackgroundTaskEvent({
			event,
			taskId: task.id,
			status: task.status,
			command,
			shellMode: task.shellMode,
			cwd: task.cwd,
			restartAttempts: task.restartPolicy?.attempts ?? 0,
			logTruncated: task.logTruncated ?? false,
			exitCode: task.exitCode ?? undefined,
			signal: task.signal ?? undefined,
			resourceUsage: task.resourceUsage,
			failureReason,
			limitBreach: task.lastLimitBreach,
		});
	}

	private generateTaskId(): string {
		return `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
	}

	private enforceCapacity(): void {
		const running = [...this.tasks.values()].filter(
			(task) => task.status === "running" || task.status === "restarting",
		).length;
		if (running >= this.limits.maxTasks) {
			throw new ToolError(
				`Cannot start background task: maximum of ${this.limits.maxTasks} running task(s) reached.`,
			);
		}
	}

	private scheduleCleanup(task: BackgroundTask): void {
		if (this.cleanupTimers.has(task.id)) {
			return;
		}
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(task.id);
			this.removeTask(task.id);
		}, task.limits.retentionMs);
		timer.unref();
		this.cleanupTimers.set(task.id, timer);
	}

	private clearCleanupTimer(id: string): void {
		const timer = this.cleanupTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.cleanupTimers.delete(id);
		}
	}

	private removeTask(id: string, force = false): void {
		const task = this.tasks.get(id);
		if (!task) {
			return;
		}
		if (!force && (task.status === "running" || task.status === "restarting")) {
			return;
		}
		this.runtime.disposeTask(task);
		this.tasks.delete(id);
		this.clearCleanupTimer(id);
		try {
			unlinkSync(task.logPath);
		} catch {
			// Ignore cleanup errors
		}
		deleteArchives(task.logPath, task.limits.logSegments);
	}

	private cleanupExpiredTasks(force = false): void {
		const now = Date.now();
		for (const [id, task] of this.tasks.entries()) {
			if (
				(task.status === "running" || task.status === "restarting") &&
				!force
			) {
				continue;
			}
			if (
				force ||
				!task.finishedAt ||
				now - task.finishedAt >= task.limits.retentionMs
			) {
				this.removeTask(id, true);
			}
		}
	}

	private tailLog(task: BackgroundTask, lines: number): string {
		return tailLogs(
			task.logPath,
			task.limits.logSegments,
			LOG_TAIL_BYTES,
			lines,
		);
	}

	private previewLogLine(
		task: BackgroundTask,
		lines: number,
	): string | undefined {
		return previewLastLine(
			task.logPath,
			task.limits.logSegments,
			LOG_TAIL_BYTES,
			lines,
			(value) => this.sanitizeLogSnippet(value),
		);
	}

	private sanitizeLogSnippet(value: string): string {
		if (!value) {
			return value;
		}
		return redactSecrets(value, (secret) => this.maskSecret(secret));
	}

	private sanitizeFailureReason(reason?: string | null): string | undefined {
		if (!reason) {
			return undefined;
		}
		return this.sanitizeLogSnippet(reason);
	}

	private setFailureReason(task: BackgroundTask, reason: string): void {
		task.failureReason = this.sanitizeLogSnippet(reason);
	}

	private maskSecret(_raw: string): string {
		this.secretCounter += 1;
		const token = randomBytes(4).toString("hex");
		return `[secret:${this.secretCounter.toString(36)}-${token}]`;
	}

	private summarizeCommand(command: string): string {
		const trimmed = command.trim();
		const limit = 80;
		const buffer = 64;
		const sliceEnd =
			trimmed.length <= limit
				? trimmed.length
				: Math.min(trimmed.length, limit + buffer);
		const window = trimmed.slice(0, sliceEnd);
		const sanitized = this.sanitizeLogSnippet(window);
		if (sanitized.length <= limit) {
			return sanitized;
		}
		const truncated = sanitized.slice(0, limit - 1);
		const lastOpen = truncated.lastIndexOf("[secret");
		const lastClose = truncated.lastIndexOf("]");
		const safeSlice =
			lastOpen !== -1 && (lastClose === -1 || lastClose < lastOpen)
				? truncated.slice(0, lastOpen)
				: truncated;
		return `${safeSlice}…`;
	}

	private async waitForCompletion(
		task: BackgroundTask,
		timeoutMs: number,
	): Promise<boolean> {
		let timeout: NodeJS.Timeout | undefined;
		const result = await Promise.race([
			task.completion.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
		if (timeout) {
			clearTimeout(timeout);
		}
		return result;
	}

	start(command: string, options: TaskStartOptions = {}): BackgroundTask {
		this.ensureSettingsSubscription();
		this.cleanupExpiredTasks();
		this.enforceCapacity();
		const { cwd, env, useShell = false, restart } = options;
		const id = this.generateTaskId();
		const { resolvedCwd } = validateShellParams(command, cwd, env);
		const resolvedEnv = resolveShellEnvironment(env, {
			workspaceDir: process.cwd(),
		});
		const logPath = this.createLogPath(id);
		const taskLimits = this.resolveTaskLimits(options.limits);
		const task: BackgroundTask = {
			id,
			command,
			cwd: resolvedCwd,
			env: resolvedEnv,
			startedAt: Date.now(),
			pid: undefined,
			status: "running",
			logPath,
			process: {} as BackgroundTask["process"],
			completion: Promise.resolve(),
			shellMode: useShell ? "shell" : "exec",
			restartPolicy: this.normalizeRestartOptions(restart),
			restartTimer: null,
			logTruncated: false,
			limits: taskLimits,
			monitoringMode: "disabled",
		};

		this.tasks.set(id, task);
		this.runtime.launchProcess(task);
		return task;
	}

	getTasks(): BackgroundTask[] {
		this.cleanupExpiredTasks();
		return [...this.tasks.values()];
	}

	getTask(id: string): BackgroundTask | undefined {
		this.cleanupExpiredTasks();
		return this.tasks.get(id);
	}

	getHealthSnapshot(options?: {
		maxEntries?: number;
		logLines?: number;
		historyLimit?: number;
	}): BackgroundTaskHealth | null {
		this.ensureSettingsSubscription();
		const tasks = this.getTasks();
		const maxEntries = Math.max(1, options?.maxEntries ?? 3);
		const logLines = Math.max(1, options?.logLines ?? 1);
		const includeDetails = this.settings.statusDetailsEnabled;
		const historyLimit = Math.max(1, options?.historyLimit ?? 10);
		const rawHistory = includeDetails
			? getBackgroundTaskHistory(historyLimit)
			: [];
		if (tasks.length === 0 && rawHistory.length === 0) {
			return null;
		}
		const sorted = [...tasks].sort((a, b) => b.startedAt - a.startedAt);
		const detailedEntries = includeDetails
			? sorted.slice(0, maxEntries).map((task) => {
					const issues: string[] = [];
					if (task.failureReason) {
						issues.push(task.failureReason);
					}
					if (
						task.restartPolicy &&
						Number.isFinite(RESTART_NOTIFY_THRESHOLD) &&
						task.restartPolicy.attempts >= RESTART_NOTIFY_THRESHOLD
					) {
						issues.push(
							`Restart attempts ${task.restartPolicy.attempts}/${task.restartPolicy.maxAttempts}`,
						);
					}
					if (task.logTruncated) {
						issues.push("Logs truncated");
					}
					const restarts = task.restartPolicy
						? `${task.restartPolicy.attempts}/${task.restartPolicy.maxAttempts}`
						: undefined;
					const durationMs = (task.finishedAt ?? Date.now()) - task.startedAt;
					return {
						id: task.id,
						status: task.status,
						summary: this.sanitizeLogSnippet(formatTaskSummary(task)),
						command: this.summarizeCommand(task.command),
						restarts,
						issues,
						lastLogLine: this.previewLogLine(task, logLines),
						logTruncated: task.logTruncated ?? false,
						durationSeconds: Math.max(1, Math.round(durationMs / 1000)),
					};
				})
			: [];
		const history: BackgroundTaskHistoryEntry[] = rawHistory.map((entry) => ({
			event: entry.event,
			taskId: entry.taskId,
			status: entry.status as BackgroundTaskStatus,
			command: this.summarizeCommand(entry.command),
			timestamp: entry.timestamp,
			restartAttempts: entry.restartAttempts,
			failureReason: entry.failureReason
				? this.sanitizeLogSnippet(entry.failureReason)
				: undefined,
			limitBreach: entry.limitBreach,
		}));
		return {
			total: tasks.length,
			running: tasks.filter((task) => task.status === "running").length,
			restarting: tasks.filter((task) => task.status === "restarting").length,
			failed: tasks.filter((task) => task.status === "failed").length,
			entries: detailedEntries,
			truncated: includeDetails && tasks.length > detailedEntries.length,
			notificationsEnabled: this.settings.notificationsEnabled,
			detailsRedacted: !includeDetails,
			history,
			historyTruncated: includeDetails && rawHistory.length === historyLimit,
		};
	}

	async stopTask(
		id: string,
	): Promise<{ task: BackgroundTask; stopped: boolean } | null> {
		const task = this.tasks.get(id);
		if (!task) {
			return null;
		}
		task.stopRequested = true;
		this.runtime.disableRestart(task);
		if (task.status === "restarting") {
			this.runtime.stopUsageMonitor(task);
			task.status = "stopped";
			task.finishedAt = Date.now();
			this.scheduleCleanup(task);
			return { task, stopped: true };
		}
		if (task.status !== "running") {
			return { task, stopped: false };
		}
		if (!task.pid) {
			return { task, stopped: false };
		}

		killProcessTree(task.pid);
		const stopped = await this.waitForCompletion(task, 2000);
		return { task, stopped };
	}

	async stopAll(): Promise<void> {
		const stops = [...this.tasks.keys()].map((id) => this.stopTask(id));
		await Promise.all(stops);
		this.cleanupExpiredTasks(true);
	}

	clear(): void {
		this.unsubscribeSettings?.();
		this.unsubscribeSettings = undefined;
		for (const id of [...this.tasks.keys()]) {
			this.removeTask(id, true);
		}
		this.tasks.clear();
		for (const timer of this.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		this.cleanupTimers.clear();
	}

	getLogs(taskId: string, lines: number): string {
		const task = this.tasks.get(taskId);
		if (!task) {
			throw new ToolError(`Task not found or logs expired: ${taskId}`);
		}
		const text = this.tailLog(task, lines);
		if (!task.logTruncated) {
			return text;
		}
		const limitKb = Math.round(task.limits.logSizeLimit / 1024);
		const notice = `Log output truncated at ${limitKb} KB.`;
		return `${text}\n\n${notice}`;
	}
}

export const backgroundTaskManager = new BackgroundTaskManager();

// Re-export types used by downstream consumers
export type {
	BackgroundTaskHealth,
	BackgroundTaskHealthEntry,
	BackgroundTaskNotification,
} from "./background/task-types.js";
export { backgroundTasksTool } from "./background/tool-handler.js";

export function formatTaskFailures(): string | null {
	const tasks = backgroundTaskManager.getTasks();
	const failedTasks = tasks.filter((task) => task.status === "failed");

	if (failedTasks.length === 0) {
		return null;
	}

	// Only show recent failures (last 5 minutes) to avoid nagging about old news
	const RECENT_THRESHOLD = 5 * 60 * 1000;
	const now = Date.now();
	const recentFailures = failedTasks.filter((task) => {
		if (!task.finishedAt) return false;
		return now - task.finishedAt < RECENT_THRESHOLD;
	});

	if (recentFailures.length === 0) {
		return null;
	}

	const lines = ["# ⚠️ Background Task Alerts"];
	for (const task of recentFailures) {
		const reason = task.failureReason
			? `Reason: ${task.failureReason}`
			: typeof task.exitCode === "number" && task.exitCode !== 0
				? `Exit Code: ${task.exitCode}`
				: "Exited unexpectedly";
		lines.push(`- Task "${task.command}" (${task.id}) stopped. ${reason}`);
		// Add a hint about logs
		lines.push(
			`  (Use background_tasks action=logs taskId=${task.id} to investigate)`,
		);
	}

	return lines.join("\n");
}
