import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ToolResultMessage } from "../../agent/types.js";
import { PATHS } from "../../config/constants.js";
import {
	type HistoryPersistence,
	resolveHistorySettings,
} from "./history-config.js";

export interface ToolHistoryEntry {
	tool: string;
	timestamp: number;
	durationMs?: number;
	isError?: boolean;
	preview?: string;
}

export interface ToolHistoryConfig {
	filePath?: string;
	maxEntries?: number;
	previewChars?: number;
	maxBytes?: number;
	persistence?: HistoryPersistence;
}

interface InFlightToolCall {
	tool: string;
	startedAt: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_PREVIEW_CHARS = 120;

export class ToolHistoryStore {
	private entries: ToolHistoryEntry[] = [];
	private readonly inflight = new Map<string, InFlightToolCall>();
	private readonly filePath: string;
	private readonly maxEntries: number;
	private readonly previewChars: number;
	private readonly maxBytes?: number;
	private readonly persistence: HistoryPersistence;

	constructor(config: ToolHistoryConfig = {}) {
		const settings = resolveHistorySettings();
		this.filePath = config.filePath ?? PATHS.TOOL_HISTORY_FILE;
		this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.previewChars = config.previewChars ?? DEFAULT_PREVIEW_CHARS;
		this.maxBytes = config.maxBytes ?? settings.maxBytes;
		this.persistence = config.persistence ?? settings.persistence;
		this.loadFromDisk();
	}

	recordStart(toolCallId: string, toolName: string): void {
		if (!toolCallId || !toolName) return;
		this.inflight.set(toolCallId, { tool: toolName, startedAt: Date.now() });
	}

	recordEnd(
		toolCallId: string,
		toolName: string,
		result: ToolResultMessage,
		isError: boolean,
	): void {
		const started = this.inflight.get(toolCallId);
		if (started) {
			this.inflight.delete(toolCallId);
		}
		const durationMs = started ? Date.now() - started.startedAt : undefined;
		const entry: ToolHistoryEntry = {
			tool: toolName,
			timestamp: Date.now(),
			durationMs,
			isError,
			preview: this.extractPreview(result),
		};
		this.entries.push(entry);
		this.appendEntry(entry);
		this.trimIfNeeded();
	}

	recent(count: number): ToolHistoryEntry[] {
		if (count <= 0) return [];
		return this.entries.slice(-count).reverse();
	}

	forTool(name: string, limit = 10): ToolHistoryEntry[] {
		const normalized = name.trim().toLowerCase();
		if (!normalized) return [];
		const matches: ToolHistoryEntry[] = [];
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (!entry) continue;
			if (entry.tool.toLowerCase() === normalized) {
				matches.push(entry);
				if (matches.length >= limit) break;
			}
		}
		return matches;
	}

	stats(): {
		total: number;
		byTool: Map<string, { total: number; errors: number }>;
	} {
		const byTool = new Map<string, { total: number; errors: number }>();
		for (const entry of this.entries) {
			const key = entry.tool;
			const bucket = byTool.get(key) ?? { total: 0, errors: 0 };
			bucket.total += 1;
			if (entry.isError) bucket.errors += 1;
			byTool.set(key, bucket);
		}
		return { total: this.entries.length, byTool };
	}

	clear(): void {
		this.entries = [];
		this.inflight.clear();
		if (this.shouldPersist()) {
			this.persistAll();
		} else {
			this.deletePersistedFile();
		}
	}

	private extractPreview(result: ToolResultMessage): string {
		if (!result || !Array.isArray(result.content)) return "";
		const limit = this.previewChars;
		if (limit <= 0) return "";
		const rawParts: string[] = [];
		let collected = 0;
		let truncated = false;

		for (const chunk of result.content) {
			if (!chunk || typeof chunk !== "object") continue;
			const type = (chunk as { type?: unknown }).type;
			if (type !== "text") continue;
			const text = (chunk as { text?: unknown }).text;
			if (typeof text !== "string" || text.length === 0) continue;
			const remaining = limit + 1 - collected;
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			if (text.length > remaining) {
				rawParts.push(text.slice(0, remaining));
				collected += remaining;
				truncated = true;
				break;
			}
			rawParts.push(text);
			collected += text.length;
		}

		const normalized = rawParts.join("\n").replace(/\s+/g, " ").trim();
		if (!normalized) {
			return "";
		}
		const shouldTruncate = truncated || normalized.length > limit;
		if (!shouldTruncate) {
			return normalized;
		}
		const max = Math.max(0, limit - 3);
		return `${normalized.slice(0, max)}...`;
	}

	private loadFromDisk(): void {
		if (!this.shouldPersist()) return;
		if (!existsSync(this.filePath)) return;
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const lines = raw.split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as ToolHistoryEntry;
					if (parsed && typeof parsed.tool === "string") {
						this.entries.push(parsed);
					}
				} catch {
					// ignore malformed lines
				}
			}
			this.trimIfNeeded();
		} catch {
			// ignore load errors
		}
	}

	private appendEntry(entry: ToolHistoryEntry): void {
		if (!this.shouldPersist()) return;
		try {
			this.ensureDir();
			appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
		} catch {
			// best-effort persistence
		}
	}

	private persistAll(): void {
		if (!this.shouldPersist()) return;
		try {
			this.ensureDir();
			if (this.entries.length === 0) {
				writeFileSync(this.filePath, "", "utf-8");
				return;
			}
			const lines = this.entries.map((entry) => JSON.stringify(entry));
			writeFileSync(this.filePath, `${lines.join("\n")}\n`, "utf-8");
		} catch {
			// best-effort persistence
		}
	}

	private trimIfNeeded(): void {
		let trimmed = false;
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
			trimmed = true;
		}
		if (this.maxBytes !== undefined && this.maxBytes > 0) {
			const limited = this.trimToMaxBytes(this.entries, this.maxBytes);
			if (limited.length !== this.entries.length) {
				this.entries = limited;
				trimmed = true;
			}
		}
		if (trimmed && this.shouldPersist()) {
			this.persistAll();
		}
	}

	private trimToMaxBytes(
		entries: ToolHistoryEntry[],
		maxBytes: number,
	): ToolHistoryEntry[] {
		if (entries.length === 0) return entries;
		let total = 0;
		const selected: ToolHistoryEntry[] = [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!entry) continue;
			const size = this.entryByteSize(entry);
			if (size > maxBytes) {
				continue;
			}
			if (total + size > maxBytes) {
				break;
			}
			selected.push(entry);
			total += size;
		}
		const reversed = selected.reverse();
		if (reversed.length === 0 && entries.length > 0) {
			const last = entries[entries.length - 1];
			return last ? [last] : reversed;
		}
		return reversed;
	}

	private entryByteSize(entry: ToolHistoryEntry): number {
		return Buffer.byteLength(JSON.stringify(entry)) + 1;
	}

	private shouldPersist(): boolean {
		return this.persistence !== "none";
	}

	private deletePersistedFile(): void {
		try {
			if (existsSync(this.filePath)) {
				rmSync(this.filePath, { force: true });
			}
		} catch {
			// best-effort cleanup
		}
	}

	private ensureDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
