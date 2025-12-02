/**
 * Notification hooks for agent events.
 *
 * Allows external programs to be notified when agent events occur,
 * enabling CI/automation integration and custom workflows.
 *
 * Configuration via environment variable or config file:
 *   COMPOSER_NOTIFY_PROGRAM=/path/to/script
 *   COMPOSER_NOTIFY_EVENTS=turn-complete,session-end (comma-separated, or "all")
 *
 * The program receives a JSON payload as its first argument with event details.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AppMessage } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("hooks:notify");

export type NotificationEventType =
	| "turn-complete"
	| "session-start"
	| "session-end"
	| "tool-execution"
	| "error";

export interface NotificationPayload {
	type: NotificationEventType;
	timestamp: string;
	threadId?: string;
	turnId?: string;
	cwd: string;
	inputMessages?: string[];
	lastAssistantMessage?: string;
	toolName?: string;
	toolResult?: string;
	error?: string;
}

export interface NotificationHooksConfig {
	program?: string;
	events?: NotificationEventType[];
	timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

let cachedConfig: NotificationHooksConfig | null = null;

/**
 * Load notification hooks configuration from environment or config file.
 */
export function loadNotificationConfig(): NotificationHooksConfig {
	if (cachedConfig) return cachedConfig;

	const config: NotificationHooksConfig = {
		events: [],
		timeout: DEFAULT_TIMEOUT_MS,
	};

	// Check environment variables first
	const envProgram = process.env.COMPOSER_NOTIFY_PROGRAM;
	if (envProgram) {
		config.program = envProgram;
	}

	const envEvents = process.env.COMPOSER_NOTIFY_EVENTS;
	if (envEvents) {
		if (envEvents === "all") {
			config.events = [
				"turn-complete",
				"session-start",
				"session-end",
				"tool-execution",
				"error",
			];
		} else {
			config.events = envEvents
				.split(",")
				.map((e) => e.trim() as NotificationEventType)
				.filter((e) =>
					[
						"turn-complete",
						"session-start",
						"session-end",
						"tool-execution",
						"error",
					].includes(e),
				);
		}
	}

	const envTimeout = process.env.COMPOSER_NOTIFY_TIMEOUT;
	if (envTimeout) {
		const parsed = Number.parseInt(envTimeout, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			config.timeout = parsed;
		}
	}

	// Check config file if no environment override
	if (!config.program) {
		const configPath = join(homedir(), ".composer", "hooks.json");
		if (existsSync(configPath)) {
			try {
				const fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
				if (fileConfig.notify?.program) {
					config.program = fileConfig.notify.program;
				}
				if (fileConfig.notify?.events) {
					config.events = fileConfig.notify.events;
				}
				if (fileConfig.notify?.timeout) {
					config.timeout = fileConfig.notify.timeout;
				}
			} catch (error) {
				logger.warn("Failed to parse hooks.json", { error });
			}
		}
	}

	cachedConfig = config;
	return config;
}

/**
 * Clear cached configuration (useful for testing).
 */
export function clearNotificationConfigCache(): void {
	cachedConfig = null;
}

/**
 * Check if notifications are enabled for a given event type.
 */
export function isNotificationEnabled(
	eventType: NotificationEventType,
): boolean {
	const config = loadNotificationConfig();
	return Boolean(
		config.program && config.events && config.events.includes(eventType),
	);
}

/**
 * Send a notification to the configured external program.
 * This runs asynchronously and does not block the main flow.
 */
export async function sendNotification(
	payload: NotificationPayload,
): Promise<void> {
	const config = loadNotificationConfig();

	if (!config.program) {
		return;
	}

	if (!config.events?.includes(payload.type)) {
		return;
	}

	const jsonPayload = JSON.stringify(payload);

	try {
		await executeNotifyProgram(config.program, jsonPayload, config.timeout);
		logger.debug("Notification sent", { type: payload.type });
	} catch (error) {
		logger.warn("Notification hook failed", {
			program: config.program,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Execute the notification program with the given payload.
 */
function executeNotifyProgram(
	program: string,
	payload: string,
	timeout = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, [payload], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout,
			shell: false,
		});

		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Notify program exited with code ${code}: ${stderr}`));
			}
		});

		// Safety timeout
		setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Notify program timed out"));
		}, timeout + 1000);
	});
}

/**
 * Create notification payload from agent event.
 */
export function createNotificationFromAgentEvent(
	event: AgentEvent,
	context: {
		cwd: string;
		sessionId?: string;
		messages?: AppMessage[];
	},
): NotificationPayload | null {
	const base = {
		timestamp: new Date().toISOString(),
		cwd: context.cwd,
		threadId: context.sessionId,
	};

	switch (event.type) {
		case "agent_start":
			return {
				...base,
				type: "session-start",
			};

		case "agent_end":
			return {
				...base,
				type: "session-end",
				inputMessages: extractUserMessages(context.messages ?? event.messages),
				lastAssistantMessage: extractLastAssistantMessage(event.messages),
			};

		case "turn_end":
			return {
				...base,
				type: "turn-complete",
				inputMessages: extractUserMessages(context.messages ?? []),
				lastAssistantMessage: extractAssistantText(event.message),
			};

		case "tool_execution_end":
			return {
				...base,
				type: "tool-execution",
				toolName: event.toolName,
				toolResult: extractToolResultText(event.result),
			};

		case "error":
			return {
				...base,
				type: "error",
				error: event.message,
			};

		default:
			return null;
	}
}

function extractUserMessages(messages: AppMessage[]): string[] {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => {
			if (typeof m.content === "string") return m.content;
			if (Array.isArray(m.content)) {
				return m.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			}
			return "";
		})
		.filter(Boolean);
}

function extractLastAssistantMessage(
	messages: AppMessage[],
): string | undefined {
	const assistantMessages = messages.filter((m) => m.role === "assistant");
	if (assistantMessages.length === 0) return undefined;
	return extractAssistantText(assistantMessages[assistantMessages.length - 1]);
}

function extractAssistantText(message: AppMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	const textParts = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text);
	return textParts.join("\n") || undefined;
}

function extractToolResultText(
	result: { content: Array<{ type: string; text?: string }> } | undefined,
): string | undefined {
	if (!result?.content) return undefined;
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.slice(0, 1000); // Truncate for payload size
}
