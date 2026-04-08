import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { DateTime } from "luxon";
import type { AgentEvent, AppMessage } from "../../agent/types.js";
import { runUserPromptWithRecovery } from "../../agent/user-prompt-runtime.js";
import { withMcpPostKeepMessages } from "../../mcp/prompt-recovery.js";
import { createAutomaticMemoryExtractionCoordinator } from "../../memory/auto-extraction.js";
import type { RegisteredModel } from "../../models/registry.js";
import { createRuntimeSessionSummaryUpdater } from "../../session/runtime-summary-updater.js";
import { createLogger } from "../../utils/logger.js";
import type { WebServerContext } from "../app-context.js";
import { createSessionManagerForScope } from "../session-scope.js";
import {
	type AutomationRunRecord,
	type AutomationRunWindow,
	type AutomationTask,
	loadAutomationState,
	saveAutomationState,
} from "../stores/automation-store.js";
import { getNextRunFromSchedule, isValidTimezone } from "./schedule-utils.js";

const logger = createLogger("automations");

const POLL_INTERVAL_MS =
	Number.parseInt(process.env.MAESTRO_AUTOMATION_POLL_MS || "15000", 10) ||
	15000;
const MAX_CONTEXT_FILES =
	Number.parseInt(
		process.env.MAESTRO_AUTOMATION_CONTEXT_MAX_FILES || "12",
		10,
	) || 12;
const MAX_CONTEXT_BYTES =
	Number.parseInt(
		process.env.MAESTRO_AUTOMATION_CONTEXT_MAX_BYTES || "120000",
		10,
	) || 120000;
const MAX_CONTEXT_FILE_BYTES =
	Number.parseInt(
		process.env.MAESTRO_AUTOMATION_CONTEXT_MAX_FILE_BYTES || "40000",
		10,
	) || 40000;
const MAX_OUTPUT_SNIPPET =
	Number.parseInt(
		process.env.MAESTRO_AUTOMATION_OUTPUT_MAX_CHARS || "1400",
		10,
	) || 1400;
const MAX_AUTOMATION_CONCURRENCY =
	Number.parseInt(process.env.MAESTRO_AUTOMATION_MAX_CONCURRENCY || "2", 10) ||
	2;
const MAX_CONTEXT_FOLDER_FILES =
	Number.parseInt(
		process.env.MAESTRO_AUTOMATION_CONTEXT_MAX_FOLDER_FILES || "25",
		10,
	) || 25;
const CONCURRENCY_RETRY_MS =
	Number.parseInt(
		process.env.MAESTRO_AUTOMATION_CONCURRENCY_RETRY_MS || "60000",
		10,
	) || 60000;
const MAX_RUN_HISTORY =
	Number.parseInt(process.env.MAESTRO_AUTOMATION_RUN_HISTORY_MAX || "20", 10) ||
	20;

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const runningTaskIds = new Set<string>();

export function startAutomationScheduler(context: WebServerContext): void {
	if (schedulerInterval) return;

	const tick = () => {
		void checkAutomations(context);
	};

	// Run once immediately on boot
	tick();
	schedulerInterval = setInterval(tick, POLL_INTERVAL_MS);

	if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
		schedulerInterval.unref();
	}

	logger.info("Automation scheduler started", { intervalMs: POLL_INTERVAL_MS });
}

export function stopAutomationScheduler(): void {
	if (!schedulerInterval) return;
	clearInterval(schedulerInterval);
	schedulerInterval = null;
}

