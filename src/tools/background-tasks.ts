import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

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
}

interface BackgroundTaskLimits {
	maxTasks: number;
	logSizeLimit: number;
	retentionMs: number;
	logSegments: number;
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
			this.scheduleCleanup(task.id);
			this.emitTaskTelemetry(task, "stopped");
			resolve();
			return;
		}
		if (code === 0) {
			task.status = "exited";
			task.finishedAt = Date.now();
			this.scheduleCleanup(task.id);
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
		this.scheduleCleanup(task.id);
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
		this.scheduleCleanup(task.id);
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
		const limit = this.limits.logSizeLimit;
		const dropAllChunks = limit <= 0;
		let existingSize = 0;
		try {
			const stats = statSync(task.logPath);
			existingSize = stats.size;
		} catch {
			// File may not exist yet
		}
		let bytesWritten = 0;
		if (!dropAllChunks && existingSize >= limit) {
			const rotated = this.rotateLogIfPossible(task.logPath);
			task.logTruncated = true;
			if (rotated) {
				existingSize = 0;
			}
		}
		bytesWritten = Math.min(existingSize, limit);

		const writeChunk = (chunk: Buffer | string) => {
			if (dropAllChunks) {
				task.logTruncated = true;
				return;
			}
			let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			while (buffer.length > 0) {
				if (bytesWritten >= limit) {
					const rotated = this.rotateLogIfPossible(task.logPath);
					bytesWritten = 0;
					task.logTruncated = true;
					if (!rotated) {
						return;
					}
				}
				const remaining = Math.max(0, limit - bytesWritten);
				if (remaining === 0) {
					task.logTruncated = true;
					break;
				}
				const slice =
					buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
				if (slice.length > 0) {
					try {
						appendFileSync(task.logPath, slice);
					} catch {
						task.logTruncated = true;
						return;
					}
					bytesWritten += slice.length;
				}
				buffer = buffer.subarray(slice.length);
			}
		};

		const attach = (source?: NodeJS.ReadableStream | null) => {
			source?.on("data", writeChunk);
		};

		attach(child.stdout);
		attach(child.stderr);

		const closeStream = () => {
			// No persistent stream handle to close, but keep hook for parity
		};

		child.once("exit", closeStream);
		child.once("error", closeStream);
	}

	private getArchivedLogPath(logPath: string, index: number): string {
		return `${logPath}.${index}.gz`;
	}

	private rotateLogIfPossible(logPath: string): boolean {
		if (this.limits.logSegments <= 0) {
			return false;
		}
		if (!existsSync(logPath)) {
			return true;
		}
		try {
			this.shiftArchivedLogs(logPath);
			const content = readFileSync(logPath);
			const compressed = gzipSync(content);
			writeFileSync(this.getArchivedLogPath(logPath, 1), compressed);
			unlinkSync(logPath);
			return true;
		} catch {
			return false;
		}
	}

	private shiftArchivedLogs(logPath: string): void {
		const max = this.limits.logSegments;
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

	private deleteArchivedLogs(logPath: string): void {
		const max = Math.max(this.limits.logSegments + 5, 5);
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

	private scheduleCleanup(id: string): void {
		if (this.cleanupTimers.has(id)) {
			return;
		}
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(id);
			this.removeTask(id);
		}, this.limits.retentionMs);
		timer.unref();
		this.cleanupTimers.set(id, timer);
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
		this.deleteArchivedLogs(task.logPath);
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
				now - task.finishedAt >= this.limits.retentionMs
			) {
				this.removeTask(id, true);
			}
		}
	}

	private tailLog(logPath: string, lines: number): string {
		const segments: string[] = [];
		for (let index = this.limits.logSegments; index >= 1; index -= 1) {
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
			this.scheduleCleanup(id);
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
		const text = this.tailLog(task.logPath, lines);
		if (!task.logTruncated) {
			return text;
		}
		const limitKb = Math.round(this.limits.logSizeLimit / 1024);
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
