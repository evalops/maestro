// @ts-ignore - type-only import from ESM module is safe in CJS context
import type * as Contracts from "@evalops/contracts";
import type { Message } from "./api-client.js";

export type SummaryToolCall = Contracts.ComposerToolCall & {
	summaryLabel?: string;
};

export type SummaryMessage = Message & {
	tools?: SummaryToolCall[];
};

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

export function summarizeVscodeToolCall(
	toolName: string,
	args: Record<string, unknown> = {},
): string {
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
		default:
			return sentenceCase(
				`Ran ${truncateLabel(humanizeToolName(toolName), 40)}`,
			);
	}
}

export function withToolSummaryLabels(message: Message): SummaryMessage {
	if (!message.tools?.length) {
		return message;
	}
	return {
		...message,
		tools: message.tools.map((tool) => ({
			...tool,
			summaryLabel:
				(tool as SummaryToolCall).summaryLabel ??
				summarizeVscodeToolCall(tool.name, tool.args ?? {}),
		})),
	};
}
