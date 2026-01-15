/**
 * Session Migration System
 *
 * Handles background migration of session files to newer formats.
 * Inspired by Conductor's session migration pattern with:
 * - Versioned migrations
 * - Progress tracking
 * - Background batch processing
 * - Persistent state to avoid re-running
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import {
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMigrationState,
	type SessionTreeEntry,
	isSessionTreeEntry,
	tryParseSessionEntry,
} from "./types.js";

const logger = createLogger("session-migration");

const MIGRATION_STATE_FILE = "session-migration-state.json";

let migrationPromise: Promise<SessionMigrationState | null> | null = null;

// Files to skip during migration (e.g., currently active session files)
const skipFiles = new Set<string>();

/**
 * Register a file to be skipped during migration.
 * Used to prevent race conditions with active session writers.
 */
export function registerActiveSessionFile(filePath: string): void {
	skipFiles.add(filePath);
}

/**
 * Unregister a file from the skip list.
 */
export function unregisterActiveSessionFile(filePath: string): void {
	skipFiles.delete(filePath);
}

/**
 * Get the session directory for the current working directory.
 */
function getSessionDirectory(): string {
	const cwd = process.cwd();
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const agentDir = getAgentDir();
	return join(agentDir, "sessions", safePath);
}

function getMigrationStatePath(): string {
	const sessionDir = getSessionDirectory();
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return join(sessionDir, MIGRATION_STATE_FILE);
}

function loadMigrationState(): SessionMigrationState | null {
	const statePath = getMigrationStatePath();
	if (!existsSync(statePath)) {
		return null;
	}
	try {
		const content = readFileSync(statePath, "utf8");
		const state = JSON.parse(content) as SessionMigrationState;
		if (
			state &&
			typeof state === "object" &&
			typeof state.version === "number" &&
			typeof state.lastRun === "string"
		) {
			return state;
		}
	} catch (error) {
		logger.warn("Failed to load migration state", { error });
	}
	return null;
}

function persistMigrationState(state: SessionMigrationState): void {
	try {
		const statePath = getMigrationStatePath();
		writeFileSync(statePath, JSON.stringify(state, null, 2));
	} catch (error) {
		logger.warn("Failed to persist migration state", { error });
	}
}

function readSessionEntries(filePath: string): SessionEntry[] {
	if (!existsSync(filePath)) {
		return [];
	}
	const contents = readFileSync(filePath, "utf8").trim();
	if (!contents) {
		return [];
	}

	const entries: SessionEntry[] = [];
	for (const line of contents.split("\n")) {
		const entry = tryParseSessionEntry(line);
		if (entry) {
			entries.push(entry);
		}
	}
	return entries;
}

function generateEntryId(existing: Set<string>): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	for (let attempt = 0; attempt < 100; attempt++) {
		let id = "";
		for (let i = 0; i < 8; i++) {
			id += chars[Math.floor(Math.random() * chars.length)];
		}
		if (!existing.has(id)) {
			return id;
		}
	}
	// Fallback to timestamp-based ID
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Migrate v1 sessions to v2 format (add tree entry IDs and parentIds)
 */
function migrateV1ToV2(entries: SessionEntry[]): boolean {
	const ids = new Set<string>();
	let prevId: string | null = null;
	let migrated = false;
	// Include message, custom_message, and branch_summary entries to match
	// how firstKeptEntryIndex was computed in v1 sessions
	const messageEntries: SessionTreeEntry[] = [];

	for (const entry of entries) {
		if (entry.type === "session") {
			if ((entry as SessionHeaderEntry).version !== CURRENT_SESSION_VERSION) {
				(entry as SessionHeaderEntry).version = CURRENT_SESSION_VERSION;
				migrated = true;
			}
			continue;
		}
		if (!isSessionTreeEntry(entry)) {
			continue;
		}
		if (!entry.id || ids.has(entry.id)) {
			entry.id = generateEntryId(ids);
			migrated = true;
		}
		ids.add(entry.id);
		if (entry.parentId === undefined) {
			entry.parentId = prevId;
			migrated = true;
		}
		prevId = entry.id;
		// Collect all entry types that contribute to firstKeptEntryIndex
		if (
			entry.type === "message" ||
			entry.type === "custom_message" ||
			entry.type === "branch_summary"
		) {
			messageEntries.push(entry);
		}
	}

	// Second pass: convert compaction entries' firstKeptEntryIndex to firstKeptEntryId
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		const compaction = entry as CompactionEntry & {
			firstKeptEntryIndex?: number;
		};
		if (
			typeof compaction.firstKeptEntryIndex === "number" &&
			!compaction.firstKeptEntryId
		) {
			const target = messageEntries[compaction.firstKeptEntryIndex];
			const fallback = messageEntries[0]?.id ?? compaction.id;
			compaction.firstKeptEntryId = target?.id ?? fallback;
			migrated = true;
		}
		if (compaction.firstKeptEntryIndex !== undefined) {
			delete compaction.firstKeptEntryIndex;
			migrated = true;
		}
	}

	return migrated;
}

