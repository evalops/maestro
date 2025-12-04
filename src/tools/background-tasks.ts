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
import {
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	promises as fsPromises,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";

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
import { isErrno } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { safejoin } from "../utils/path-validation.js";
import { redactSecrets } from "../utils/secret-redactor.js";
import {
	ResourceMonitor,
	type TaskResourceUsage,
	extractProcStatFields,
} from "./background/index.js";
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

function readBooleanEnv(name: string, fallback = false): boolean {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return fallback;
}

function readNonNegativeInt(envName: string, fallback: number): number {
	const raw = process.env[envName];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 0) {
		return fallback;
	}
	return parsed;
}

function readThresholdEnv(envName: string, fallback: number): number {
	const raw = process.env[envName];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	if (parsed <= 0) {
		return Number.POSITIVE_INFINITY;
	}
	return parsed;
}

function readPositiveInt(
	envName: string,
	fallback: number,
	minimum = 1,
): number {
	const raw = process.env[envName];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < minimum) {
		return fallback;
	}
	return parsed;
}

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

/**
 * Restart Policy Configuration
 *
 * Defines how a task should be restarted after non-zero exit. The policy
 * supports two backoff strategies and includes jitter to prevent thundering
 * herd when multiple tasks restart simultaneously.
 *
 * ## Strategies
 *
 * ### Fixed Delay
 * Always waits `delayMs` between restart attempts. Simple and predictable.
 * Use when: restart failures are likely transient and short-lived.
 *
 * ### Exponential Backoff
 * Delay doubles with each attempt: delayMs, 2*delayMs, 4*delayMs, ...
 * Capped at `maxDelayMs` to prevent unbounded waits.
 * Use when: failures may indicate resource contention or need recovery time.
 *
 * ## Jitter
 *
 * Random variation applied to delay to prevent synchronized restarts:
 * `actualDelay = delay ± (delay * jitterRatio)`
 *
 * This is critical when multiple background tasks fail together (e.g., database
 * goes down). Without jitter, they'd all retry at the exact same time, potentially
 * overwhelming the recovering service.
 *
 * ## Notification Threshold
 *
 * `nextNotifyAttempt` tracks when to emit a user-visible notification about
 * repeated restarts. Uses exponential growth (2, 4, 8, ...) to avoid spamming.
 */