export async function runAutomationById(
	automationId: string,
	context: WebServerContext,
	reason: "manual" | "schedule" = "manual",
): Promise<AutomationTask | null> {
	if (runningTaskIds.has(automationId)) {
		return null;
	}

	const state = loadAutomationState();
	const index = state.automations.findIndex((task) => task.id === automationId);
	if (index === -1) return null;

	const task = state.automations[index]!;
	if (reason === "schedule" && !task.enabled) return null;

	const concurrencySkip = getConcurrencySkipReason(task);
	const windowSkip = getRunWindowSkipReason(task);
	if (concurrencySkip || windowSkip) {
		const now = new Date();
		const skipReason = concurrencySkip ?? windowSkip ?? "Skipped";
		recordSkippedRun(task, reason, skipReason);
		if (reason === "schedule") {
			task.nextRun =
				computeNextAfterSkip(task, now, skipReason)?.toISOString() ?? null;
		}
		task.running = false;
		task.updatedAt = new Date().toISOString();
		saveAutomationState(state);
		return task;
	}

	task.running = true;
	task.updatedAt = new Date().toISOString();
	saveAutomationState(state);

	runningTaskIds.add(automationId);
	const startedAt = new Date().toISOString();
	const start = performance.now();

	try {
		const result = await executeAutomation(task, context);
		const durationMs = Math.round(performance.now() - start);

		const finishedAt = new Date().toISOString();
		task.lastRunAt = finishedAt;
		task.lastRunDurationMs = durationMs;
		task.lastRunStatus = result.success ? "success" : "failure";
		task.lastRunError = result.error ?? undefined;
		const outputSnippet = result.output
			? result.output.slice(0, MAX_OUTPUT_SNIPPET)
			: undefined;
		if (outputSnippet) {
			task.lastOutput = outputSnippet;
		}
		const runRecord: AutomationRunRecord = {
			id: randomUUID(),
			startedAt,
			finishedAt,
			durationMs,
			status: result.success ? "success" : "failure",
			trigger: reason,
			error: result.error ?? undefined,
			output: outputSnippet,
			sessionId: result.sessionId,
		};
		task.runHistory = [runRecord, ...(task.runHistory ?? [])].slice(
			0,
			MAX_RUN_HISTORY,
		);

		if (result.sessionId) {
			task.lastSessionId = result.sessionId;
			if (task.sessionMode === "reuse") {
				task.sessionId = result.sessionId;
			}
		}

		if (task.schedule) {
			const shouldAdvance =
				reason === "schedule" ||
				!task.nextRun ||
				Date.parse(task.nextRun) <= Date.now();
			if (shouldAdvance) {
				task.nextRun = computeNextRun(task, new Date()).toISOString();
			}
		} else {
			task.nextRun = null;
			task.enabled = false;
		}

		task.runCount = (task.runCount || 0) + 1;
		task.running = false;
		task.updatedAt = new Date().toISOString();
		saveAutomationState(state);
		return task;
	} catch (error) {
		logger.error("Automation execution failed", error as Error, {
			automationId,
		});
		const finishedAt = new Date().toISOString();
		task.lastRunAt = finishedAt;
		task.lastRunStatus = "failure";
		task.lastRunError = error instanceof Error ? error.message : String(error);
		const durationMs = Math.round(performance.now() - start);
		const runRecord: AutomationRunRecord = {
			id: randomUUID(),
			startedAt,
			finishedAt,
			durationMs,
			status: "failure",
			trigger: reason,
			error: task.lastRunError,
		};
		task.runHistory = [runRecord, ...(task.runHistory ?? [])].slice(
			0,
			MAX_RUN_HISTORY,
		);
		task.running = false;
		task.updatedAt = new Date().toISOString();
		saveAutomationState(state);
		return task;
	} finally {
		runningTaskIds.delete(automationId);
	}
}

function getConcurrencySkipReason(task: AutomationTask): string | null {
	if (task.exclusive && runningTaskIds.size > 0) {
		return "Another automation is running.";
	}
	if (runningTaskIds.size >= MAX_AUTOMATION_CONCURRENCY) {
		return "Automation concurrency limit reached.";
	}
	return null;
}

function getRunWindowSkipReason(task: AutomationTask): string | null {
	if (!task.runWindow) return null;
	const zone =
		task.timezone && isValidTimezone(task.timezone) ? task.timezone : "UTC";
	return isWithinRunWindow(task.runWindow, new Date(), zone)
		? null
		: "Outside run window.";
}

