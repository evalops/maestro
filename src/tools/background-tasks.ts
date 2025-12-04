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

import {
	type ChildProcess,
	type SpawnOptions,
	execSync,
	spawn,
} from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";
import { StringEnum } from "../agent/providers/typebox-helpers.js";

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
	readBooleanEnv,
	readNonNegativeInt,
	readPositiveInt,
	readThresholdEnv,
} from "../utils/env-parser.js";
import { isErrno } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { safejoin } from "../utils/path-validation.js";
import { redactSecrets } from "../utils/secret-redactor.js";
import {
	ResourceMonitor,
	type RestartPolicy,
	type RestartPolicyOptions,
	RotatingLogWriter,
	type RotatingLogWriterOptions,
	type TaskResourceUsage,
	canRestart,
	computeRestartDelay,
	createRestartPolicy,
	extractProcStatFields,
	incrementAttempts,
	shouldNotifyRestart,
	updateNotifyThreshold,
} from "./background/index.js";
import {
	archivedLogPath,
	deleteArchives,
	previewLastLine,
	rotateArchives,
	tailLogs,
} from "./background/log-files.js";
import {
	getShellConfig,
	killProcessTree,
	parseCommandArguments,
	validateShellParams,
} from "./shell-utils.js";
import { ToolError, createTool, expandUserPath } from "./tool-dsl.js";
import type { ToolResponseBuilder } from "./tool-dsl.js";

const LOG_TAIL_BYTES = 200_000;
const DEFAULT_RSS_KB = readNonNegativeInt(
	"COMPOSER_BACKGROUND_TASK_MAX_RSS_KB",
	768 * 1024,
);
const DEFAULT_CPU_MS = readNonNegativeInt(
	"COMPOSER_BACKGROUND_TASK_MAX_CPU_MS",
	10 * 60 * 1000,
);
const RESOURCE_POLL_INTERVAL_MS = 200;
const RESTART_NOTIFY_THRESHOLD = readThresholdEnv(
	"COMPOSER_BACKGROUND_TASK_NOTIFY_RESTARTS",
	2,
);

type ChildProcessWithUsage = ChildProcess & {
	resourceUsage?: () => {
		maxRSS: number;
		userCPUTime: number;
		systemCPUTime: number;
	};
};

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
type BackgroundTaskStatus =
	| "running"
	| "stopped"
	| "exited"
	| "failed"
	| "restarting";

// Re-export for backwards compatibility
export { type TaskResourceUsage, extractProcStatFields };

interface BackgroundTask {
	id: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	startedAt: number;
	pid?: number;
	status: BackgroundTaskStatus;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	logPath: string;
	process: ChildProcess;
	completion: Promise<void>;
	stopRequested?: boolean;
	shellMode: "shell" | "exec";
	finishedAt?: number;
	logTruncated?: boolean;
	restartPolicy?: RestartPolicy;
	restartTimer?: NodeJS.Timeout | null;
	resourceUsage?: TaskResourceUsage;
	usageMonitor?: NodeJS.Timeout | null;
	monitoringMode?: "proc" | "ps" | "disabled";
	limits: TaskRuntimeLimits;
	terminatingForLimits?: boolean;
	failureReason?: string;
	lastLimitBreach?: ResourceLimitBreach;
}

interface TaskStartOptions {
	cwd?: string;
	env?: Record<string, string>;
	useShell?: boolean;
	restart?: RestartPolicyOptions;
	limits?: TaskLimitOverrides;
}

interface BackgroundTaskLimits {
	maxTasks: number;
	logSizeLimit: number;
	retentionMs: number;
	logSegments: number;
	maxRssKb?: number;
	maxCpuMs?: number;
}

type TaskLimitOverrides = Partial<
	Pick<
		BackgroundTaskLimits,
		"logSizeLimit" | "logSegments" | "retentionMs" | "maxRssKb" | "maxCpuMs"
	>
>;

interface TaskRuntimeLimits {
	logSizeLimit: number;
	logSegments: number;
	retentionMs: number;
	maxRssKb?: number;
	maxCpuMs?: number;
}

