import type { AgentTool } from "../agent/types.js";

type ToolPresentationProvider = Pick<
	AgentTool,
	"label" | "getActivityDescription" | "getDisplayName" | "getToolUseSummary"
>;

function getStringArg(
	args: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
		if (Array.isArray(value)) {
			const first = value.find(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			);
			if (first) {
				return first.trim();
			}
		}
	}
	return undefined;
}

function truncateLabel(value: string, max = 48): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function quoteLabel(value: string, max = 32): string {
	return `"${truncateLabel(value, max)}"`;
}

function shortUrlLabel(raw: string): string {
	try {
		const parsed = new URL(raw);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return truncateLabel(`${parsed.hostname}${path}`, 40);
	} catch {
		return truncateLabel(raw, 40);
	}
}

function shortPathLabel(raw: string): string {
	const normalized = raw.trim().replace(/\\/g, "/");
	if (!normalized) return "file";
	if (/^[a-z]+:\/\//i.test(normalized)) {
		return shortUrlLabel(normalized);
	}
	if (normalized === "." || normalized === "..") {
		return normalized;
	}
	const isDirectory = normalized.endsWith("/");
	const trimmed = normalized.replace(/\/+$/, "");
	const parts = trimmed.split("/").filter(Boolean);
	if (parts.length === 0) {
		return normalized;
	}
	const leaf = parts[parts.length - 1] ?? normalized;
	return `${truncateLabel(leaf, 32)}${isDirectory ? "/" : ""}`;
}

function humanizeToolName(toolName: string): string {
	const trimmed = toolName.trim();
	if (!trimmed) return "tool";
	const mcpParts = trimmed.split("__").filter(Boolean);
	if (trimmed.startsWith("mcp__") && mcpParts.length >= 3) {
		return mcpParts
			.slice(2)
			.join(" ")
			.replace(/[._-]+/g, " ");
	}
	return trimmed.replace(/[._-]+/g, " ");
}