function recordSkippedRun(
	task: AutomationTask,
	reason: "manual" | "schedule",
	skipReason: string,
): void {
	const finishedAt = new Date().toISOString();
	task.lastRunAt = finishedAt;
	task.lastRunStatus = "skipped";
	task.lastRunError = skipReason;
	task.lastRunDurationMs = 0;
	const runRecord: AutomationRunRecord = {
		id: randomUUID(),
		startedAt: finishedAt,
		finishedAt,
		durationMs: 0,
		status: "skipped",
		trigger: reason,
		error: skipReason,
	};
	task.runHistory = [runRecord, ...(task.runHistory ?? [])].slice(
		0,
		MAX_RUN_HISTORY,
	);
}

function computeNextAfterSkip(
	task: AutomationTask,
	after: Date,
	reason: string,
): Date | null {
	const zone =
		task.timezone && isValidTimezone(task.timezone) ? task.timezone : "UTC";
	if (task.runWindow && reason === "Outside run window.") {
		const windowStart = getNextRunWindowStart(task.runWindow, after, zone);
		if (windowStart) return windowStart;
	}
	if (
		reason === "Automation concurrency limit reached." ||
		reason === "Another automation is running."
	) {
		return new Date(after.getTime() + CONCURRENCY_RETRY_MS);
	}
	if (task.schedule) {
		return computeNextRun(task, after);
	}
	if (task.runAt) {
		const runAt = new Date(task.runAt);
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > after.getTime()) {
			return runAt;
		}
	}
	return new Date(after.getTime() + CONCURRENCY_RETRY_MS);
}

