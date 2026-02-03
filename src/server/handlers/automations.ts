import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ThinkingLevel } from "../../agent/types.js";
import { createLogger } from "../../utils/logger.js";
import type { WebServerContext } from "../app-context.js";
import {
	getNextRunFromSchedule,
	isValidTimezone,
} from "../automations/schedule-utils.js";
import { runAutomationById } from "../automations/scheduler.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import {
	type AutomationTask,
	loadAutomationState,
	saveAutomationState,
} from "../stores/automation-store.js";

const logger = createLogger("automations-handler");

interface AutomationCreateInput {
	name?: string;
	prompt?: string;
	schedule?: string | null;
	scheduleLabel?: string;
	scheduleKind?: "once" | "daily" | "weekly" | "cron";
	scheduleTime?: string;
	scheduleDays?: number[];
	runAt?: string | null;
	cronExpression?: string;
	nextRun?: string | null;
	timezone?: string;
	enabled?: boolean;
	sessionMode?: "reuse" | "new";
	sessionId?: string | null;
	contextPaths?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface AutomationUpdateInput extends AutomationCreateInput {
	enabled?: boolean;
	clearHistory?: boolean;
}

interface AutomationPreviewInput {
	schedule?: string | null;
	runAt?: string | null;
	timezone?: string;
}

const schedulePattern =
	/^(W\d+\s+\d+\s+\d+\s+\*\s+\*\s+\d+|N-?\d+\s+\d+\s+\d+\s+\*\s+\*\s+\d+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)$/;

function isValidSchedule(schedule: string): boolean {
	if (!schedulePattern.test(schedule.trim())) return false;
	const parts = schedule.trim().split(/\s+/);
	if (parts[0]?.startsWith("W") || parts[0]?.startsWith("N")) {
		return parts.length === 6;
	}
	return parts.length === 5;
}

function sanitizePaths(paths?: string[]): string[] | undefined {
	if (!Array.isArray(paths)) return undefined;
	return paths
		.map((path) => path.trim())
		.filter(Boolean)
		.slice(0, 24);
}

function parseRunAt(value?: string | null): Date | null {
	if (!value || typeof value !== "string") return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveNextRun(
	schedule: string | null,
	runAt: Date | null,
	timezone: string,
): string | null {
	if (schedule) {
		const nextRun = getNextRunFromSchedule(schedule, new Date(), timezone);
		return nextRun.toISOString();
	}
	if (runAt) {
		const now = Date.now();
		if (runAt.getTime() <= now) {
			return new Date(now + 1000).toISOString();
		}
		return runAt.toISOString();
	}
	return null;
}

export async function handleAutomations(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	params?: Record<string, string>,
) {
	try {
		if (req.method === "GET") {
			const state = loadAutomationState();
			sendJson(
				res,
				200,
				{ automations: state.automations },
				context.corsHeaders,
			);
			return;
		}

		if (req.method === "POST") {
			if (params?.id) {
				// Run automation
				const automation = await runAutomationById(
					params.id,
					context,
					"manual",
				);
				if (!automation) {
					sendJson(
						res,
						404,
						{ error: "Automation not found or already running" },
						context.corsHeaders,
					);
					return;
				}
				sendJson(res, 200, { automation }, context.corsHeaders);
				return;
			}

			const data = await readJsonBody<AutomationCreateInput>(req);
			if (!data.name || !data.prompt) {
				sendJson(
					res,
					400,
					{ error: "name and prompt are required" },
					context.corsHeaders,
				);
				return;
			}

			const timezone =
				data.timezone && isValidTimezone(data.timezone) ? data.timezone : "UTC";

			const schedule = data.schedule ? data.schedule.trim() : null;
			const runAt = parseRunAt(data.runAt ?? data.nextRun ?? null);

			if (schedule && !isValidSchedule(schedule)) {
				sendJson(
					res,
					400,
					{ error: "Invalid schedule format" },
					context.corsHeaders,
				);
				return;
			}
			if (!schedule && !runAt) {
				sendJson(
					res,
					400,
					{ error: "Provide schedule or runAt for one-time automation" },
					context.corsHeaders,
				);
				return;
			}

			const state = loadAutomationState();
			const now = new Date().toISOString();
			const automation: AutomationTask = {
				id: randomUUID(),
				name: data.name.trim(),
				prompt: data.prompt.trim(),
				schedule,
				scheduleLabel: data.scheduleLabel,
				scheduleKind: data.scheduleKind,
				scheduleTime: data.scheduleTime,
				scheduleDays: data.scheduleDays,
				runAt: data.runAt ?? undefined,
				cronExpression: data.cronExpression,
				nextRun: resolveNextRun(schedule, runAt, timezone),
				timezone,
				enabled: data.enabled ?? true,
				createdAt: now,
				updatedAt: now,
				runCount: 0,
				runHistory: [],
				sessionMode: data.sessionMode ?? "reuse",
				sessionId: data.sessionId ?? undefined,
				contextPaths: sanitizePaths(data.contextPaths),
				model: data.model,
				thinkingLevel: data.thinkingLevel,
			};

			state.automations.unshift(automation);
			saveAutomationState(state);
			sendJson(res, 200, { automation }, context.corsHeaders);
			return;
		}

		if (req.method === "PATCH") {
			if (!params?.id) {
				sendJson(
					res,
					400,
					{ error: "Automation id required" },
					context.corsHeaders,
				);
				return;
			}
			const data = await readJsonBody<AutomationUpdateInput>(req);
			const state = loadAutomationState();
			const task = state.automations.find((item) => item.id === params.id);
			if (!task) {
				sendJson(
					res,
					404,
					{ error: "Automation not found" },
					context.corsHeaders,
				);
				return;
			}

			if (typeof data.name === "string") task.name = data.name.trim();
			if (typeof data.prompt === "string") task.prompt = data.prompt.trim();
			if (typeof data.enabled === "boolean") task.enabled = data.enabled;
			if (typeof data.scheduleLabel === "string") {
				task.scheduleLabel = data.scheduleLabel;
			}
			if (data.scheduleKind) task.scheduleKind = data.scheduleKind;
			if (typeof data.scheduleTime === "string") {
				task.scheduleTime = data.scheduleTime;
			}
			if (Array.isArray(data.scheduleDays)) {
				task.scheduleDays = data.scheduleDays;
			}
			if (typeof data.runAt === "string") {
				task.runAt = data.runAt;
			}
			if (typeof data.cronExpression === "string") {
				task.cronExpression = data.cronExpression;
			}
			if (typeof data.sessionMode === "string") {
				task.sessionMode = data.sessionMode;
			}
			if (typeof data.sessionId === "string") {
				task.sessionId = data.sessionId;
			}
			if (Array.isArray(data.contextPaths)) {
				task.contextPaths = sanitizePaths(data.contextPaths);
			}
			if (typeof data.model === "string") {
				task.model = data.model;
			}
			if (data.thinkingLevel) {
				task.thinkingLevel = data.thinkingLevel;
			}
			if (data.clearHistory) {
				task.runHistory = [];
			}

			const timezone =
				data.timezone && isValidTimezone(data.timezone)
					? data.timezone
					: task.timezone;
			task.timezone = timezone;

			if (data.schedule !== undefined) {
				const schedule = data.schedule ? data.schedule.trim() : null;
				if (schedule && !isValidSchedule(schedule)) {
					sendJson(
						res,
						400,
						{ error: "Invalid schedule format" },
						context.corsHeaders,
					);
					return;
				}
				task.schedule = schedule;
			}

			const runAt = parseRunAt(data.runAt ?? null);
			if (data.schedule !== undefined || data.runAt !== undefined) {
				task.nextRun = resolveNextRun(task.schedule, runAt, task.timezone);
			}

			task.updatedAt = new Date().toISOString();
			saveAutomationState(state);
			sendJson(res, 200, { automation: task }, context.corsHeaders);
			return;
		}

		if (req.method === "DELETE") {
			if (!params?.id) {
				sendJson(
					res,
					400,
					{ error: "Automation id required" },
					context.corsHeaders,
				);
				return;
			}
			const state = loadAutomationState();
			const index = state.automations.findIndex(
				(item) => item.id === params.id,
			);
			if (index === -1) {
				sendJson(
					res,
					404,
					{ error: "Automation not found" },
					context.corsHeaders,
				);
				return;
			}
			state.automations.splice(index, 1);
			saveAutomationState(state);
			sendJson(res, 200, { success: true }, context.corsHeaders);
			return;
		}

		sendJson(res, 405, { error: "Method not allowed" }, context.corsHeaders);
	} catch (error) {
		logger.error("Automation handler error", error as Error);
		respondWithApiError(res, error, 500, context.corsHeaders, req);
	}
}

export async function handleAutomationPreview(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	try {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed" }, context.corsHeaders);
			return;
		}

		const data = await readJsonBody<AutomationPreviewInput>(req);
		const timezoneInput =
			typeof data.timezone === "string" ? data.timezone : "UTC";
		const timezoneValid = isValidTimezone(timezoneInput);
		const timezone = timezoneValid ? timezoneInput : "UTC";

		const schedule = data.schedule ? data.schedule.trim() : null;
		const runAt = parseRunAt(data.runAt ?? null);

		if (schedule && !isValidSchedule(schedule)) {
			sendJson(
				res,
				400,
				{ error: "Invalid schedule format", timezoneValid },
				context.corsHeaders,
			);
			return;
		}
		if (!schedule && !runAt) {
			sendJson(
				res,
				400,
				{ error: "Provide schedule or runAt", timezoneValid },
				context.corsHeaders,
			);
			return;
		}

		const nextRun = resolveNextRun(schedule, runAt, timezone);
		sendJson(
			res,
			200,
			{ nextRun, timezone, timezoneValid },
			context.corsHeaders,
		);
	} catch (error) {
		logger.error("Automation preview error", error as Error);
		respondWithApiError(res, error, 500, context.corsHeaders, req);
	}
}