function sentenceCase(value: string): string {
	if (!value) return value;
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function uniqueLabels(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildBatchLabel(labels: string[], max = 64): string {
	if (labels.length === 0) {
		return "Completed tool batch";
	}
	if (labels.length === 1) {
		return labels[0]!;
	}

	let summary = labels[0]!;
	for (let index = 1; index < labels.length; index += 1) {
		const nextLabel = labels[index]!;
		const remaining = labels.length - index - 1;
		const candidate = `${summary}, ${nextLabel}`;
		if (remaining === 0 && candidate.length <= max) {
			return candidate;
		}
		if (remaining > 0) {
			const overflowLabel = `${candidate} +${remaining} more`;
			if (overflowLabel.length <= max) {
				summary = candidate;
				continue;
			}
			return `${summary} +${labels.length - index} more`;
		}
		return `${summary} +1 more`;
	}

	return summary;
}

function summarizeKnownTool(
	toolName: string,
	args: Record<string, unknown>,
): string | null {
	const normalized = toolName.trim().toLowerCase();
	const filePath = getStringArg(args, [
		"file_path",
		"filePath",
		"path",
		"target_path",
		"targetPath",
		"filename",
	]);
	const directory = getStringArg(args, ["directory", "dir", "cwd"]);
	const pattern = getStringArg(args, ["pattern", "query", "search", "regex"]);
	const command = getStringArg(args, ["command", "cmd", "script"]);
	const url = getStringArg(args, ["url", "uri"]);

	switch (normalized) {
		case "read":
			return `Read ${shortPathLabel(filePath ?? "file")}`;
		case "write":
		case "append":
		case "create_file":
		case "createfile":
			return `Wrote ${shortPathLabel(filePath ?? "file")}`;
		case "edit":
		case "multi_edit":
		case "str_replace_based_edit":
		case "apply_patch":
			return `Edited ${shortPathLabel(filePath ?? "file")}`;
		case "delete":
		case "remove":
		case "unlink":
			return `Deleted ${shortPathLabel(filePath ?? "file")}`;
		case "list":
		case "ls":
			return `Listed ${shortPathLabel(directory ?? filePath ?? "directory")}`;
		case "glob":
			return pattern
				? `Matched ${quoteLabel(pattern)}`
				: `Scanned ${shortPathLabel(directory ?? "workspace")}`;
		case "grep":
		case "search":
		case "search_files":
			return pattern ? `Searched for ${quoteLabel(pattern)}` : "Searched files";
		case "bash":
		case "shell":
		case "exec_command":
			return command ? `Ran ${truncateLabel(command, 52)}` : "Ran command";
		case "webfetch":
		case "fetch":
		case "open":
			return `Fetched ${shortUrlLabel(url ?? filePath ?? "resource")}`;
		case "websearch":
		case "search_query":
			return pattern
				? `Searched web for ${quoteLabel(pattern)}`
				: "Searched web";
		case "todo":
			return "Updated task list";
		case "batch": {
			const calls =
				(Array.isArray(args.tool_uses) ? args.tool_uses.length : 0) ||
				(Array.isArray(args.calls) ? args.calls.length : 0);
			if (calls > 0) {
				return `Ran ${calls} tool call${calls === 1 ? "" : "s"}`;
			}
			return "Ran tool batch";
		}
		case "background_tasks": {
			const action = getStringArg(args, ["action"]);
			if (action === "start") return "Started background task";
			if (action === "stop") return "Stopped background task";
			if (action === "logs") return "Viewed background logs";
			if (action === "list") return "Listed background tasks";
			return "Checked background tasks";
		}
		default:
			return null;
	}
}

function describeKnownToolActivity(
	toolName: string,
	args: Record<string, unknown>,
): string | null {
	const normalized = toolName.trim().toLowerCase();
	const filePath = getStringArg(args, [
		"file_path",
		"filePath",
		"path",
		"target_path",
		"targetPath",
		"filename",
	]);
	const directory = getStringArg(args, ["directory", "dir", "cwd"]);
	const pattern = getStringArg(args, ["pattern", "query", "search", "regex"]);
	const command = getStringArg(args, ["command", "cmd", "script"]);
	const url = getStringArg(args, ["url", "uri"]);

	switch (normalized) {
		case "read":
			return `Reading ${shortPathLabel(filePath ?? "file")}`;
		case "write":
		case "append":
		case "create_file":
		case "createfile":
			return `Writing ${shortPathLabel(filePath ?? "file")}`;
		case "edit":
		case "multi_edit":
		case "str_replace_based_edit":
		case "apply_patch":
			return `Editing ${shortPathLabel(filePath ?? "file")}`;
		case "delete":
		case "remove":
		case "unlink":
			return `Deleting ${shortPathLabel(filePath ?? "file")}`;
		case "list":
		case "ls":
			return `Listing ${shortPathLabel(directory ?? filePath ?? "directory")}`;
		case "glob":
			return pattern
				? `Matching ${quoteLabel(pattern)}`
				: `Scanning ${shortPathLabel(directory ?? "workspace")}`;
		case "grep":
		case "search":
		case "search_files":
			return pattern
				? `Searching for ${quoteLabel(pattern)}`
				: "Searching files";
		case "bash":
		case "shell":
		case "exec_command":
			return command
				? `Running ${truncateLabel(command, 52)}`
				: "Running command";
		case "webfetch":
		case "fetch":
		case "open":
			return `Fetching ${shortUrlLabel(url ?? filePath ?? "resource")}`;
		case "websearch":
		case "search_query":
			return pattern
				? `Searching web for ${quoteLabel(pattern)}`
				: "Searching web";
		case "todo":
			return "Updating task list";
		case "background_tasks": {
			const action = getStringArg(args, ["action"]);
			if (action === "start") return "Starting background task";
			if (action === "stop") return "Stopping background task";
			if (action === "logs") return "Reading background logs";
			if (action === "list") return "Listing background tasks";
			return "Checking background tasks";
		}
		default:
			return null;
	}
}

function summarizeWithToolDefinition(
	tool: ToolPresentationProvider | undefined,
	args: Record<string, unknown>,
): string | null {
	const summary = tool?.getToolUseSummary?.(args)?.trim();
	return summary ? sentenceCase(truncateLabel(summary, 64)) : null;
}

function describeWithToolDefinition(
	tool: ToolPresentationProvider | undefined,
	args: Record<string, unknown>,
): string | null {
	const activity = tool?.getActivityDescription?.(args)?.trim();
	return activity ? sentenceCase(truncateLabel(activity, 64)) : null;
}

function displayWithToolDefinition(
	tool: ToolPresentationProvider | undefined,
	args: Record<string, unknown>,
): string | null {
	const displayName = tool?.getDisplayName?.(args)?.trim();
	return displayName ? sentenceCase(truncateLabel(displayName, 64)) : null;
}

export function describeToolDisplayName(
	toolName: string,
	args: Record<string, unknown> = {},
	tool?: ToolPresentationProvider,
): string {
	const toolDisplayName = displayWithToolDefinition(tool, args);
	if (toolDisplayName) {
		return toolDisplayName;
	}
	const label = tool?.label?.trim();
	if (label) {
		return sentenceCase(label);
	}
	return sentenceCase(humanizeToolName(toolName));
}

export function summarizeToolUse(
	toolName: string,
	args: Record<string, unknown> = {},
	tool?: ToolPresentationProvider,
): string {
	const toolSummary = summarizeWithToolDefinition(tool, args);
	if (toolSummary) {
		return toolSummary;
	}
	const known = summarizeKnownTool(toolName, args);
	if (known) {
		return sentenceCase(known);
	}
	return sentenceCase(`Ran ${truncateLabel(humanizeToolName(toolName), 40)}`);
}

export function describeToolActivity(
	toolName: string,
	args: Record<string, unknown> = {},
	tool?: ToolPresentationProvider,
): string {
	const toolActivity = describeWithToolDefinition(tool, args);
	if (toolActivity) {
		return toolActivity;
	}
	const known = describeKnownToolActivity(toolName, args);
	if (known) {
		return sentenceCase(known);
	}
	return summarizeToolUse(toolName, args, tool);
}

export interface ToolBatchSummaryEntry {
	toolName: string;
	args?: Record<string, unknown>;
	isError?: boolean;
	tool?: ToolPresentationProvider;
}

export interface ToolBatchSummary {
	summary: string;
	summaryLabels: string[];
	callsSucceeded: number;
	callsFailed: number;
}

export function summarizeToolBatch(
	entries: ToolBatchSummaryEntry[],
): ToolBatchSummary {
	const summaryLabels = uniqueLabels(
		entries.map((entry) =>
			summarizeToolUse(entry.toolName, entry.args ?? {}, entry.tool),
		),
	);
	return {
		summary: buildBatchLabel(summaryLabels),
		summaryLabels,
		callsSucceeded: entries.filter((entry) => !entry.isError).length,
		callsFailed: entries.filter((entry) => entry.isError).length,
	};
}
