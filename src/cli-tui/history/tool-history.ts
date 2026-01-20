import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ToolResultMessage } from "../../agent/types.js";
import { PATHS } from "../../config/constants.js";

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

	constructor(config: ToolHistoryConfig = {}) {
		this.filePath = config.filePath ?? PATHS.TOOL_HISTORY_FILE;
		this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.previewChars = config.previewChars ?? DEFAULT_PREVIEW_CHARS;
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
		this.persistAll();
	}

	private extractPreview(result: ToolResultMessage): string {
		if (!result || !Array.isArray(result.content)) return "";
		const parts: string[] = [];
		for (const chunk of result.content) {
			if (chunk && typeof chunk === "object") {
				const type = (chunk as { type?: unknown }).type;
				if (
					type === "text" &&
					typeof (chunk as { text?: unknown }).text === "string"
				) {
					parts.push((chunk as { text: string }).text);
				}
			}
		}
		const raw = parts.join("\n").replace(/\s+/g, " ").trim();
		if (raw.length <= this.previewChars) {
			return raw;
		}
		const max = Math.max(0, this.previewChars - 3);
		return `${raw.slice(0, max)}...`;
	}

	private loadFromDisk(): void {
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
		try {
			this.ensureDir();
			appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
		} catch {
			// best-effort persistence
		}
	}

	private persistAll(): void {
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
		if (this.entries.length <= this.maxEntries) return;
		this.entries = this.entries.slice(-this.maxEntries);
		this.persistAll();
	}

	private ensureDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
