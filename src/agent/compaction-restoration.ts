import { backgroundTaskManager } from "../tools/background-tasks.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { createHookMessage } from "./custom-messages.js";
import {
	getPlanFilePathForCompactionRestore,
	isPlanModeActive,
	readPlanFileForCompactionRestore,
} from "./plan-mode.js";
import type { AppMessage } from "./types.js";

export const PLAN_FILE_COMPACTION_CUSTOM_TYPE = "plan-file";
export const PLAN_MODE_COMPACTION_CUSTOM_TYPE = "plan-mode";
export const BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE = "background-tasks";
export const MCP_SERVERS_COMPACTION_CUSTOM_TYPE = "mcp-servers";

export interface McpServerRestoreState {
	name: string;
	connected: boolean;
	transport: string;
	tools: { name: string }[];
	resources: string[];
	prompts: string[];
}

function sanitizeBackgroundTaskField(value: string): string {
	return sanitizeWithStaticMask(value).replace(/\s+/g, " ").trim();
}

function formatBackgroundTaskCommand(command: string): string {
	const sanitized = sanitizeBackgroundTaskField(command);
	const maxLength = 180;
	if (sanitized.length <= maxLength) {
		return sanitized;
	}
	return `${sanitized.slice(0, maxLength - 3)}...`;
}

function buildBackgroundTasksCompactionContent(): string | null {
	const activeTasks = backgroundTaskManager
		.getTasks()
		.filter((task) => task.status === "running" || task.status === "restarting")
		.sort((left, right) => right.startedAt - left.startedAt);

	if (activeTasks.length === 0) {
		return null;
	}

	const lines = [
		"# Background tasks restored after compaction",
		"",
		"These background tasks are already active in this session. Reuse them instead of starting duplicates unless you intentionally need another one.",
		"",
		...activeTasks.map((task) => {
			const command = formatBackgroundTaskCommand(task.command);
			const cwd = task.cwd
				? `; cwd=${sanitizeBackgroundTaskField(task.cwd)}`
				: "";
			return `- id=${task.id}; status=${task.status}; shell=${task.shellMode}${cwd}; command=${command}`;
		}),
		"",
		"Use `background_tasks` action=list to inspect the current task set and `background_tasks` action=logs taskId=<id> to review output.",
	];

	return lines.join("\n");
}

function hasBackgroundTasksCompactionMessage(
	messages: AppMessage[],
	expectedContent: string,
): boolean {
	return messages.some(
		(message) =>
			message.role === "hookMessage" &&
			message.customType === BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE &&
			message.content === expectedContent,
	);
}

function buildMcpServersCompactionContent(
	servers: readonly McpServerRestoreState[],
): string | null {
	const connectedServers = servers
		.filter((server) => server.connected)
		.sort((left, right) => left.name.localeCompare(right.name));

	if (connectedServers.length === 0) {
		return null;
	}

	return [
		"# Connected MCP servers restored after compaction",
		"",
		"These MCP servers are already connected in this session. Their tools and resources remain available after compaction.",
		"",
		...connectedServers.map(
			(server) =>
				`- ${server.name}; transport=${server.transport}; tools=${server.tools.length}; resources=${server.resources.length}; prompts=${server.prompts.length}`,
		),
		"",
		"Use `list_mcp_servers` to inspect current server status, `list_mcp_tools` to inspect available tool names, and `list_mcp_resources` / `read_mcp_resource` for server resources.",
	].join("\n");
}

function hasMcpServersCompactionMessage(
	messages: AppMessage[],
	expectedContent: string,
): boolean {
	return messages.some(
		(message) =>
			message.role === "hookMessage" &&
			message.customType === MCP_SERVERS_COMPACTION_CUSTOM_TYPE &&
			message.content === expectedContent,
	);
}

function buildPlanFileCompactionContent(
	filePath: string,
	planContent: string,
): string {
	return [
		"# Active plan file restored after compaction",
		"",
		`Plan file: ${filePath}`,
		"",
		"Current plan contents:",
		planContent,
	].join("\n");
}