/**
 * Migrate entries to the current version, returning true if any changes were made.
 */
function migrateToCurrentVersion(entries: SessionEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as
		| SessionHeaderEntry
		| undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) {
		return false;
	}

	let migrated = false;

	if (version < 2) {
		migrated = migrateV1ToV2(entries) || migrated;
	}

	return migrated;
}

/**
 * Run migration on a single session file.
 * Returns: { migrated: boolean, error?: Error }
 */
function migrateSessionFile(filePath: string): {
	migrated: boolean;
	error?: Error;
} {
	try {
		const entries = readSessionEntries(filePath);
		if (entries.length === 0) {
			return { migrated: false };
		}

		const migrated = migrateToCurrentVersion(entries);
		if (migrated) {
			const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
			writeFileSync(filePath, content);
		}

		return { migrated };
	} catch (error) {
		return {
			migrated: false,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

/**
 * Run session migration across all session files in the directory.
 */
async function runSessionMigrationInternal(): Promise<SessionMigrationState | null> {
	const existing = loadMigrationState();
	if (existing && existing.version >= CURRENT_SESSION_VERSION) {
		return existing;
	}

	const sessionDir = getSessionDirectory();
	if (!existsSync(sessionDir)) {
		// No sessions to migrate
		const state: SessionMigrationState = {
			version: CURRENT_SESSION_VERSION,
			lastRun: new Date().toISOString(),
			successes: 0,
			failures: 0,
			normalized: 0,
			skipped: 0,
			total: 0,
		};
		persistMigrationState(state);
		return state;
	}

	const startedAt = new Date().toISOString();
	let files: string[];
	try {
		files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f));
	} catch (error) {
		logger.warn("Failed to read session directory", { error });
		return null;
	}

	const state: SessionMigrationState = {
		version: CURRENT_SESSION_VERSION,
		lastRun: startedAt,
		successes: 0,
		failures: 0,
		normalized: 0,
		skipped: 0,
		total: files.length,
	};

	// Process in batches to avoid blocking
	const BATCH_SIZE = 10;
	for (let i = 0; i < files.length; i += BATCH_SIZE) {
		const batch = files.slice(i, i + BATCH_SIZE);

		for (const file of batch) {
			// Skip files that are currently active (to prevent race conditions)
			if (skipFiles.has(file)) {
				state.skipped += 1;
				continue;
			}
			const result = migrateSessionFile(file);
			if (result.error) {
				state.failures += 1;
				logger.warn("Session migration failed", {
					file,
					error: result.error.message,
				});
			} else if (result.migrated) {
				state.successes += 1;
				state.normalized += 1;
			} else {
				state.skipped += 1;
			}
		}

		// Yield to event loop between batches
		if (i + BATCH_SIZE < files.length) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	persistMigrationState(state);

	if (state.normalized > 0) {
		logger.info("Session migration completed", {
			total: state.total,
			migrated: state.normalized,
			skipped: state.skipped,
			failures: state.failures,
		});
	}

	return state;
}

/**
 * Schedule session migration to run in the background.
 * Safe to call multiple times - only runs once.
 */
export function scheduleSessionMigration(): void {
	if (migrationPromise) {
		return;
	}
	migrationPromise = runSessionMigrationInternal().catch((error) => {
		logger.warn("Session migration failed", { error });
		return null;
	});
}

/**
 * Run session migration and wait for completion.
 * Returns migration state or null if migration failed.
 */
export async function runSessionMigration(): Promise<SessionMigrationState | null> {
	if (!migrationPromise) {
		migrationPromise = runSessionMigrationInternal().catch((error) => {
			logger.warn("Session migration failed", { error });
			return null;
		});
	}
	return migrationPromise;
}

/**
 * Get the current migration state without running migration.
 */
export function getMigrationState(): SessionMigrationState | null {
	return loadMigrationState();
}

/**
 * Reset migration state to force re-migration on next run.
 * Useful for testing or after manual session file edits.
 */
export function resetMigrationState(): void {
	const statePath = getMigrationStatePath();
	if (existsSync(statePath)) {
		try {
			const resetState: SessionMigrationState = {
				version: 0,
				lastRun: "",
				successes: 0,
				failures: 0,
				normalized: 0,
				skipped: 0,
				total: 0,
			};
			writeFileSync(statePath, JSON.stringify(resetState, null, 2));
		} catch {
			// Ignore errors
		}
	}
	migrationPromise = null;
}