async function checkAutomations(context: WebServerContext): Promise<void> {
	const state = loadAutomationState();
	let touched = false;
	const now = Date.now();

	for (const task of state.automations) {
		if (!task.enabled) continue;
		if (task.running) continue;
		if (task.schedule && !task.nextRun) {
			try {
				task.nextRun = computeNextRun(task, new Date()).toISOString();
				touched = true;
			} catch (error) {
				logger.warn("Failed to compute next run", {
					automationId: task.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			continue;
		}
		if (!task.nextRun) continue;
		const due = Date.parse(task.nextRun) <= now;
		if (!due) continue;
		if (runningTaskIds.has(task.id)) continue;

		void runAutomationById(task.id, context, "schedule");
	}

	if (touched) {
		saveAutomationState(state);
	}
}

function computeNextRun(task: AutomationTask, after: Date): Date {
	if (!task.schedule) return after;
	const zone =
		task.timezone && isValidTimezone(task.timezone) ? task.timezone : "UTC";
	return getNextRunFromSchedule(task.schedule, after, zone);
}

function parseWindowTime(
	value: string,
): { hour: number; minute: number } | null {
	const [hourText, minuteText] = value.split(":");
	const hour = Number.parseInt(hourText ?? "", 10);
	const minute = Number.parseInt(minuteText ?? "", 10);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
	if (hour < 0 || hour > 23) return null;
	if (minute < 0 || minute > 59) return null;
	return { hour, minute };
}

function isWithinRunWindow(
	window: AutomationRunWindow,
	now: Date,
	timezone: string,
): boolean {
	const start = parseWindowTime(window.start);
	const end = parseWindowTime(window.end);
	if (!start || !end) return true;

	const nowDt = DateTime.fromJSDate(now).setZone(timezone);
	const minutes = nowDt.hour * 60 + nowDt.minute;
	const startMinutes = start.hour * 60 + start.minute;
	const endMinutes = end.hour * 60 + end.minute;
	const crossesMidnight = endMinutes <= startMinutes;
	const withinTime = crossesMidnight
		? minutes >= startMinutes || minutes < endMinutes
		: minutes >= startMinutes && minutes < endMinutes;

	if (!withinTime) return false;
	if (!window.days || window.days.length === 0) return true;

	const todayIndex = nowDt.weekday === 7 ? 0 : nowDt.weekday;
	const dayIndex =
		crossesMidnight && minutes < endMinutes ? (todayIndex + 6) % 7 : todayIndex;
	return window.days.includes(dayIndex);
}

function getNextRunWindowStart(
	window: AutomationRunWindow,
	after: Date,
	timezone: string,
): Date | null {
	const start = parseWindowTime(window.start);
	if (!start) return null;
	const base = DateTime.fromJSDate(after).setZone(timezone);
	const daysFilter =
		window.days && window.days.length > 0 ? new Set(window.days) : null;

	for (let offset = 0; offset <= 7; offset += 1) {
		const day = base.plus({ days: offset }).startOf("day");
		const dayIndex = day.weekday === 7 ? 0 : day.weekday;
		if (daysFilter && !daysFilter.has(dayIndex)) {
			continue;
		}
		const candidate = day.set({
			hour: start.hour,
			minute: start.minute,
			second: 0,
			millisecond: 0,
		});
		if (candidate.toMillis() > base.toMillis()) {
			return candidate.toJSDate();
		}
	}

	return base
		.plus({ days: 1 })
		.set({
			hour: start.hour,
			minute: start.minute,
			second: 0,
			millisecond: 0,
		})
		.toJSDate();
}

async function executeAutomation(
	task: AutomationTask,
	context: WebServerContext,
): Promise<{
	success: boolean;
	error?: string;
	output?: string;
	sessionId?: string;
}> {
	const {
		createAgent,
		getRegisteredModel,
		defaultApprovalMode,
		getCurrentSelection,
	} = context;

	const selection = getCurrentSelection();
	const modelInput = task.model || `${selection.provider}:${selection.modelId}`;
	const registeredModel = await getRegisteredModel(modelInput);
	const approvalMode =
		defaultApprovalMode === "prompt" ? "auto" : defaultApprovalMode;

	const agent = await createAgent(
		registeredModel,
		task.thinkingLevel || "off",
		approvalMode,
	);

	const sessionManager = createSessionManagerForScope(null, false);
	let sessionId = task.sessionId || null;

	if (task.sessionMode === "new") {
		await sessionManager.createSession({ title: task.name });
		sessionId = sessionManager.getSessionId();
	} else if (sessionId) {
		const sessionFile = sessionManager.getSessionFileById(sessionId);
		if (sessionFile) {
			sessionManager.setSessionFile(sessionFile);
			const session = await sessionManager.loadSession(sessionId);
			if (session?.messages?.length) {
				agent.replaceMessages(session.messages);
			}
		} else {
			await sessionManager.createSession({ title: task.name });
			sessionId = sessionManager.getSessionId();
		}
	} else {
		await sessionManager.createSession({ title: task.name });
		sessionId = sessionManager.getSessionId();
	}

	sessionManager.startSession(agent.state, { subject: "automation" });

	const { contextText } = buildContextPrompt(
		task.contextPaths || [],
		task.contextFolders || [],
	);
	const renderedPrompt = renderAutomationPrompt(task);
	const userInput = contextText
		? `${renderedPrompt}\n\n${contextText}`
		: renderedPrompt;

	let lastAssistantOutput: string | undefined;
	const updateSessionSummary =
		createRuntimeSessionSummaryUpdater(sessionManager);
	const automaticMemoryExtraction = createAutomaticMemoryExtractionCoordinator({
		createAgent: async () =>
			context.createBackgroundAgent(agent.state.model as RegisteredModel),
		getModel: () => agent.state.model,
		sessionManager,
	});

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		updateSessionSummary(event);

		if (event.type === "message_end") {
			sessionManager.saveMessage(event.message);
			if (event.message.role === "assistant") {
				automaticMemoryExtraction.schedule(sessionManager.getSessionFile());
				lastAssistantOutput = extractTextFromMessage(event.message);
			}
		}
	});

	try {
		await runUserPromptWithRecovery({
			agent,
			sessionManager,
			cwd: process.cwd(),
			prompt: userInput,
			execute: () => agent.prompt(userInput),
			getPostKeepMessages: withMcpPostKeepMessages(),
		});
		await automaticMemoryExtraction.flush();
		await sessionManager.flush();
		unsubscribe();
		return { success: true, output: lastAssistantOutput, sessionId };
	} catch (error) {
		await automaticMemoryExtraction.flush();
		await sessionManager.flush();
		unsubscribe();
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			output: lastAssistantOutput,
			sessionId,
		};
	}
}

