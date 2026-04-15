import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../../config/constants.js";
import {
	type HistoryPersistence,
	resolveHistorySettings,
} from "./history-config.js";

export interface PromptHistoryEntry {
	prompt: string;
	timestamp: number;
}

export interface PromptHistoryConfig {
	filePath?: string;
	maxEntries?: number;
	maxBytes?: number;
	persistence?: HistoryPersistence;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class PromptHistoryStore {
	private entries: PromptHistoryEntry[] = [];
	private readonly filePath: string;
	private readonly maxEntries: number;
	private readonly maxBytes?: number;
	private readonly persistence: HistoryPersistence;

	constructor(config: PromptHistoryConfig = {}) {
		const settings = resolveHistorySettings();
		this.filePath = config.filePath ?? PATHS.PROMPT_HISTORY_FILE;
		this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.maxBytes = config.maxBytes ?? settings.maxBytes;
		this.persistence = config.persistence ?? settings.persistence;
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
		if (this.shouldPersist()) {
			this.persistAll();
		} else {
			this.deletePersistedFile();
		}
	}

	private loadFromDisk(): void {
		if (!this.shouldPersist()) return;
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
		entries: PromptHistoryEntry[],
		maxBytes: number,
	): PromptHistoryEntry[] {
		if (entries.length === 0) return entries;
		let total = 0;
		const selected: PromptHistoryEntry[] = [];
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

	private entryByteSize(entry: PromptHistoryEntry): number {
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
