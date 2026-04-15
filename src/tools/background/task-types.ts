/**
 * Background Task Types and Formatting
 * Type definitions and pure formatting functions for background task management.
 */

import type { ChildProcess } from "node:child_process";
import type {
	RestartPolicy,
	RotatingLogWriter,
	TaskResourceUsage,
} from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export type BackgroundTaskStatus =
	| "running"
	| "stopped"
	| "exited"
	| "failed"
	| "restarting";

// ─────────────────────────────────────────────────────────────────────────────
// Core Task
// ─────────────────────────────────────────────────────────────────────────────

export type ChildProcessWithUsage = ChildProcess & {
	resourceUsage?: () => {
		maxRSS: number;
		userCPUTime: number;
		systemCPUTime: number;
	};
};

export interface BackgroundTask {
	id: string;
	command: string;
	cwd?: string;
	env: Record<string, string>;
	startedAt: number;
	pid?: number;
	status: BackgroundTaskStatus;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	logPath: string;
	logWriter?: RotatingLogWriter;
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

export interface TaskStartOptions {
	cwd?: string;
	env?: Record<string, string>;
	useShell?: boolean;
	restart?: import("./index.js").RestartPolicyOptions;
	limits?: TaskLimitOverrides;
}

export interface BackgroundTaskLimits {
	maxTasks: number;
	logSizeLimit: number;
	retentionMs: number;
	logSegments: number;
	maxRssKb?: number;
	maxCpuMs?: number;
}

export type TaskLimitOverrides = Partial<
	Pick<
		BackgroundTaskLimits,
		"logSizeLimit" | "logSegments" | "retentionMs" | "maxRssKb" | "maxCpuMs"
	>
>;

export interface TaskRuntimeLimits {
	logSizeLimit: number;
	logSegments: number;
	retentionMs: number;
	maxRssKb?: number;
	maxCpuMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications & Health
// ─────────────────────────────────────────────────────────────────────────────

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

export type BackgroundTaskHistoryEvent =
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

export interface ResourceLimitBreach {
	kind: "memory" | "cpu";
	limit: number;
	actual: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

export function formatUsageSummary(usage?: TaskResourceUsage): string | null {
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

export function formatTaskSummary(task: BackgroundTask): string {
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

export function buildTaskDetail(task: BackgroundTask) {
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
