import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentEvent, AppMessage } from "../../agent/types.js";
import { createLogger } from "../../utils/logger.js";
import type { WebServerContext } from "../app-context.js";
import { createSessionManagerForScope } from "../session-scope.js";
import {
	type AutomationTask,
	loadAutomationState,
	saveAutomationState,
} from "../stores/automation-store.js";
import { getNextRunFromSchedule, isValidTimezone } from "./schedule-utils.js";

const logger = createLogger("automations");

const POLL_INTERVAL_MS =
	Number.parseInt(process.env.COMPOSER_AUTOMATION_POLL_MS || "15000", 10) ||
	15000;
const MAX_CONTEXT_FILES =
	Number.parseInt(
		process.env.COMPOSER_AUTOMATION_CONTEXT_MAX_FILES || "12",
		10,
	) || 12;
const MAX_CONTEXT_BYTES =
	Number.parseInt(
		process.env.COMPOSER_AUTOMATION_CONTEXT_MAX_BYTES || "120000",
		10,
	) || 120000;
const MAX_CONTEXT_FILE_BYTES =
	Number.parseInt(
		process.env.COMPOSER_AUTOMATION_CONTEXT_MAX_FILE_BYTES || "40000",
		10,
	) || 40000;
const MAX_OUTPUT_SNIPPET =
	Number.parseInt(
		process.env.COMPOSER_AUTOMATION_OUTPUT_MAX_CHARS || "1400",
		10,
	) || 1400;

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

	task.running = true;
	task.updatedAt = new Date().toISOString();
	saveAutomationState(state);

	runningTaskIds.add(automationId);
	const start = performance.now();

	try {
		const result = await executeAutomation(task, context);
		const durationMs = Math.round(performance.now() - start);

		task.lastRunAt = new Date().toISOString();
		task.lastRunDurationMs = durationMs;
		task.lastRunStatus = result.success ? "success" : "failure";
		task.lastRunError = result.error ?? undefined;
		if (result.output) {
			task.lastOutput = result.output.slice(0, MAX_OUTPUT_SNIPPET);
		}

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
		task.lastRunAt = new Date().toISOString();
		task.lastRunStatus = "failure";
		task.lastRunError = error instanceof Error ? error.message : String(error);
		task.running = false;
		task.updatedAt = new Date().toISOString();
		saveAutomationState(state);
		return task;
	} finally {
		runningTaskIds.delete(automationId);
	}
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

	const { contextText } = buildContextPrompt(task.contextPaths || []);
	const userInput = contextText
		? `${task.prompt}\n\n${contextText}`
		: task.prompt;

	let lastAssistantOutput: string | undefined;

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end") {
			sessionManager.saveMessage(event.message);
			if (event.message.role === "assistant") {
				lastAssistantOutput = extractTextFromMessage(event.message);
			}
		}
	});

	try {
		await agent.prompt(userInput);
		await sessionManager.flush();
		unsubscribe();
		return { success: true, output: lastAssistantOutput, sessionId };
	} catch (error) {
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

function buildContextPrompt(paths: string[]): { contextText: string } {
	const cleaned = paths
		.map((path) => path.trim())
		.filter(Boolean)
		.slice(0, MAX_CONTEXT_FILES);
	if (cleaned.length === 0) return { contextText: "" };

	let totalBytes = 0;
	const sections: string[] = [];

	for (const path of cleaned) {
		const resolved = resolve(process.cwd(), path);
		if (!existsSync(resolved)) {
			sections.push(`- ${path} (missing)`);
			continue;
		}
		const stats = statSync(resolved);
		if (!stats.isFile()) {
			sections.push(`- ${path} (not a file)`);
			continue;
		}
		const raw = readFileSync(resolved, "utf-8");
		let content = raw.slice(0, MAX_CONTEXT_FILE_BYTES);
		let truncated = raw.length > MAX_CONTEXT_FILE_BYTES;
		if (totalBytes + content.length > MAX_CONTEXT_BYTES) {
			const remaining = Math.max(0, MAX_CONTEXT_BYTES - totalBytes);
			content = content.slice(0, remaining);
			truncated = true;
		}
		totalBytes += content.length;

		const header = `### ${path}`;
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
