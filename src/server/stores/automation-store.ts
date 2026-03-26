import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ThinkingLevel } from "../../agent/types.js";
import { getAgentDir } from "../../config/constants.js";
import { isPlainObject, tryParseJson } from "../../utils/json.js";
import { resolveEnvPath } from "../../utils/path-expansion.js";

export type AutomationRunStatus = "success" | "failure" | "skipped";
export type AutomationRunTrigger = "manual" | "schedule";

export interface AutomationRunRecord {
	id: string;
	startedAt: string;
	finishedAt: string;
	durationMs?: number;
	status: AutomationRunStatus;
	trigger?: AutomationRunTrigger;
	error?: string;
	output?: string;
	sessionId?: string;
}

export interface AutomationRunWindow {
	start: string;
	end: string;
	days?: number[];
}
export type AutomationSessionMode = "reuse" | "new";

export interface AutomationTask {
	id: string;
	name: string;
	prompt: string;
	schedule: string | null;
	scheduleLabel?: string;
	scheduleKind?: "once" | "daily" | "weekly" | "cron";
	scheduleTime?: string;
	scheduleDays?: number[];
	runAt?: string;
	cronExpression?: string;
	nextRun: string | null;
	timezone: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	lastRunStatus?: AutomationRunStatus;
	lastRunError?: string;
	lastRunDurationMs?: number;
	lastOutput?: string;
	runCount: number;
	running?: boolean;
	runHistory?: AutomationRunRecord[];
	runWindow?: AutomationRunWindow;
	exclusive?: boolean;
	notifyOnSuccess?: boolean;
	notifyOnFailure?: boolean;
	sessionMode?: AutomationSessionMode;
	sessionId?: string;
	lastSessionId?: string;
	contextPaths?: string[];
	contextFolders?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface AutomationStateFile {
	version: 1;
	automations: AutomationTask[];
}

const AUTOMATIONS_STATE_PATH =
	resolveEnvPath(process.env.MAESTRO_AUTOMATIONS_STATE) ??
	resolve(getAgentDir(), "automations.json");

const MAX_AUTOMATIONS = 500;
const MAX_RUN_HISTORY = 20;

function isValidTimeString(value: string): boolean {
	if (!/^\d{2}:\d{2}$/.test(value)) return false;
	const [hour, minute] = value.split(":").map((part) => Number(part));
	if (hour === undefined || minute === undefined) return false;
	if (hour < 0 || hour > 23) return false;
	if (minute < 0 || minute > 59) return false;
	return true;
}

function normalizeRunRecord(raw: unknown): AutomationRunRecord | null {
	if (!isPlainObject(raw)) return null;
	const record = raw as Partial<AutomationRunRecord>;
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	if (typeof record.startedAt !== "string") return null;
	if (typeof record.finishedAt !== "string") return null;
	if (record.status !== "success" && record.status !== "failure") {
		if (record.status !== "skipped") return null;
	}
	const cleaned: AutomationRunRecord = {
		id: record.id,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		status: record.status,
	};
	if (
		typeof record.durationMs === "number" &&
		Number.isFinite(record.durationMs)
	) {
		cleaned.durationMs = record.durationMs;
	}
	if (record.trigger === "manual" || record.trigger === "schedule") {
		cleaned.trigger = record.trigger;
	}
	if (typeof record.error === "string") {
		cleaned.error = record.error;
	}
	if (typeof record.output === "string") {
		cleaned.output = record.output;
	}
	if (typeof record.sessionId === "string" && record.sessionId.length > 0) {
		cleaned.sessionId = record.sessionId;
	}
	return cleaned;
}

function normalizeRunWindow(raw: unknown): AutomationRunWindow | null {
	if (!isPlainObject(raw)) return null;
	const input = raw as Partial<AutomationRunWindow>;
	if (typeof input.start !== "string" || typeof input.end !== "string") {
		return null;
	}
	if (!isValidTimeString(input.start) || !isValidTimeString(input.end)) {
		return null;
	}
	const cleaned: AutomationRunWindow = {
		start: input.start,
		end: input.end,
	};
	if (Array.isArray(input.days)) {
		const days = input.days.filter(
			(day) => Number.isFinite(day) && day >= 0 && day <= 6,
		);
		if (days.length > 0) {
			cleaned.days = Array.from(new Set(days));
		}
	}
	return cleaned;
}

function normalizeAutomation(raw: unknown): AutomationTask | null {
	if (!isPlainObject(raw)) return null;
	const task = raw as Partial<AutomationTask>;
	if (typeof task.id !== "string" || task.id.length === 0) return null;
	if (typeof task.name !== "string" || task.name.length === 0) return null;
	if (typeof task.prompt !== "string" || task.prompt.length === 0) return null;
	const schedule =
		typeof task.schedule === "string" ? task.schedule : (task.schedule ?? null);
	const timezone =
		typeof task.timezone === "string" && task.timezone ? task.timezone : "UTC";
	const enabled = typeof task.enabled === "boolean" ? task.enabled : true;
	const createdAt =
		typeof task.createdAt === "string"
			? task.createdAt
			: new Date().toISOString();
	const updatedAt =
		typeof task.updatedAt === "string" ? task.updatedAt : createdAt;
	const nextRun =
		typeof task.nextRun === "string" ? task.nextRun : (task.nextRun ?? null);
	const runCount =
		typeof task.runCount === "number" && Number.isFinite(task.runCount)
			? task.runCount
			: 0;

	const cleaned: AutomationTask = {
		id: task.id,
		name: task.name,
		prompt: task.prompt,
		schedule,
		scheduleLabel:
			typeof task.scheduleLabel === "string" ? task.scheduleLabel : undefined,
		nextRun,
		timezone,
		enabled,
		createdAt,
		updatedAt,
		runCount,
	};

	if (task.lastRunAt && typeof task.lastRunAt === "string") {
		cleaned.lastRunAt = task.lastRunAt;
	}
	if (task.lastRunStatus) {
		const status = task.lastRunStatus;
		if (status === "success" || status === "failure" || status === "skipped") {
			cleaned.lastRunStatus = status;
		}
	}
	if (typeof task.lastRunError === "string") {
		cleaned.lastRunError = task.lastRunError;
	}
	if (
		typeof task.lastRunDurationMs === "number" &&
		Number.isFinite(task.lastRunDurationMs)
	) {
		cleaned.lastRunDurationMs = task.lastRunDurationMs;
	}
	if (typeof task.lastOutput === "string") {
		cleaned.lastOutput = task.lastOutput;
	}
	if (Array.isArray(task.runHistory)) {
		const normalizedHistory = task.runHistory
			.map((entry) => normalizeRunRecord(entry))
			.filter((entry): entry is AutomationRunRecord => Boolean(entry));
		if (normalizedHistory.length > MAX_RUN_HISTORY) {
			normalizedHistory.splice(MAX_RUN_HISTORY);
		}
		cleaned.runHistory = normalizedHistory;
	}
	if (task.runWindow) {
		const normalizedWindow = normalizeRunWindow(task.runWindow);
		if (normalizedWindow) {
			cleaned.runWindow = normalizedWindow;
		}
	}
	if (typeof task.exclusive === "boolean") {
		cleaned.exclusive = task.exclusive;
	}
	if (typeof task.notifyOnSuccess === "boolean") {
		cleaned.notifyOnSuccess = task.notifyOnSuccess;
	}
	if (typeof task.notifyOnFailure === "boolean") {
		cleaned.notifyOnFailure = task.notifyOnFailure;
	}
	if (
		task.scheduleKind &&
		["once", "daily", "weekly", "cron"].includes(task.scheduleKind)
	) {
		cleaned.scheduleKind = task.scheduleKind;
	}
	if (typeof task.scheduleTime === "string") {
		cleaned.scheduleTime = task.scheduleTime;
	}
	if (Array.isArray(task.scheduleDays)) {
		cleaned.scheduleDays = task.scheduleDays.filter((day) =>
			Number.isFinite(day),
		);
	}
	if (typeof task.runAt === "string") {
		cleaned.runAt = task.runAt;
	}
	if (typeof task.cronExpression === "string") {
		cleaned.cronExpression = task.cronExpression;
	}
	if (typeof task.running === "boolean") {
		cleaned.running = task.running;
	}
	if (task.sessionMode === "reuse" || task.sessionMode === "new") {
		cleaned.sessionMode = task.sessionMode;
	}
	if (typeof task.sessionId === "string" && task.sessionId) {
		cleaned.sessionId = task.sessionId;
	}
	if (typeof task.lastSessionId === "string" && task.lastSessionId) {
		cleaned.lastSessionId = task.lastSessionId;
	}
	if (Array.isArray(task.contextPaths)) {
		cleaned.contextPaths = task.contextPaths.filter(
			(path): path is string => typeof path === "string" && path.length > 0,
		);
	}
	if (Array.isArray(task.contextFolders)) {
		cleaned.contextFolders = task.contextFolders.filter(
			(path): path is string => typeof path === "string" && path.length > 0,
		);
	}
	if (typeof task.model === "string" && task.model) {
		cleaned.model = task.model;
	}
	if (
		task.thinkingLevel &&
		["off", "minimal", "low", "medium", "high", "max"].includes(
			task.thinkingLevel,
		)
	) {
		cleaned.thinkingLevel = task.thinkingLevel;
	}

	return cleaned;
}

function normalizeState(raw: unknown): AutomationStateFile {
	if (!isPlainObject(raw)) {
		return { version: 1, automations: [] };
	}
	const input = raw as Partial<AutomationStateFile>;
	const tasks = Array.isArray(input.automations) ? input.automations : [];
	const normalized = tasks
		.map((task) => normalizeAutomation(task))
		.filter((task): task is AutomationTask => Boolean(task));

	if (normalized.length > MAX_AUTOMATIONS) {
		normalized.splice(0, normalized.length - MAX_AUTOMATIONS);
	}

	return { version: 1, automations: normalized };
}

export function loadAutomationState(): AutomationStateFile {
	if (!existsSync(AUTOMATIONS_STATE_PATH)) {
		return { version: 1, automations: [] };
	}
	const raw = tryParseJson(readFileSync(AUTOMATIONS_STATE_PATH, "utf-8"));
	return normalizeState(raw);
}

export function saveAutomationState(state: AutomationStateFile): void {
	const normalized = normalizeState(state);
	mkdirSync(dirname(AUTOMATIONS_STATE_PATH), { recursive: true });
	writeFileSync(
		AUTOMATIONS_STATE_PATH,
		JSON.stringify(normalized, null, 2),
		"utf-8",
	);
}