function buildContextPrompt(
	paths: string[],
	folders: string[],
): { contextText: string } {
	const cleanedPaths = paths.map((path) => path.trim()).filter(Boolean);
	const cleanedFolders = folders.map((path) => path.trim()).filter(Boolean);

	if (cleanedPaths.length === 0 && cleanedFolders.length === 0) {
		return { contextText: "" };
	}

	const cwd = process.cwd();
	const entries: Array<{ path: string; label: string }> = [];
	const folderNotes: string[] = [];

	const addEntry = (path: string, label: string) => {
		if (entries.length >= MAX_CONTEXT_FILES) return;
		entries.push({ path, label });
	};

	for (const path of cleanedPaths) {
		if (entries.length >= MAX_CONTEXT_FILES) break;
		const label = formatDisplayPath(path, cwd);
		addEntry(path, label);
	}

	for (const folder of cleanedFolders) {
		if (entries.length >= MAX_CONTEXT_FILES) break;
		const resolvedFolder = resolve(cwd, folder);
		if (!existsSync(resolvedFolder)) {
			folderNotes.push(`- ${folder} (missing)`);
			continue;
		}
		const stats = statSync(resolvedFolder);
		if (!stats.isDirectory()) {
			folderNotes.push(`- ${folder} (not a folder)`);
			continue;
		}
		const remaining = Math.max(
			0,
			Math.min(MAX_CONTEXT_FOLDER_FILES, MAX_CONTEXT_FILES - entries.length),
		);
		const files = collectFilesFromDirectory(resolvedFolder, remaining);
		if (files.length === 0) {
			folderNotes.push(`- ${folder} (no readable files)`);
			continue;
		}
		for (const filePath of files) {
			if (entries.length >= MAX_CONTEXT_FILES) break;
			const label = formatDisplayPath(filePath, cwd);
			addEntry(filePath, label);
		}
	}

	let totalBytes = 0;
	const sections: string[] = [];

	if (folderNotes.length > 0) {
		sections.push(`Folder snapshots:\n${folderNotes.join("\n")}`);
	}

	for (const entry of entries) {
		const resolved = resolve(cwd, entry.path);
		if (!existsSync(resolved)) {
			sections.push(`- ${entry.label} (missing)`);
			continue;
		}
		const stats = statSync(resolved);
		if (!stats.isFile()) {
			sections.push(`- ${entry.label} (not a file)`);
			continue;
		}
		const raw = readFileSync(resolved, "utf-8");
		if (raw.includes("\u0000")) {
			sections.push(`- ${entry.label} (binary skipped)`);
			continue;
		}
		let content = raw.slice(0, MAX_CONTEXT_FILE_BYTES);
		let truncated = raw.length > MAX_CONTEXT_FILE_BYTES;
		if (totalBytes + content.length > MAX_CONTEXT_BYTES) {
			const remaining = Math.max(0, MAX_CONTEXT_BYTES - totalBytes);
			content = content.slice(0, remaining);
			truncated = true;
		}
		totalBytes += content.length;

		const header = `### ${entry.label}`;
		const body = content.trimEnd();
		const suffix = truncated ? "\n…(truncated)" : "";
		sections.push([header, "```", `${body}${suffix}`, "```"].join("\n"));

		if (totalBytes >= MAX_CONTEXT_BYTES) {
			sections.push("_Context truncated to keep prompts light._");
			break;
		}
	}

	return {
		contextText:
			`Context files (auto-injected):\n${sections.join("\n\n")}`.trim(),
	};
}

