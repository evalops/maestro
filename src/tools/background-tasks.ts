import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";

import { Type } from "@sinclair/typebox";

import { recordBackgroundTaskEvent } from "../telemetry.js";
import { safejoin } from "../utils/path-validation.js";
import {
	getShellConfig,
	killProcessTree,
	parseCommandArguments,
	validateShellParams,
} from "./shell-utils.js";
import { ToolError, createTool, expandUserPath } from "./tool-dsl.js";
import type { ToolResponseBuilder } from "./tool-dsl.js";

const LOG_TAIL_BYTES = 200_000;
const CLOCK_TICKS_PER_SECOND = (() => {
	const raw = process.env.COMPOSER_BACKGROUND_TASK_TICKS;
	const parsed = Number.parseInt(raw ?? "100", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
})();
const RESOURCE_POLL_INTERVAL_MS = 200;

type ChildProcessWithUsage = ChildProcess & {
	resourceUsage?: () => {
		maxRSS: number;
		userCPUTime: number;
		systemCPUTime: number;
	};
};

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

interface TaskResourceUsage {
	userMs?: number;
	systemMs?: number;
	maxRssKb?: number;
}

export function extractProcStatFields(statRaw: string): string[] | null {
	const trimmed = statRaw.trim();
	const splitIndex = trimmed.lastIndexOf(") ");
	if (splitIndex === -1) {
		return null;
	}
	const remainder = trimmed.slice(splitIndex + 2).trim();
	if (!remainder) {
		return null;
	}
	return remainder.split(/\s+/);
}

interface RestartPolicy {
	maxAttempts: number;
	delayMs: number;
	attempts: number;
	strategy: "fixed" | "exponential";
	maxDelayMs: number;
	jitterRatio: number;
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
	limits: TaskRuntimeLimits;
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
}

type TaskLimitOverrides = Partial<
	Pick<BackgroundTaskLimits, "logSizeLimit" | "logSegments" | "retentionMs">
>;

interface TaskRuntimeLimits {
	logSizeLimit: number;
	logSegments: number;
	retentionMs: number;
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

class BackgroundTaskManager {
	private limits: BackgroundTaskLimits;
	private readonly defaultLimits: BackgroundTaskLimits;
	private tasks = new Map<string, BackgroundTask>();
	private cleanupTimers = new Map<string, NodeJS.Timeout>();
	private logDir: string | null = null;
	private logDirBase: string | null = null;

	constructor() {
		const initialLimits: BackgroundTaskLimits = {
			maxTasks: MAX_CONCURRENT_TASKS,
			logSizeLimit: MAX_LOG_FILE_BYTES,
			retentionMs: TASK_RETENTION_MS,
			logSegments: MAX_LOG_SEGMENTS,
		};
		this.limits = initialLimits;
		this.defaultLimits = { ...initialLimits };
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
		const strategy =
			restart.strategy === "exponential" ? "exponential" : "fixed";
		const rawMaxDelay =
			restart.maxDelayMs !== undefined
				? Math.max(restart.maxDelayMs, delayMs)
				: delayMs * 8;
		const maxDelayMs = Math.min(Math.max(rawMaxDelay, delayMs), 10 * 60 * 1000);
		const jitterRatio = Math.min(Math.max(restart.jitterRatio ?? 0, 0), 1);
		return {
			maxAttempts,
			delayMs,
			attempts: 0,
			strategy,
			maxDelayMs,
			jitterRatio,
		};
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
		if (task.stopRequested) {
			task.status = "stopped";
			task.finishedAt = Date.now();
			this.scheduleCleanup(task);
			this.emitTaskTelemetry(task, "stopped");
			resolve();
			return;
		}
		if (code === 0) {
			task.status = "exited";
			task.finishedAt = Date.now();
			this.scheduleCleanup(task);
			this.emitTaskTelemetry(task, "exited");
			resolve();
			return;
		}
		if (this.scheduleRestart(task)) {
			resolve();
			return;
		}
		task.status = "failed";
		task.finishedAt = Date.now();
		this.scheduleCleanup(task);
		this.emitTaskTelemetry(task, "failed");
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
		if (this.scheduleRestart(task)) {
			resolve();
			return;
		}
		task.status = "failed";
		task.finishedAt = Date.now();
		this.scheduleCleanup(task);
		this.emitTaskTelemetry(task, "failed");
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

	private computeRestartDelay(policy: RestartPolicy): number {
		let delay = policy.delayMs;
		if (policy.strategy === "exponential") {
			const exponent = Math.max(policy.attempts - 1, 0);
			const scaled = policy.delayMs * 2 ** exponent;
			delay = Math.min(Math.max(scaled, policy.delayMs), policy.maxDelayMs);
		}
		if (policy.jitterRatio > 0 && delay > 0) {
			const jitter = delay * policy.jitterRatio;
			const min = Math.max(50, delay - jitter);
			const max = delay + jitter;
			const range = Math.max(max - min, 0);
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
		if (process.platform !== "linux") {
			return;
		}
		if (!task.pid || task.usageMonitor) {
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

	private sampleResourceUsage(task: BackgroundTask): void {
		if (!task.pid) {
			this.stopUsageMonitor(task);
			return;
		}
		const usage = this.readUsageFromProc(task.pid);
		if (!usage) {
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
	}

	private readUsageFromProc(pid: number): TaskResourceUsage | null {
		if (process.platform !== "linux") {
			return null;
		}
		const usage: TaskResourceUsage = {};
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			const match = status.match(/VmRSS:\s+(\d+)\s+kB/i);
			if (match) {
				const rssValue = Number.parseInt(match[1], 10);
				if (Number.isFinite(rssValue)) {
					usage.maxRssKb = Math.max(rssValue, 0);
				}
			}
		} catch {
			// Ignore inability to read status (process likely exited)
		}
		try {
			const statRaw = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const fields = extractProcStatFields(statRaw);
			if (fields) {
				const userTicks = Number.parseInt(fields[11] ?? "", 10);
				const systemTicks = Number.parseInt(fields[12] ?? "", 10);
				const msPerTick = 1000 / CLOCK_TICKS_PER_SECOND;
				if (Number.isFinite(userTicks)) {
					usage.userMs = Math.max(userTicks * msPerTick, 0);
				}
				if (Number.isFinite(systemTicks)) {
					usage.systemMs = Math.max(systemTicks * msPerTick, 0);
				}
			}
		} catch {
			// Ignore stat read errors; may not be available
		}
		return Object.keys(usage).length > 0 ? usage : null;
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
		recordBackgroundTaskEvent({
			event,
			taskId: task.id,
			status: task.status,
			command: task.command,
			shellMode: task.shellMode,
			cwd: task.cwd,
			restartAttempts: task.restartPolicy?.attempts ?? 0,
			logTruncated: task.logTruncated ?? false,
			exitCode: task.exitCode ?? undefined,
			signal: task.signal ?? undefined,
			resourceUsage: task.resourceUsage,
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
			await fsPromises.appendFile(this.logPath, slice);
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
			await fsPromises.unlink(tmpPath).catch(() => {});
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
			const handle = await fsPromises.open(this.logPath, "a");
			await handle.close();
		} catch (error) {
			console.warn("Failed to initialize background task log", error);
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
		console.warn("Failed to write background task logs", error);
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
				strategy: Type.Optional(
					Type.Union([Type.Literal("fixed"), Type.Literal("exponential")]),
				),
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
	};
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
			const task = backgroundTaskManager.start(params.command, {
				cwd: params.cwd,
				env: params.env,
				useShell: params.shell ?? false,
				restart: params.restart,
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
