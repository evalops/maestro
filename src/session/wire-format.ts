import type { SessionEntry } from "./types.js";
import {
	canonicalSessionWireContentBlockType,
	canonicalSessionWireStopReason,
	getSessionWireContentBlockFieldAliases,
	isSessionWireCompactionContextEntryType,
	isSessionWireCompactionExcludedMessageRole,
	sessionWireFieldAliases,
} from "./wire-format.generated.js";

type AliasMap = Readonly<Record<string, string>>;

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
	return canonicalSessionWireStopReason(value);
}

function normalizeMessageContentBlocks(content: unknown): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (typeof record.type === "string") {
			record.type = canonicalSessionWireContentBlockType(record.type);
		}
		if (typeof record.type !== "string") continue;
		renameOwnProperties(
			record,
			getSessionWireContentBlockFieldAliases(record.type),
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
		case "session_meta":
			renameOwnProperties(record, sessionWireFieldAliases.sessionMeta);
			break;
		case "attachment_extract":
			renameOwnProperties(record, sessionWireFieldAliases.attachmentExtract);
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
		case "branch_summary":
			renameOwnProperties(record, sessionWireFieldAliases.branchSummary);
			break;
		case "custom":
			renameOwnProperties(record, sessionWireFieldAliases.custom);
			break;
		case "custom_message":
			renameOwnProperties(record, sessionWireFieldAliases.customMessage);
			normalizeMessageContentBlocks(record.content);
			break;
		case "label":
			renameOwnProperties(record, sessionWireFieldAliases.label);
			break;
		default:
			break;
	}
	return record as unknown as SessionEntry;
}

export function isSessionWireCompactionContextEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return false;
	}
	const record = entry as Record<string, unknown>;
	if (record.type === "message") {
		const message = record.message;
		if (message && typeof message === "object" && !Array.isArray(message)) {
			const role = (message as Record<string, unknown>).role;
			return (
				typeof role !== "string" ||
				!isSessionWireCompactionExcludedMessageRole(role)
			);
		}
	}
	return (
		typeof record.type === "string" &&
		isSessionWireCompactionContextEntryType(record.type)
	);
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
