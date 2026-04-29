import type { SessionEntry } from "./types.js";
import {
	sessionWireContentBlockFieldAliases,
	sessionWireContentBlockTypeAliases,
	sessionWireFieldAliases,
	sessionWireStopReasonAliases,
} from "./wire-format.generated.js";

type AliasMap = Readonly<Record<string, string>>;

function getOwnProperty<T>(
	value: Readonly<Record<string, T>>,
	key: string,
): T | undefined {
	return Object.prototype.hasOwnProperty.call(value, key)
		? value[key]
		: undefined;
}

function renameOwnProperty(
	value: Record<string, unknown>,
	from: string,
	to: string,
): void {
	if (
		!Object.prototype.hasOwnProperty.call(value, from) ||
		Object.prototype.hasOwnProperty.call(value, to)
	) {
		return;
	}
	value[to] = value[from];
	delete value[from];
}

function renameOwnProperties(
	value: Record<string, unknown>,
	aliases: AliasMap | undefined,
): void {
	if (!aliases) return;
	for (const [from, to] of Object.entries(aliases)) {
		renameOwnProperty(value, from, to);
	}
}

function normalizeModelMetadata(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const metadata = value as Record<string, unknown>;
	renameOwnProperties(metadata, sessionWireFieldAliases.modelMetadata);
}

export function normalizeStopReasonValue(value: unknown): unknown {
	if (typeof value !== "string") return value;
	return getOwnProperty(sessionWireStopReasonAliases, value) ?? value;
}

function normalizeMessageContentBlocks(content: unknown): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (typeof record.type === "string") {
			record.type =
				getOwnProperty(sessionWireContentBlockTypeAliases, record.type) ??
				record.type;
		}
		if (typeof record.type !== "string") continue;
		renameOwnProperties(
			record,
			getOwnProperty(sessionWireContentBlockFieldAliases, record.type),
		);
	}
}

function normalizeSessionMessage(message: unknown): void {
	if (!message || typeof message !== "object") return;
	const record = message as Record<string, unknown>;
	if (record.role === "assistant") {
		renameOwnProperties(record, sessionWireFieldAliases.assistantMessage);
		record.stopReason = normalizeStopReasonValue(record.stopReason);
		normalizeMessageContentBlocks(record.content);
		return;
	}
	if (record.role === "toolResult") {
		renameOwnProperties(record, sessionWireFieldAliases.toolResultMessage);
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
			renameOwnProperties(record, sessionWireFieldAliases.session);
			normalizeModelMetadata(record.modelMetadata);
			break;
		case "message":
			normalizeSessionMessage(record.message);
			break;
		case "thinking_level_change":
			renameOwnProperties(record, sessionWireFieldAliases.thinkingLevelChange);
			break;
		case "model_change":
			renameOwnProperties(record, sessionWireFieldAliases.modelChange);
			normalizeModelMetadata(record.modelMetadata);
			break;
		case "compaction":
			renameOwnProperties(record, sessionWireFieldAliases.compaction);
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