function buildPlanFileCompactionMessage(
	filePath: string,
	planContent: string,
): AppMessage {
	return createHookMessage(
		PLAN_FILE_COMPACTION_CUSTOM_TYPE,
		buildPlanFileCompactionContent(filePath, planContent),
		false,
		{ filePath },
		new Date().toISOString(),
	);
}

function buildPlanModeCompactionMessage(filePath: string): AppMessage {
	return createHookMessage(
		PLAN_MODE_COMPACTION_CUSTOM_TYPE,
		[
			"# Plan mode remains active after compaction",
			"",
			`Plan file: ${filePath}`,
			"",
			"Continue operating in plan mode.",
			"Treat the active plan file as the source of truth for outstanding work, and read or update it as needed before continuing implementation.",
		].join("\n"),
		false,
		{ filePath },
		new Date().toISOString(),
	);
}

function hasPlanFileCompactionMessage(
	messages: AppMessage[],
	filePath: string,
	planContent: string,
): boolean {
	const expectedContent = buildPlanFileCompactionContent(filePath, planContent);
	return messages.some((message) => {
		if (
			message.role !== "hookMessage" ||
			message.customType !== PLAN_FILE_COMPACTION_CUSTOM_TYPE
		) {
			return false;
		}

		const details = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"filePath" in details &&
			typeof details.filePath === "string" &&
			details.filePath !== filePath
		) {
			return false;
		}

		return message.content === expectedContent;
	});
}

function hasPlanModeCompactionMessage(
	messages: AppMessage[],
	filePath: string,
): boolean {
	return messages.some((message) => {
		if (
			message.role !== "hookMessage" ||
			message.customType !== PLAN_MODE_COMPACTION_CUSTOM_TYPE
		) {
			return false;
		}

		const details = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"filePath" in details &&
			typeof details.filePath === "string"
		) {
			return details.filePath === filePath;
		}

		return (
			typeof message.content === "string" &&
			message.content.includes(`Plan file: ${filePath}`)
		);
	});
}

export function collectPlanMessagesForCompaction(
	messages: AppMessage[],
): AppMessage[] {
	const filePath = getPlanFilePathForCompactionRestore();
	if (!filePath) {
		return [];
	}

	const restoredMessages: AppMessage[] = [];
	const planContent = readPlanFileForCompactionRestore();
	if (
		typeof planContent === "string" &&
		planContent.length > 0 &&
		!hasPlanFileCompactionMessage(messages, filePath, planContent)
	) {
		restoredMessages.push(
			buildPlanFileCompactionMessage(filePath, planContent),
		);
	}

	if (isPlanModeActive() && !hasPlanModeCompactionMessage(messages, filePath)) {
		restoredMessages.push(buildPlanModeCompactionMessage(filePath));
	}

	return restoredMessages;
}

export function collectPlanModeMessagesForCompaction(
	messages: AppMessage[],
): AppMessage[] {
	return collectPlanMessagesForCompaction(messages).filter(
		(message) =>
			message.role === "hookMessage" &&
			message.customType === PLAN_MODE_COMPACTION_CUSTOM_TYPE,
	);
}

export function collectBackgroundTaskMessagesForCompaction(
	messages: AppMessage[],
): AppMessage[] {
	const content = buildBackgroundTasksCompactionContent();
	if (
		typeof content !== "string" ||
		hasBackgroundTasksCompactionMessage(messages, content)
	) {
		return [];
	}

	return [
		createHookMessage(
			BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE,
			content,
			false,
			undefined,
			new Date().toISOString(),
		),
	];
}

export function collectMcpMessagesForCompaction(
	messages: AppMessage[],
	servers: readonly McpServerRestoreState[],
): AppMessage[] {
	const content = buildMcpServersCompactionContent(servers);
	if (
		typeof content !== "string" ||
		hasMcpServersCompactionMessage(messages, content)
	) {
		return [];
	}

	return [
		createHookMessage(
			MCP_SERVERS_COMPACTION_CUSTOM_TYPE,
			content,
			false,
			undefined,
			new Date().toISOString(),
		),
	];
}
