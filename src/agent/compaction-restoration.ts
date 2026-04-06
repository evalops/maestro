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
export const HEADLESS_CLIENT_REQUESTS_COMPACTION_CUSTOM_TYPE =
	"headless-client-requests";
const MAX_MCP_RESTORED_ITEMS_PER_CATEGORY = 5;
const MAX_HEADLESS_RESTORED_REQUESTS = 5;
const MAX_HEADLESS_ARGS_SUMMARY_LENGTH = 180;

export interface McpServerRestoreState {
	name: string;
	connected: boolean;
	transport: string;
	tools: { name: string }[];
	resources: string[];
	prompts: string[];
}

export interface HeadlessPendingRequestRestoreState {
	call_id: string;
	request_id?: string;
	tool: string;
	args: unknown;
	display_name?: string;
	summary_label?: string;
	action_description?: string;
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

function formatMcpRestoredItems(items: readonly string[]): string | null {
	const uniqueItems = Array.from(new Set(items)).sort((left, right) =>
		left.localeCompare(right),
	);
	if (uniqueItems.length === 0) {
		return null;
	}

	const visibleItems = uniqueItems.slice(
		0,
		MAX_MCP_RESTORED_ITEMS_PER_CATEGORY,
	);
	const hiddenCount = uniqueItems.length - visibleItems.length;
	return hiddenCount > 0
		? `${visibleItems.join(", ")} (+${hiddenCount} more)`
		: visibleItems.join(", ");
}

function buildMcpServerCompactionLine(server: McpServerRestoreState): string {
	const toolNames = formatMcpRestoredItems(
		server.tools.map((tool) => tool.name),
	);
	const resources = formatMcpRestoredItems(server.resources);
	const prompts = formatMcpRestoredItems(server.prompts);

	const sections = [`- ${server.name}; transport=${server.transport}`];
	sections.push(
		toolNames
			? `tools=${server.tools.length} [${toolNames}]`
			: `tools=${server.tools.length}`,
	);
	sections.push(
		resources
			? `resources=${server.resources.length} [${resources}]`
			: `resources=${server.resources.length}`,
	);
	sections.push(
		prompts
			? `prompts=${server.prompts.length} [${prompts}]`
			: `prompts=${server.prompts.length}`,
	);

	return sections.join("; ");
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
		"These MCP servers are already connected in this session. Their tools, resources, and prompts remain available after compaction.",
		"",
		...connectedServers.map(buildMcpServerCompactionLine),
		"",
		"Use `list_mcp_servers` to inspect current server status, `list_mcp_tools` to inspect available tool names, `list_mcp_resources` / `read_mcp_resource` for server resources, and `list_mcp_prompts` / `get_mcp_prompt` for server prompts.",
	].join("\n");
}

function sanitizeHeadlessRequestField(value: string): string {
	return sanitizeWithStaticMask(value).replace(/\s+/g, " ").trim();
}

function redactStructuredSecretFields(value: string): string {
	return value.replace(
		/"[^"]*(?:token|secret|password|key)[^"]*"\s*:\s*"([^"]+)"/gi,
		(full, secret: string) => full.replace(secret, "[secret]"),
	);
}

function stringifyHeadlessRequestArgs(args: unknown): string | null {
	try {
		const serialized = JSON.stringify(args);
		if (typeof serialized !== "string" || serialized.length === 0) {
			return null;
		}
		const sanitized = sanitizeHeadlessRequestField(
			redactStructuredSecretFields(serialized),
		);
		if (sanitized.length <= MAX_HEADLESS_ARGS_SUMMARY_LENGTH) {
			return sanitized;
		}
		return `${sanitized.slice(0, MAX_HEADLESS_ARGS_SUMMARY_LENGTH - 3)}...`;
	} catch {
		return null;
	}
}

function summarizeHeadlessUserInputArgs(args: unknown): string | null {
	if (typeof args !== "object" || args === null || !("questions" in args)) {
		return null;
	}

	const questions = Array.isArray(args.questions) ? args.questions : [];
	if (questions.length === 0) {
		return null;
	}

	const headers = questions
		.map((question) =>
			typeof question === "object" &&
			question !== null &&
			"header" in question &&
			typeof question.header === "string"
				? sanitizeHeadlessRequestField(question.header)
				: null,
		)
		.filter((header): header is string => Boolean(header));
	const visibleHeaders = headers.slice(0, 3);
	const hiddenHeaderCount = headers.length - visibleHeaders.length;

	if (visibleHeaders.length === 0) {
		return `questions=${questions.length}`;
	}

	const suffix = hiddenHeaderCount > 0 ? ` (+${hiddenHeaderCount} more)` : "";
	return `questions=${questions.length} [${visibleHeaders.join(", ")}${suffix}]`;
}

function summarizeHeadlessToolRetryArgs(args: unknown): string | null {
	if (typeof args !== "object" || args === null) {
		return null;
	}

	const sections: string[] = [];
	if ("attempt" in args && typeof args.attempt === "number") {
		sections.push(`attempt=${args.attempt}`);
	}
	if (
		"summary" in args &&
		typeof args.summary === "string" &&
		args.summary.length > 0
	) {
		sections.push(`summary=${sanitizeHeadlessRequestField(args.summary)}`);
	}
	if (
		"error_message" in args &&
		typeof args.error_message === "string" &&
		args.error_message.length > 0
	) {
		sections.push(`error=${sanitizeHeadlessRequestField(args.error_message)}`);
	}
	if ("args" in args && typeof args.args === "object" && args.args !== null) {
		const nestedArgs = stringifyHeadlessRequestArgs(args.args);
		if (nestedArgs) {
			sections.push(`args=${nestedArgs}`);
		}
	}

	return sections.length > 0 ? sections.join("; ") : null;
}