export interface BackgroundTaskNotification {
	taskId: string;
	status: BackgroundTaskStatus;
	command: string;
	kind: "restart" | "failure" | "limit";
	message: string;
	level: "info" | "warn";
	attempts?: number;
	maxAttempts?: number;
	reason?: string;
}

export interface BackgroundTaskHealthEntry {
	id: string;
	status: BackgroundTaskStatus;
	summary: string;
	command: string;
	restarts?: string;
	issues: string[];
	lastLogLine?: string;
	logTruncated?: boolean;
	durationSeconds: number;
}

type BackgroundTaskHistoryEvent =
	| "started"
	| "restarted"
	| "exited"
	| "failed"
	| "stopped";

export interface BackgroundTaskHistoryEntry {
	event: BackgroundTaskHistoryEvent;
	taskId: string;
	status: BackgroundTaskStatus;
	command: string;
	timestamp: string;
	restartAttempts: number;
	failureReason?: string;
	limitBreach?: ResourceLimitBreach;
}

export interface BackgroundTaskHealth {
	total: number;
	running: number;
	restarting: number;
	failed: number;
	entries: BackgroundTaskHealthEntry[];
	truncated: boolean;
	notificationsEnabled: boolean;
	detailsRedacted: boolean;
	history: BackgroundTaskHistoryEntry[];
	historyTruncated: boolean;
}

function formatTaskSummary(task: BackgroundTask): string {
	const durationMs = (task.finishedAt ?? Date.now()) - task.startedAt;
	const statusParts = [`status=${task.status}`];
	if (task.stopRequested && task.status === "running") {
		statusParts.push("stopping");
	}
	if (task.restartPolicy) {
		const pending = task.restartPolicy.attempts;
		const max = task.restartPolicy.maxAttempts;
		if (max > 0 && (pending > 0 || task.status === "restarting")) {
			statusParts.push(`restarts=${pending}/${max}`);
		}
	}
	if (task.exitCode !== undefined) {
		statusParts.push(`exit=${task.exitCode}`);
	}
	if (task.signal) {
		statusParts.push(`signal=${task.signal}`);
	}
	if (task.finishedAt && task.status !== "running") {
		statusParts.push(
			`finished=${Math.max(1, Math.round((Date.now() - task.finishedAt) / 1000))}s ago`,
		);
	}
	if (task.logTruncated) {
		statusParts.push("logs=truncated");
	}
	const usageSummary = formatUsageSummary(task.resourceUsage);
	if (usageSummary) {
		statusParts.push(usageSummary);
	}
	const pidLabel = task.pid ? `pid=${task.pid}` : "pid=unknown";
	const durationLabel =
		task.status === "running"
			? `running for ${Math.max(1, Math.round(durationMs / 1000))}s`
			: `elapsed ${Math.max(1, Math.round(durationMs / 1000))}s`;
	return `${task.id} (${pidLabel}, ${statusParts.join(", ")}, ${durationLabel})`;
}

