import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ThinkingLevel } from "../../agent/types.js";
import { getAgentDir } from "../../config/constants.js";
import { isPlainObject, tryParseJson } from "../../utils/json.js";
import { resolveEnvPath } from "../../utils/path-expansion.js";

export type AutomationRunStatus = "success" | "failure" | "skipped";
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
	sessionMode?: AutomationSessionMode;
	sessionId?: string;
	lastSessionId?: string;
	contextPaths?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface AutomationStateFile {
	version: 1;
	automations: AutomationTask[];
}

const AUTOMATIONS_STATE_PATH =
	resolveEnvPath(process.env.COMPOSER_AUTOMATIONS_STATE) ??
	resolve(getAgentDir(), "automations.json");

const MAX_AUTOMATIONS = 500;

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