function buildHeadlessPendingRequestLine(
	type:
		| "approval"
		| "client_tool"
		| "mcp_elicitation"
		| "user_input"
		| "tool_retry",
	request: HeadlessPendingRequestRestoreState,
): string {
	const sections = [
		`- type=${type}`,
		`tool=${sanitizeHeadlessRequestField(request.tool)}`,
		`call_id=${sanitizeHeadlessRequestField(request.call_id)}`,
	];

	if (
		typeof request.request_id === "string" &&
		request.request_id.length > 0 &&
		request.request_id !== request.call_id
	) {
		sections.push(
			`request_id=${sanitizeHeadlessRequestField(request.request_id)}`,
		);
	}
	if (
		typeof request.display_name === "string" &&
		request.display_name.length > 0
	) {
		sections.push(
			`display_name=${sanitizeHeadlessRequestField(request.display_name)}`,
		);
	}
	if (
		typeof request.summary_label === "string" &&
		request.summary_label.length > 0
	) {
		sections.push(
			`summary=${sanitizeHeadlessRequestField(request.summary_label)}`,
		);
	}
	if (
		typeof request.action_description === "string" &&
		request.action_description.length > 0
	) {
		sections.push(
			`action=${sanitizeHeadlessRequestField(request.action_description)}`,
		);
	}

	const argsSummary =
		type === "user_input"
			? (summarizeHeadlessUserInputArgs(request.args) ??
				stringifyHeadlessRequestArgs(request.args))
			: type === "tool_retry"
				? (summarizeHeadlessToolRetryArgs(request.args) ??
					stringifyHeadlessRequestArgs(request.args))
				: stringifyHeadlessRequestArgs(request.args);
	if (argsSummary) {
		sections.push(
			(type === "user_input" && argsSummary.startsWith("questions=")) ||
				(type === "tool_retry" &&
					(argsSummary.startsWith("attempt=") ||
						argsSummary.startsWith("summary=") ||
						argsSummary.startsWith("error=")))
				? argsSummary
				: `args=${argsSummary}`,
		);
	}

	return sections.join("; ");
}

function buildHeadlessRuntimeRequestsCompactionContent(params: {
	pendingApprovals: readonly HeadlessPendingRequestRestoreState[];
	pendingClientTools: readonly HeadlessPendingRequestRestoreState[];
	pendingUserInputs: readonly HeadlessPendingRequestRestoreState[];
	pendingToolRetries: readonly HeadlessPendingRequestRestoreState[];
}): string | null {
	const pendingRequests = [
		...params.pendingApprovals.map((request) =>
			buildHeadlessPendingRequestLine("approval", request),
		),
		...params.pendingClientTools.map((request) =>
			buildHeadlessPendingRequestLine("client_tool", request),
		),
		...params.pendingUserInputs.map((request) =>
			buildHeadlessPendingRequestLine("user_input", request),
		),
		...params.pendingToolRetries.map((request) =>
			buildHeadlessPendingRequestLine("tool_retry", request),
		),
	];

	if (pendingRequests.length === 0) {
		return null;
	}

	const visibleRequests = pendingRequests.slice(
		0,
		MAX_HEADLESS_RESTORED_REQUESTS,
	);
	const hiddenCount = pendingRequests.length - visibleRequests.length;

	return [
		"# Pending headless runtime requests restored after compaction",
		"",
		"These requests are still pending with the connected headless runtime. Reuse the existing approval, client-tool, `ask_user`, or tool-retry flow instead of issuing duplicates unless the pending request is cancelled or fails.",
		"",
		...visibleRequests,
		...(hiddenCount > 0 ? [`- (+${hiddenCount} more pending requests)`] : []),
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

function hasHeadlessClientRequestsCompactionMessage(
	messages: AppMessage[],
	expectedContent: string,
): boolean {
	return messages.some(
		(message) =>
			message.role === "hookMessage" &&
			message.customType === HEADLESS_CLIENT_REQUESTS_COMPACTION_CUSTOM_TYPE &&
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

export function collectHeadlessRequestMessagesForCompaction(
	messages: AppMessage[],
	params: {
		pendingApprovals: readonly HeadlessPendingRequestRestoreState[];
		pendingClientTools: readonly HeadlessPendingRequestRestoreState[];
		pendingUserInputs: readonly HeadlessPendingRequestRestoreState[];
		pendingToolRetries: readonly HeadlessPendingRequestRestoreState[];
	},
): AppMessage[] {
	const content = buildHeadlessRuntimeRequestsCompactionContent(params);
	if (
		typeof content !== "string" ||
		hasHeadlessClientRequestsCompactionMessage(messages, content)
	) {
		return [];
	}

	return [
		createHookMessage(
			HEADLESS_CLIENT_REQUESTS_COMPACTION_CUSTOM_TYPE,
			content,
			false,
			undefined,
			new Date().toISOString(),
		),
	];
}
