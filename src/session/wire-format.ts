import type { SessionEntry } from "./types.js";

function renameOwnProperty(
	value: Record<string, unknown>,
	from: string,
	to: string,
): void {
	if (!(from in value) || to in value) return;
	value[to] = value[from];
	delete value[from];
}

function normalizeModelMetadata(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const metadata = value as Record<string, unknown>;
	renameOwnProperty(metadata, "model_id", "modelId");
	renameOwnProperty(metadata, "provider_name", "providerName");
	renameOwnProperty(metadata, "base_url", "baseUrl");
	renameOwnProperty(metadata, "context_window", "contextWindow");
	renameOwnProperty(metadata, "max_tokens", "maxTokens");
}

export function normalizeStopReasonValue(value: unknown): unknown {
	switch (value) {
		case "tool_use":
		case "tool_calls":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			return value;
	}
}

function normalizeMessageContentBlocks(content: unknown): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "tool_call") {
			record.type = "toolCall";
		}
		if (record.type === "toolCall") {
			renameOwnProperty(record, "args", "arguments");
		}
		if (record.type === "thinking") {
			renameOwnProperty(record, "text", "thinking");
			renameOwnProperty(record, "signature", "thinkingSignature");
		}
	}
}

function normalizeSessionMessage(message: unknown): void {
	if (!message || typeof message !== "object") return;
	const record = message as Record<string, unknown>;
	if (record.role === "assistant") {
		renameOwnProperty(record, "stop_reason", "stopReason");
		record.stopReason = normalizeStopReasonValue(record.stopReason);
		normalizeMessageContentBlocks(record.content);
		return;
	}
	if (record.role === "toolResult") {
		renameOwnProperty(record, "tool_call_id", "toolCallId");
		renameOwnProperty(record, "tool_name", "toolName");
		renameOwnProperty(record, "is_error", "isError");
		if (typeof record.content === "string") {
			record.content = [{ type: "text", text: record.content }];
		}
	}
}

export function normalizeSessionEntry(entry: unknown): SessionEntry | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return null;
	}
	const record = entry as Record<string, unknown>;
	if (typeof record.type !== "string") {
		return null;
	}
	switch (record.type) {
		case "session":
			renameOwnProperty(record, "model_metadata", "modelMetadata");
			renameOwnProperty(record, "thinking_level", "thinkingLevel");
			renameOwnProperty(record, "system_prompt", "systemPrompt");
			renameOwnProperty(record, "branched_from", "branchedFrom");
			normalizeModelMetadata(record.modelMetadata);
			break;
		case "message":
			normalizeSessionMessage(record.message);
			break;
		case "thinking_level_change":
			renameOwnProperty(record, "thinking_level", "thinkingLevel");
			break;
		case "model_change":
			renameOwnProperty(record, "model_metadata", "modelMetadata");
			normalizeModelMetadata(record.modelMetadata);
			break;
		case "compaction":
			renameOwnProperty(record, "first_kept_entry_id", "firstKeptEntryId");
			renameOwnProperty(
				record,
				"first_kept_entry_index",
				"firstKeptEntryIndex",
			);
			renameOwnProperty(record, "tokens_before", "tokensBefore");
			renameOwnProperty(record, "custom_instructions", "customInstructions");
			break;
		default:
			break;
	}
	return record as unknown as SessionEntry;
}

export function parseSessionEntry(line: string): SessionEntry {
	const trimmed = line.trim();
	if (!trimmed) {
		throw new Error("Empty session entry");
	}
	const entry = normalizeSessionEntry(JSON.parse(trimmed));
	if (!entry) {
		throw new Error("Invalid session entry");
	}
	return entry;
}

export function tryParseSessionEntry(line: string): SessionEntry | null {
	try {
		return parseSessionEntry(line);
	} catch {
		return null;
	}
}