function formatUsageSummary(usage?: TaskResourceUsage): string | null {
	if (!usage) {
		return null;
	}
	const parts: string[] = [];
	if (usage.maxRssKb !== undefined) {
		const mb = usage.maxRssKb / 1024;
		parts.push(`rss=${mb.toFixed(1)}MB`);
	}
	if (usage.userMs !== undefined || usage.systemMs !== undefined) {
		const cpuParts = [];
		if (usage.userMs !== undefined) {
			cpuParts.push(`user=${Math.round(usage.userMs)}ms`);
		}
		if (usage.systemMs !== undefined) {
			cpuParts.push(`sys=${Math.round(usage.systemMs)}ms`);
		}
		if (cpuParts.length > 0) {
			parts.push(`cpu(${cpuParts.join(", ")})`);
		}
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

export interface ResourceLimitBreach {
	kind: "memory" | "cpu";
	limit: number;
	actual: number;
}

/**
 * Evaluate Resource Usage Against Limits
 *
 * Checks whether a task's resource consumption has exceeded its configured
 * limits. Returns information about the first breach found (memory takes
 * priority over CPU since it's usually more urgent).
 *
 * ## Check Order
 *
 * 1. Memory (RSS): Checked first because memory exhaustion can crash the system
 * 2. CPU Time: Checked second; CPU-bound tasks are less dangerous but wasteful
 *
 * ## Limit Values
 *
 * A limit of 0 means "unlimited" - the check is skipped for that resource.
 * This allows users to disable specific limits while keeping others.
 *
 * ## Usage in Monitoring Loop
 *
 * This function is called every RESOURCE_POLL_INTERVAL_MS (200ms) by the
 * monitoring timer. If a breach is detected, the task is terminated via
 * enforceRuntimeLimits().
 *
 * @param usage - Current resource usage snapshot (may be undefined early in lifecycle)
 * @param limits - Configured limits from task or global defaults
 * @returns Breach info if limit exceeded, null if within limits
 */
export function evaluateResourceLimitBreach(
	usage: TaskResourceUsage | undefined,
	limits: Pick<TaskRuntimeLimits, "maxRssKb" | "maxCpuMs">,
): ResourceLimitBreach | null {
	// No usage data yet (process just started)
	if (!usage) {
		return null;
	}

	// Check memory limit first (more critical - can crash system)
	const rssLimit = limits.maxRssKb ?? 0;
	const cpuLimit = limits.maxCpuMs ?? 0;

	// Memory check: 0 means unlimited
	if (rssLimit > 0 && (usage.maxRssKb ?? 0) > rssLimit) {
		return {
			kind: "memory",
			limit: rssLimit,
			actual: usage.maxRssKb ?? 0,
		};
	}

	// CPU check: combine user + system time
	const totalCpu = (usage.userMs ?? 0) + (usage.systemMs ?? 0);
	if (cpuLimit > 0 && totalCpu > cpuLimit) {
		return {
			kind: "cpu",
			limit: cpuLimit,
			actual: totalCpu,
		};
	}

	// All limits satisfied
	return null;
}

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
	private readonly resourceMonitor = new ResourceMonitor();

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

	private createChildProcess(task: BackgroundTask): ChildProcess {
		const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...task.env };
		const spawnOptions: SpawnOptions = {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			cwd: task.cwd,
			env: mergedEnv,
		};
		if (task.shellMode === "shell") {
			const { shell, args } = getShellConfig();
			return spawn(shell, [...args, task.command], spawnOptions);
		}
		let parsed: string[];
		try {
			parsed = parseCommandArguments(task.command);
		} catch (error) {
			throw new ToolError(
				error instanceof Error
					? error.message
					: "Failed to parse command arguments",
			);
		}
		if (parsed.length === 0) {
			throw new ToolError("Command must contain an executable to run");
		}
		return spawn(parsed[0], parsed.slice(1), spawnOptions);
	}

	private launchProcess(task: BackgroundTask): void {
		const child = this.createChildProcess(task);
		this.attachLogging(child, task);
		task.process = child;
		task.failureReason = undefined;
		task.lastLimitBreach = undefined;
		task.pid = child.pid ?? undefined;
		this.startUsageMonitor(task);
		task.status = "running";
		task.stopRequested = false;
		task.exitCode = undefined;
		task.signal = undefined;
		task.finishedAt = undefined;
		task.completion = new Promise<void>((resolve) => {
			child.once("exit", (code, signal) => {
				this.handleChildExit(task, child, resolve, code, signal);
			});
			child.once("error", (error) => {
				this.handleChildError(task, child, resolve, error as Error);
			});
		});
		this.emitTaskTelemetry(task, "started");
	}

	private handleChildExit(
		task: BackgroundTask,
		child: ChildProcess,
		resolve: () => void,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (task.process !== child) {
			resolve();
			return;
		}
		task.exitCode = code;
		task.signal = signal;
		task.pid = undefined;
		this.stopUsageMonitor(task);
		this.captureResourceUsage(task, child);
		task.terminatingForLimits = false;
		const forcedFailure = Boolean(task.failureReason);
		if (forcedFailure) {
			this.disableRestart(task);
		}
		if (task.stopRequested) {
			task.status = "stopped";
			task.finishedAt = Date.now();
			this.scheduleCleanup(task);
			this.emitTaskTelemetry(task, "stopped");
			resolve();
			return;
		}
		if (!forcedFailure && code === 0) {
			task.status = "exited";
			task.finishedAt = Date.now();
			this.scheduleCleanup(task);
			this.emitTaskTelemetry(task, "exited");
			resolve();
			return;
		}
		if (!forcedFailure && this.scheduleRestart(task)) {
			resolve();
			return;
		}
		task.status = "failed";
		task.finishedAt = Date.now();
		this.scheduleCleanup(task);
		this.emitTaskTelemetry(task, "failed");
		if (!forcedFailure) {
			this.notifyFailure(task, code, signal);
		}
		resolve();
	}

	private handleChildError(
		task: BackgroundTask,
		child: ChildProcess,
		resolve: () => void,
		error: Error,
	): void {
		if (task.process !== child) {
			resolve();
			return;
		}
		task.pid = undefined;
		this.stopUsageMonitor(task);
		this.captureResourceUsage(task, child);
		task.terminatingForLimits = false;
		const forcedFailure = Boolean(task.failureReason);
		if (forcedFailure) {
			this.disableRestart(task);
		}
		if (!forcedFailure && this.scheduleRestart(task)) {
			resolve();
			return;
		}
		task.status = "failed";
		task.finishedAt = Date.now();
		this.scheduleCleanup(task);
		this.emitTaskTelemetry(task, "failed");
		if (!forcedFailure) {
			this.notifyFailure(task, null, null);
		}
		resolve();
	}

	private captureResourceUsage(
		task: BackgroundTask,
		child: ChildProcess,
	): void {
		const { resourceUsage } = child as ChildProcessWithUsage;
		if (typeof resourceUsage !== "function") {
			return;
		}
		try {
			const usage = resourceUsage.call(child);
			if (!task.resourceUsage) {
				task.resourceUsage = {};
			}
			const target = task.resourceUsage;
			if (usage.maxRSS) {
				target.maxRssKb = Math.max(target.maxRssKb ?? 0, usage.maxRSS);
			}
			if (usage.userCPUTime) {
				target.userMs = Math.max(target.userMs ?? 0, usage.userCPUTime / 1000);
			}
			if (usage.systemCPUTime) {
				target.systemMs = Math.max(
					target.systemMs ?? 0,
					usage.systemCPUTime / 1000,
				);
			}
		} catch {
			// Ignore metrics errors
		}
		this.enforceRuntimeLimits(task);
	}

	private scheduleRestart(task: BackgroundTask): boolean {
		const policy = task.restartPolicy;
		if (!policy || task.stopRequested) {
			return false;
		}
		if (!canRestart(policy)) {
			return false;
		}
		incrementAttempts(policy);
		task.status = "restarting";
		this.emitTaskTelemetry(task, "restarted");
		this.maybeNotifyRestart(task, policy);
		this.cancelRestart(task);
		const delay = computeRestartDelay(policy);
		task.restartTimer = setTimeout(() => {
			task.restartTimer = null;
			this.launchProcess(task);
		}, delay);
		if (task.restartTimer.unref) {
			task.restartTimer.unref();
		}
		return true;
	}

	private cancelRestart(task: BackgroundTask): void {
		if (task.restartTimer) {
			clearTimeout(task.restartTimer);
			task.restartTimer = null;
		}
	}

	private disableRestart(task: BackgroundTask): void {
		this.cancelRestart(task);
		task.restartPolicy = undefined;
	}

	private startUsageMonitor(task: BackgroundTask): void {
		if (!task.pid || task.usageMonitor) {
			return;
		}
		const mode = this.getMonitoringMode();
		task.monitoringMode = mode;
		if (mode === "disabled") {
			return;
		}
		this.sampleResourceUsage(task);
		const monitor = setInterval(() => {
			this.sampleResourceUsage(task);
		}, RESOURCE_POLL_INTERVAL_MS);
		if (monitor.unref) {
			monitor.unref();
		}
		task.usageMonitor = monitor;
	}

	private stopUsageMonitor(task: BackgroundTask): void {
		if (task.usageMonitor) {
			clearInterval(task.usageMonitor);
			task.usageMonitor = null;
		}
	}

	private getMonitoringMode(): "proc" | "ps" | "disabled" {
		return this.resourceMonitor.getMode();
	}

	private sampleResourceUsage(task: BackgroundTask): void {
		if (!task.pid) {
			this.stopUsageMonitor(task);
			return;
		}
		const usage = this.resourceMonitor.getUsage(task.pid);
		if (!usage) {
			if (task.monitoringMode === "ps") {
				// If ps cannot be read (pid exited), stop monitoring to avoid noisy logs
				this.stopUsageMonitor(task);
			}
			return;
		}
		if (!task.resourceUsage) {
			task.resourceUsage = {};
		}
		const target = task.resourceUsage;
		if (usage.maxRssKb !== undefined) {
			target.maxRssKb = Math.max(target.maxRssKb ?? 0, usage.maxRssKb);
		}
		if (usage.userMs !== undefined) {
			target.userMs = Math.max(target.userMs ?? 0, usage.userMs);
		}
		if (usage.systemMs !== undefined) {
			target.systemMs = Math.max(target.systemMs ?? 0, usage.systemMs);
		}
		this.enforceRuntimeLimits(task);
	}

	private enforceRuntimeLimits(task: BackgroundTask): void {
		if (!task.resourceUsage || task.terminatingForLimits) {
			return;
		}
		const breach = evaluateResourceLimitBreach(task.resourceUsage, task.limits);
		if (!breach || task.failureReason) {
			return;
		}
		const describe =
			breach.kind === "memory"
				? `${(breach.actual / 1024).toFixed(1)}MB > ${(breach.limit / 1024).toFixed(1)}MB`
				: `${Math.round(breach.actual)}ms > ${Math.round(breach.limit)}ms`;
		this.setFailureReason(task, `Resource limit (${breach.kind} ${describe})`);
		task.lastLimitBreach = breach;
		task.terminatingForLimits = true;
		this.disableRestart(task);
		if (!task.pid) {
			return;
		}
		try {
			killProcessTree(task.pid);
		} catch (error) {
			const errMessage =
				error instanceof Error ? error.message : "Failed to terminate process";
			this.emitTaskNotification({
				taskId: task.id,
				status: task.status,
				command: task.command,
				kind: "limit",
				level: "warn",
				reason: `${task.failureReason}; kill error: ${errMessage}`,
				message: "resource limit hit but termination failed",
			});
			return;
		}
		this.emitTaskNotification({
			taskId: task.id,
			status: task.status,
			command: task.command,
			kind: "limit",
			level: "warn",
			reason: task.failureReason,
			message: "exceeded resource limits; terminating",
		});
	}

	private getLogDir(): string {
		const base =
			process.env.COMPOSER_BACKGROUND_LOG_DIR ??
			join(os.homedir(), ".composer", "background-tasks");
		const expanded = expandUserPath(base);
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

	private attachLogging(child: ChildProcess, task: BackgroundTask): void {
		let existingSize = 0;
		try {
			existingSize = statSync(task.logPath).size;
		} catch {
			// File may not exist yet
		}
		const writer = new RotatingLogWriter({
			limit: task.limits.logSizeLimit,
			segments: task.limits.logSegments,
			logPath: task.logPath,
			existingSize,
			markTruncated: () => {
				task.logTruncated = true;
			},
			shiftArchives: () =>
				rotateArchives(task.logPath, task.limits.logSegments),
			archivedPath: (index) => this.getArchivedLogPath(task.logPath, index),
		});

		let closed = false;
		const closeStream = () => {
			if (closed) {
				return;
			}
			closed = true;
			writer.end();
		};

		const attach = (source?: NodeJS.ReadableStream | null) => {
			if (!source) {
				return;
			}
			source.pipe(writer, { end: false });
			source.on("error", () => {
				task.logTruncated = true;
				closeStream();
			});
		};

		attach(child.stdout);
		attach(child.stderr);

		child.once("exit", closeStream);
		child.once("error", closeStream);
	}

	private getArchivedLogPath(logPath: string, index: number): string {
		return archivedLogPath(logPath, index);
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
		this.cancelRestart(task);
		this.stopUsageMonitor(task);
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
		const logPath = this.createLogPath(id);
		const taskLimits = this.resolveTaskLimits(options.limits);
		const task: BackgroundTask = {
			id,
			command,
			cwd: resolvedCwd,
			env,
			startedAt: Date.now(),
			pid: undefined,
			status: "running",
			logPath,
			process: {} as ChildProcess,
			completion: Promise.resolve(),
			shellMode: useShell ? "shell" : "exec",
			restartPolicy: this.normalizeRestartOptions(restart),
			restartTimer: null,
			logTruncated: false,
			limits: taskLimits,
			monitoringMode: "disabled",
		};

		this.tasks.set(id, task);
		this.launchProcess(task);
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
		this.disableRestart(task);
		if (task.status === "restarting") {
			this.stopUsageMonitor(task);
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

const backgroundTaskSchema = Type.Union([
	Type.Object({
		action: Type.Literal("start"),
		command: Type.String({
			description: "Command to run in the background",
			minLength: 1,
		}),
		shell: Type.Optional(
			Type.Boolean({
				description:
					"Run the command through the system shell (allows pipes/redirection). Defaults to false for direct execution.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for the command",
				minLength: 1,
			}),
		),
		env: Type.Optional(
			Type.Record(Type.String({ minLength: 1 }), Type.String(), {
				description: "Additional environment variables for the command",
			}),
		),
		restart: Type.Optional(
			Type.Object({
				maxAttempts: Type.Integer({
					description:
						"Maximum number of restart attempts when the task exits with a non-zero status",
					minimum: 1,
					maximum: 5,
				}),
				delayMs: Type.Integer({
					description: "Delay in milliseconds between restart attempts",
					minimum: 50,
					maximum: 60_000,
				}),
				strategy: Type.Optional(StringEnum(["fixed", "exponential"])),
				maxDelayMs: Type.Optional(
					Type.Integer({
						description: "Upper bound for exponential backoff delays",
						minimum: 50,
						maximum: 600_000,
					}),
				),
				jitterRatio: Type.Optional(
					Type.Number({
						description: "Random jitter ratio applied to restart delays (0-1)",
						minimum: 0,
						maximum: 1,
					}),
				),
			}),
		),
		limits: Type.Optional(
			Type.Object({
				logSizeLimit: Type.Optional(
					Type.Integer({
						description:
							"Per-task log size limit in bytes (overrides default). Minimum 0, maximum 50MB.",
						minimum: 0,
						maximum: 50 * 1024 * 1024,
					}),
				),
				logSegments: Type.Optional(
					Type.Integer({
						description:
							"Number of gzip-compressed log segments to retain when rotating.",
						minimum: 0,
						maximum: 10,
					}),
				),
				retentionMs: Type.Optional(
					Type.Integer({
						description:
							"Milliseconds to retain finished task metadata and logs before cleanup.",
						minimum: 1_000,
						maximum: 24 * 60 * 60 * 1000,
					}),
				),
				maxRssKb: Type.Optional(
					Type.Integer({
						description:
							"Maximum resident set size in kilobytes before the task is terminated (0 disables).",
						minimum: 0,
						maximum: 4 * 1024 * 1024,
					}),
				),
				maxCpuMs: Type.Optional(
					Type.Integer({
						description:
							"Maximum combined user+system CPU time in milliseconds before termination (0 disables).",
						minimum: 0,
						maximum: 24 * 60 * 60 * 1000,
					}),
				),
			}),
		),
	}),
	Type.Object({
		action: Type.Literal("stop"),
		taskId: Type.String({
			description: "Identifier of the background task to stop",
			minLength: 1,
		}),
	}),
	Type.Object({
		action: Type.Literal("list"),
	}),
	Type.Object({
		action: Type.Literal("logs"),
		taskId: Type.String({
			description: "Identifier of the background task",
			minLength: 1,
		}),
		lines: Type.Optional(
			Type.Number({
				description: "Number of log lines to show",
				minimum: 1,
				maximum: 200,
			}),
		),
	}),
]);

type BackgroundTaskSchema = typeof backgroundTaskSchema;

type BackgroundTaskToolDetails = unknown;

function renderTaskList(
	tasks: BackgroundTask[],
	respond: ToolResponseBuilder<unknown>,
): void {
	if (tasks.length === 0) {
		respond.text("No background tasks are running.");
		return;
	}

	const lines = tasks.map(
		(task) => `${formatTaskSummary(task)}\n  ${task.command}`,
	);
	respond.text(lines.join("\n"));
}

function buildTaskDetail(task: BackgroundTask) {
	return {
		id: task.id,
		pid: task.pid,
		status: task.status,
		command: task.command,
		logPath: task.logPath,
		shellMode: task.shellMode,
		logTruncated: Boolean(task.logTruncated),
		restartAttempts: task.restartPolicy?.attempts ?? 0,
		restartMaxAttempts: task.restartPolicy?.maxAttempts ?? 0,
		restartDelayMs: task.restartPolicy?.delayMs ?? null,
		limits: task.limits,
		resourceUsage: task.resourceUsage ?? null,
		failureReason: task.failureReason ?? null,
		monitoringMode: task.monitoringMode ?? "disabled",
	};
}

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

export const backgroundTasksTool = createTool<
	BackgroundTaskSchema,
	BackgroundTaskToolDetails
>({
	name: "background_tasks",
	label: "background tasks",
	description: "Run commands in the background and manage their lifecycle.",
	schema: backgroundTaskSchema,
	async run(params, { respond }) {
		if (params.action === "start") {
			const restart =
				params.restart &&
				({
					...params.restart,
					strategy:
						params.restart.strategy === "exponential" ? "exponential" : "fixed",
				} satisfies TaskStartOptions["restart"]);
			const task = backgroundTaskManager.start(params.command, {
				cwd: params.cwd,
				env: params.env,
				useShell: params.shell ?? false,
				restart,
				limits: params.limits,
			});
			respond
				.text(
					[
						`Started ${formatTaskSummary(task)}`,
						`Logs: ${task.logPath}`,
						`Execution mode: ${task.shellMode === "shell" ? "shell" : "direct"}`,
						"Use action=list to view tasks or action=stop to terminate.",
					].join("\n"),
				)
				.detail(buildTaskDetail(task));
			return respond;
		}

		if (params.action === "list") {
			const tasks = backgroundTaskManager.getTasks();
			renderTaskList(tasks, respond);
			respond.detail(tasks.map((task) => buildTaskDetail(task)));
			return respond;
		}

		if (params.action === "stop") {
			const result = await backgroundTaskManager.stopTask(params.taskId);
			if (!result) {
				respond.error(`Task not found: ${params.taskId}`);
			} else {
				const statusLabel = result.stopped ? "Stopped" : "Stop signal sent";
				const summary = formatTaskSummary(result.task);
				respond
					.text(`${statusLabel} ${summary}`)
					.detail(buildTaskDetail(result.task));
			}
			return respond;
		}

		if (params.action === "logs") {
			const lines = params.lines ?? 40;
			try {
				const logText = backgroundTaskManager.getLogs(params.taskId, lines);
				const task = backgroundTaskManager.getTask(params.taskId);
				respond
					.text(`Last ${lines} lines for ${params.taskId}:\n\n${logText}`)
					.detail({
						taskId: params.taskId,
						lines,
						logTruncated: Boolean(task?.logTruncated),
					});
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: `Unable to read logs for ${params.taskId}`;
				respond.error(message);
			}
			return respond;
		}

		respond.error("Unsupported action");
		return respond;
	},
});
