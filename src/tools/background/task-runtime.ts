import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync, statSync } from "node:fs";

import {
	getShellConfig,
	killProcessTree,
	parseCommandArguments,
} from "../shell-utils.js";
import { ToolError } from "../tool-dsl.js";
import {
	ResourceMonitor,
	type RestartPolicy,
	RotatingLogWriter,
	canRestart,
	computeRestartDelay,
	incrementAttempts,
} from "./index.js";
import { archivedLogPath, rotateArchives } from "./log-files.js";
import { evaluateResourceLimitBreach } from "./resource-limits.js";
import type {
	BackgroundTask,
	BackgroundTaskHistoryEvent,
	BackgroundTaskNotification,
	ChildProcessWithUsage,
} from "./task-types.js";

const RESOURCE_POLL_INTERVAL_MS = 200;

export interface BackgroundTaskRuntimeHooks {
	emitTaskNotification: (payload: BackgroundTaskNotification) => void;
	emitTaskTelemetry: (
		task: BackgroundTask,
		event: BackgroundTaskHistoryEvent,
	) => void;
	maybeNotifyRestart: (task: BackgroundTask, policy: RestartPolicy) => void;
	notifyFailure: (
		task: BackgroundTask,
		code: number | null,
		signal: NodeJS.Signals | null,
	) => void;
	scheduleCleanup: (task: BackgroundTask) => void;
	setFailureReason: (task: BackgroundTask, reason: string) => void;
}

export class BackgroundTaskRuntime {
	constructor(
		private readonly hooks: BackgroundTaskRuntimeHooks,
		private readonly resourceMonitor = new ResourceMonitor(),
	) {}

	launchProcess(task: BackgroundTask): void {
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
				this.handleChildError(task, child, resolve, error);
			});
		});
		this.hooks.emitTaskTelemetry(task, "started");
	}

	stopUsageMonitor(task: BackgroundTask): void {
		if (task.usageMonitor) {
			clearInterval(task.usageMonitor);
			task.usageMonitor = null;
		}
	}

	disableRestart(task: BackgroundTask): void {
		this.cancelRestart(task);
		task.restartPolicy = undefined;
	}

	disposeTask(task: BackgroundTask): void {
		this.cancelRestart(task);
		this.stopUsageMonitor(task);
	}

	private createChildProcess(task: BackgroundTask): ChildProcess {
		const mergedEnv: NodeJS.ProcessEnv = task.env;
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
		return spawn(parsed[0]!, parsed.slice(1), spawnOptions);
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
			this.hooks.scheduleCleanup(task);
			this.hooks.emitTaskTelemetry(task, "stopped");
			resolve();
			return;
		}
		if (!forcedFailure && code === 0) {
			task.status = "exited";
			task.finishedAt = Date.now();
			this.hooks.scheduleCleanup(task);
			this.hooks.emitTaskTelemetry(task, "exited");
			resolve();
			return;
		}
		if (!forcedFailure && this.scheduleRestart(task)) {
			resolve();
			return;
		}
		task.status = "failed";
		task.finishedAt = Date.now();
		this.hooks.scheduleCleanup(task);
		this.hooks.emitTaskTelemetry(task, "failed");
		if (!forcedFailure) {
			this.hooks.notifyFailure(task, code, signal);
		}
		resolve();
	}

	private handleChildError(
		task: BackgroundTask,
		child: ChildProcess,
		resolve: () => void,
		_error: Error,
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
		this.hooks.scheduleCleanup(task);
		this.hooks.emitTaskTelemetry(task, "failed");
		if (!forcedFailure) {
			this.hooks.notifyFailure(task, null, null);
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
		this.hooks.emitTaskTelemetry(task, "restarted");
		this.hooks.maybeNotifyRestart(task, policy);
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
		this.hooks.setFailureReason(
			task,
			`Resource limit (${breach.kind} ${describe})`,
		);
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
			this.hooks.emitTaskNotification({
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
		this.hooks.emitTaskNotification({
			taskId: task.id,
			status: task.status,
			command: task.command,
			kind: "limit",
			level: "warn",
			reason: task.failureReason,
			message: "exceeded resource limits; terminating",
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
			archivedPath: (index) => archivedLogPath(task.logPath, index),
		});
		task.logWriter = writer;

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
}