interface RestartPolicy {
	/** Maximum restart attempts before giving up (task fails permanently) */
	maxAttempts: number;
	/** Base delay between restart attempts in milliseconds */
	delayMs: number;
	/** Current restart attempt counter (0 = no restarts yet) */
	attempts: number;
	/** "fixed" = constant delay, "exponential" = doubles each attempt */
	strategy: "fixed" | "exponential";
	/** Upper bound for exponential backoff (prevents multi-minute waits) */
	maxDelayMs: number;
	/** Random variation factor: 0.0 = no jitter, 1.0 = ±100% variation */
	jitterRatio: number;
	/** Next attempt count that triggers a notification (grows exponentially) */
	nextNotifyAttempt?: number;
}

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
	restart?: {
		maxAttempts: number;
		delayMs: number;
		strategy?: "fixed" | "exponential";
		maxDelayMs?: number;
		jitterRatio?: number;
	};
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
		const nextNotify = policy.nextNotifyAttempt ?? RESTART_NOTIFY_THRESHOLD;
		if (policy.attempts < nextNotify) {
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
		const next = nextNotify * 2;
		if (!Number.isFinite(next) || next > policy.maxAttempts) {
			policy.nextNotifyAttempt = Number.POSITIVE_INFINITY;
		} else {
			policy.nextNotifyAttempt = next;
		}
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
		if (!restart || restart.maxAttempts <= 0) {
			return undefined;
		}
		const maxAttempts = Math.min(Math.max(restart.maxAttempts, 0), 5);
		if (maxAttempts === 0) {
			return undefined;
		}
		const delayMs = Math.min(Math.max(restart.delayMs, 50), 60_000);
		const strategy: RestartPolicy["strategy"] =
			restart.strategy === "exponential" ? "exponential" : "fixed";
		const rawMaxDelay =
			restart.maxDelayMs !== undefined
				? Math.max(restart.maxDelayMs, delayMs)
				: delayMs * 8;
		const maxDelayMs = Math.min(Math.max(rawMaxDelay, delayMs), 10 * 60 * 1000);
		const jitterRatio = Math.min(Math.max(restart.jitterRatio ?? 0, 0), 1);
		const policy: RestartPolicy = {
			maxAttempts,
			delayMs,
			attempts: 0,
			strategy,
			maxDelayMs,
			jitterRatio,
		};
		if (Number.isFinite(RESTART_NOTIFY_THRESHOLD)) {
			policy.nextNotifyAttempt = RESTART_NOTIFY_THRESHOLD;
		}
		return policy;
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
		if (policy.attempts >= policy.maxAttempts) {
			return false;
		}
		policy.attempts += 1;
		task.status = "restarting";
		this.emitTaskTelemetry(task, "restarted");
		this.maybeNotifyRestart(task, policy);
		this.cancelRestart(task);
		const delay = this.computeRestartDelay(policy);
		task.restartTimer = setTimeout(() => {
			task.restartTimer = null;
			this.launchProcess(task);
		}, delay);
		if (task.restartTimer.unref) {
			task.restartTimer.unref();
		}
		return true;
	}

	/**
	 * Compute Restart Delay with Backoff and Jitter
	 *
	 * Calculates the actual delay before the next restart attempt, applying
	 * the configured backoff strategy and jitter.
	 *
	 * ## Exponential Backoff Calculation
	 *
	 * For exponential strategy, delay doubles with each attempt:
	 * - Attempt 1: delayMs * 2^0 = delayMs
	 * - Attempt 2: delayMs * 2^1 = 2 * delayMs
	 * - Attempt 3: delayMs * 2^2 = 4 * delayMs
	 * - etc., capped at maxDelayMs
	 *
	 * ## Jitter Application
	 *
	 * Jitter adds randomness to prevent synchronized restarts (thundering herd):
	 *
	 * ```
	 * jitterRange = delay * jitterRatio
	 * actualDelay = random(delay - jitterRange, delay + jitterRange)
	 * ```
	 *
	 * Example with delay=1000ms and jitterRatio=0.25:
	 * - jitterRange = 250ms
	 * - actualDelay = random value between 750ms and 1250ms
	 *
	 * A minimum of 50ms is enforced to prevent near-instant retries.
	 *
	 * @param policy - The restart policy configuration
	 * @returns Delay in milliseconds before next restart attempt
	 */
	private computeRestartDelay(policy: RestartPolicy): number {
		let delay = policy.delayMs;

		// Apply exponential backoff if configured
		if (policy.strategy === "exponential") {
			// Exponent is attempts-1 so first restart uses base delay
			const exponent = Math.max(policy.attempts - 1, 0);
			// 2^exponent scaling: 1x, 2x, 4x, 8x, ...
			const scaled = policy.delayMs * 2 ** exponent;
			// Clamp between base delay and maximum
			delay = Math.min(Math.max(scaled, policy.delayMs), policy.maxDelayMs);
		}

		// Apply jitter to prevent synchronized restarts
		if (policy.jitterRatio > 0 && delay > 0) {
			const jitter = delay * policy.jitterRatio;
			// Minimum 50ms to prevent near-instant retries after jitter subtraction
			const min = Math.max(50, delay - jitter);
			const max = delay + jitter;
			const range = Math.max(max - min, 0);
			// Uniform random distribution within jitter range
			delay = Math.round(min + Math.random() * range);
		}

		return delay;
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
			shiftArchives: () => this.shiftArchivedLogs(task),
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
		return `${logPath}.${index}.gz`;
	}

	private shiftArchivedLogs(task: BackgroundTask): void {
		const logPath = task.logPath;
		const max = task.limits.logSegments;
		for (let index = max; index >= 1; index -= 1) {
			const currentPath = this.getArchivedLogPath(logPath, index);
			if (!existsSync(currentPath)) {
				continue;
			}
			if (index === max) {
				try {
					unlinkSync(currentPath);
				} catch {}
			} else {
				const nextPath = this.getArchivedLogPath(logPath, index + 1);
				try {
					renameSync(currentPath, nextPath);
				} catch {}
			}
		}
	}

	private deleteArchivedLogs(task: BackgroundTask): void {
		const logPath = task.logPath;
		const max = Math.max(task.limits.logSegments + 5, 5);
		for (let index = 1; index <= max; index += 1) {
			const archived = this.getArchivedLogPath(logPath, index);
			if (existsSync(archived)) {
				try {
					unlinkSync(archived);
				} catch {}
			}
		}
	}

	private readLogSegment(logPath: string): string {
		try {
			const data = readFileSync(logPath);
			if (logPath.endsWith(".gz")) {
				return gunzipSync(data).toString("utf8");
			}
			return data.toString("utf8");
		} catch {
			return "";
		}
	}

	private trimLogText(text: string): string {
		if (text.length <= LOG_TAIL_BYTES) {
			return text;
		}
		return text.slice(-LOG_TAIL_BYTES);
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
		this.deleteArchivedLogs(task);
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
		const logPath = task.logPath;
		const segments: string[] = [];
		for (let index = task.limits.logSegments; index >= 1; index -= 1) {
			const archivedPath = this.getArchivedLogPath(logPath, index);
			if (existsSync(archivedPath)) {
				const text = this.trimLogText(this.readLogSegment(archivedPath));
				if (text) {
					segments.push(text);
				}
			}
		}
		if (existsSync(logPath)) {
			const stat = statSync(logPath);
			if (stat.size > 0) {
				const readSize = Math.min(stat.size, LOG_TAIL_BYTES);
				const buffer = Buffer.alloc(readSize);
				const fd = openSync(logPath, "r");
				readSync(fd, buffer, 0, readSize, stat.size - readSize);
				closeSync(fd);
				segments.push(this.trimLogText(buffer.toString("utf8")));
			}
		}
		if (segments.length === 0) {
			return "No logs available.";
		}
		const combined = segments.join("\n").trimEnd();
		if (!combined) {
			return "No logs available.";
		}
		const logLines = combined.split(/\r?\n/);
		const tail = logLines.slice(-lines);
		return tail.join("\n");
	}

	private previewLogLine(
		task: BackgroundTask,
		lines: number,
	): string | undefined {
		const text = this.tailLog(task, lines).trim();
		if (!text || text === "No logs available.") {
			return undefined;
		}
		const entries = text.split(/\r?\n/).filter(Boolean);
		return this.sanitizeLogSnippet(entries[entries.length - 1]);
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

type RotatingLogWriterOptions = {
	limit: number;
	segments: number;
	logPath: string;
	existingSize: number;
	markTruncated: () => void;
	shiftArchives: () => void;
	archivedPath: (index: number) => string;
};

class RotatingLogWriter extends Writable {
	private readonly logger = createLogger("background-tasks");
	private readonly limit: number;
	private readonly segments: number;
	private readonly logPath: string;
	private currentSize: number;
	private readonly markTruncated: () => void;
	private readonly shiftArchives: () => void;
	private readonly archivedPath: (index: number) => string;
	private writeQueue: Promise<void>;
	private readonly dropAll: boolean;
	private readonly ready: Promise<void>;
	private failed = false;

	constructor(options: RotatingLogWriterOptions) {
		super({ decodeStrings: true });
		this.limit = Math.max(options.limit, 0);
		this.segments = Math.max(options.segments, 0);
		this.logPath = options.logPath;
		this.currentSize = Math.min(options.existingSize, this.limit);
		this.markTruncated = options.markTruncated;
		this.shiftArchives = options.shiftArchives;
		this.archivedPath = options.archivedPath;
		this.dropAll = this.limit === 0;
		this.ready = this.initialize();
		this.writeQueue = this.ready;
	}

	_write(
		chunk: Buffer | string,
		encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		if (this.dropAll || this.failed) {
			this.markTruncated();
			callback();
			return;
		}
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: Buffer.from(chunk, encoding);
		this.writeQueue = this.writeQueue.then(() => this.writeBuffer(buffer));
		this.writeQueue.then(
			() => callback(),
			(error) => {
				this.handleWriteError(error);
				callback();
			},
		);
	}

	_final(callback: (error?: Error | null) => void): void {
		this.writeQueue.then(
			() => callback(),
			(error) => callback(error),
		);
	}

	private async writeBuffer(buffer: Buffer): Promise<void> {
		if (this.dropAll || this.failed) {
			if (buffer.length > 0) {
				this.markTruncated();
			}
			return;
		}
		let remainingBuffer = buffer;
		while (remainingBuffer.length > 0) {
			if (this.currentSize >= this.limit) {
				const rotated = await this.rotate();
				if (!rotated) {
					this.markTruncated();
					return;
				}
				continue;
			}
			const remainingCapacity = this.limit - this.currentSize;
			if (remainingCapacity <= 0) {
				this.markTruncated();
				return;
			}
			const slice =
				remainingBuffer.length > remainingCapacity
					? remainingBuffer.subarray(0, remainingCapacity)
					: remainingBuffer;
			await this.appendToLog(slice);
			this.currentSize += slice.length;
			remainingBuffer = remainingBuffer.subarray(slice.length);
		}
	}

	private async rotate(): Promise<boolean> {
		if (this.segments <= 0) {
			return false;
		}
		try {
			await this.shiftArchivesAsync();
			const tmpPath = this.getTempArchivePath();
			try {
				await fsPromises.rename(this.logPath, tmpPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					await this.ensureLogFileExists();
					this.currentSize = 0;
					return true;
				}
				throw error;
			}
			await this.ensureLogFileExists();
			const destination = this.archivedPath(1);
			await pipeline(
				createReadStream(tmpPath),
				createGzip(),
				createWriteStream(destination),
			);
			await fsPromises.unlink(tmpPath).catch((err) => {
				this.logger.debug("Failed to unlink temp file after rotation", {
					tmpPath,
					error: err instanceof Error ? err.message : String(err),
				});
			});
			this.currentSize = 0;
			return true;
		} catch (error) {
			this.handleWriteError(error);
			return false;
		}
	}

	private async initialize(): Promise<void> {
		await this.ensureLogFileExists();
		if (this.dropAll) {
			return;
		}
		if (this.limit > 0 && this.currentSize >= this.limit) {
			await this.rotate();
		}
	}

	private async ensureLogFileExists(): Promise<void> {
		try {
			await fsPromises.mkdir(dirname(this.logPath), { recursive: true });
			const handle = await fsPromises.open(this.logPath, "a");
			await handle.close();
		} catch (error: unknown) {
			if (isErrno(error) && error.code === "ENOENT") {
				// Expected when the log file is not yet present; mkdir may race on temp dirs.
				this.logger.debug("Log init ENOENT; will retry", {
					path: this.logPath,
					error,
				});
				return;
			}

			if (error instanceof Error) {
				this.logger.error("Failed to initialize background task log", error, {
					path: this.logPath,
				});
			} else {
				this.logger.error(
					"Failed to initialize background task log",
					undefined,
					{
						path: this.logPath,
						error,
					},
				);
			}
		}
	}

	private async appendToLog(slice: Buffer): Promise<void> {
		try {
			await fsPromises.appendFile(this.logPath, slice);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await this.ensureLogFileExists();
				await fsPromises.appendFile(this.logPath, slice);
				return;
			}
			throw error;
		}
	}

	private getTempArchivePath(): string {
		return `${this.logPath}.rotating-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	private async shiftArchivesAsync(): Promise<void> {
		await Promise.resolve(this.shiftArchives());
	}

	private handleWriteError(error: unknown): void {
		if (this.failed) {
			return;
		}
		this.failed = true;
		this.markTruncated();
		this.logger.warn("Failed to write background task logs", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

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
