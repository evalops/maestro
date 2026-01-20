import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../../config/constants.js";

export interface PromptHistoryEntry {
	prompt: string;
	timestamp: number;
}

export interface PromptHistoryConfig {
	filePath?: string;
	maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class PromptHistoryStore {
	private entries: PromptHistoryEntry[] = [];
	private readonly filePath: string;
	private readonly maxEntries: number;

	constructor(config: PromptHistoryConfig = {}) {
		this.filePath = config.filePath ?? PATHS.PROMPT_HISTORY_FILE;
		this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.loadFromDisk();
	}

	add(prompt: string): void {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		const last = this.entries.at(-1);
		if (last && last.prompt === trimmed) {
			return;
		}
		const entry: PromptHistoryEntry = {
			prompt: trimmed,
			timestamp: Date.now(),
		};
		this.entries.push(entry);
		this.appendEntry(entry);
		this.trimIfNeeded();
	}

	recent(count: number): PromptHistoryEntry[] {
		if (count <= 0) return [];
		return this.entries.slice(-count).reverse();
	}

	search(query: string, limit = 20): PromptHistoryEntry[] {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) return [];
		const matches: PromptHistoryEntry[] = [];
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (!entry) continue;
			if (entry.prompt.toLowerCase().includes(trimmed)) {
				matches.push(entry);
				if (matches.length >= limit) break;
			}
		}
		return matches;
	}

	clear(): void {
		this.entries = [];
		this.persistAll();
	}

	private loadFromDisk(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const lines = raw.split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as {
						prompt?: string;
						timestamp?: number;
					};
					if (typeof parsed.prompt === "string") {
						this.entries.push({
							prompt: parsed.prompt,
							timestamp:
								typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
						});
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

	private appendEntry(entry: PromptHistoryEntry): void {
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