function collectFilesFromDirectory(root: string, limit: number): string[] {
	if (limit <= 0) return [];
	const results: string[] = [];
	const stack = [root];
	const skipFolders = new Set([
		".git",
		"node_modules",
		"dist",
		"build",
		"coverage",
		".next",
		".turbo",
		".cache",
		"tmp",
		"out",
	]);
	const skipExtensions = new Set([
		".png",
		".jpg",
		".jpeg",
		".gif",
		".webp",
		".pdf",
		".zip",
		".tar",
		".gz",
		".bz2",
		".7z",
		".dmg",
		".exe",
		".bin",
		".mp4",
		".mp3",
		".mov",
		".ico",
		".lock",
	]);

	while (stack.length > 0 && results.length < limit) {
		const current = stack.pop();
		if (!current) continue;
		let entries: Array<{
			name: string | Buffer;
			isDirectory: () => boolean;
			isFile: () => boolean;
		}>;
		try {
			entries = readdirSync(current, { withFileTypes: true }) as typeof entries;
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (results.length >= limit) break;
			const entryName =
				typeof entry.name === "string" ? entry.name : entry.name.toString();
			if (entryName.startsWith(".")) continue;
			const full = resolve(current, entryName);
			if (entry.isDirectory()) {
				if (skipFolders.has(entryName)) continue;
				stack.push(full);
			} else if (entry.isFile()) {
				const extIndex = entryName.lastIndexOf(".");
				const ext =
					extIndex > -1 ? entryName.slice(extIndex).toLowerCase() : "";
				if (skipExtensions.has(ext)) continue;
				results.push(full);
			}
		}
	}

	return results.sort();
}

function formatDisplayPath(path: string, cwd: string): string {
	try {
		const rel = relative(cwd, path);
		if (!rel.startsWith("..") && !rel.startsWith("/")) {
			return rel;
		}
	} catch {
		// ignore
	}
	return path;
}

function renderAutomationPrompt(task: AutomationTask): string {
	const timezone =
		task.timezone && isValidTimezone(task.timezone) ? task.timezone : "UTC";
	const now = new Date();
	const dateFormatter = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeZone: timezone,
	});
	const timeFormatter = new Intl.DateTimeFormat(undefined, {
		timeStyle: "short",
		timeZone: timezone,
	});
	const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: timezone,
	});

	const formatDate = (value?: string | null) => {
		if (!value) return "";
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return dateTimeFormatter.format(date);
	};

	const tokens: Record<string, string> = {
		automation_name: task.name,
		date: dateFormatter.format(now),
		time: timeFormatter.format(now),
		datetime: dateTimeFormatter.format(now),
		timezone,
		run_count: String(task.runCount ?? 0),
		last_run_at: formatDate(task.lastRunAt),
		last_status: task.lastRunStatus ?? "",
		last_error: task.lastRunError ?? "",
		last_output: task.lastOutput ?? "",
		next_run_at: formatDate(task.nextRun),
		schedule_label: task.scheduleLabel ?? "",
		workspace: process.cwd(),
	};

	return task.prompt.replace(
		/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
		(match, key: string) => tokens[key] ?? match,
	);
}

function extractTextFromMessage(message: AppMessage): string {
	if (!message || typeof message !== "object") return "";
	if ("content" in message) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(block): block is { type: string; text?: string } =>
						Boolean(block) &&
						typeof block === "object" &&
						(block as { type?: unknown }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string",
				)
				.map((block) => block.text ?? "")
				.join(" ");
		}
	}
	if ("summary" in message) {
		const summary = (message as { summary?: unknown }).summary;
		if (typeof summary === "string") return summary;
	}
	return "";
}
