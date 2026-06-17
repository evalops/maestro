/**
 * Skill / droid prompt trust cache (#2629 scaffolding).
 *
 * Persists a JSON record of approved prompt SHAs under
 * `~/.maestro/trust/skills.json`. Trust UX (modal, CLI command) layers
 * on top of this storage:
 *
 *   - `isPromptApproved(name, sha)`   — has the user already said yes
 *     to this exact prompt body?
 *   - `recordPromptApproval(name, sha, ...)` — record an explicit
 *     approval (one-time, until the SHA changes).
 *
 * This module is intentionally a thin file-backed store. It does not
 * surface UX, does not block anything on its own, and does not enforce
 * trust. Callers decide what to do with an unapproved prompt.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getComposerHome } from "../config/constants.js";
import { readJsonFile, writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("skills:trust-cache");

const TRUST_FILE_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export interface SkillTrustEntry {
	/** Skill name at the time of approval. Informational; SHA is the key. */
	name: string;
	/** SHA-256 of the trimmed prompt body. */
	contentSha: string;
	/** ISO timestamp of approval. */
	approvedAt: string;
	/**
	 * Source classification at approval time (`project`, `user`,
	 * `system`, `service`). A future approval flow may differ on
	 * "approve once" vs "approve forever" by source.
	 */
	sourceType: "project" | "user" | "system" | "service";
}

interface TrustFile {
	version: number;
	skills: SkillTrustEntry[];
}

function trustFilePath(): string {
	return join(getComposerHome(), "trust", "skills.json");
}

function ensureTrustDir(path: string): void {
	const dir = dirname(path);
	if (existsSync(dir)) {
		return;
	}
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

function loadTrustFile(): TrustFile {
	const path = trustFilePath();
	if (!existsSync(path)) {
		return { version: TRUST_FILE_VERSION, skills: [] };
	}
	let data: unknown;
	try {
		// Rotate-on-parse-fail (#2631): a corrupted trust cache must
		// be preserved as evidence rather than silently overwritten on
		// the next save. Losing approvals to silent corruption would
		// re-show the untrusted-skill banner on legitimate skills
		// without any signal that something went wrong.
		data = readJsonFile<TrustFile>(path, {
			fallback: { version: TRUST_FILE_VERSION, skills: [] },
			rotateOnParseFail: true,
		});
	} catch {
		logger.warn("Failed to load skill trust cache; treating as empty", {
			path,
		});
		return { version: TRUST_FILE_VERSION, skills: [] };
	}
	if (
		typeof data !== "object" ||
		data === null ||
		!Array.isArray((data as TrustFile).skills)
	) {
		logger.warn("Skill trust cache has unexpected shape; treating as empty", {
			path,
		});
		return { version: TRUST_FILE_VERSION, skills: [] };
	}
	return data as TrustFile;
}

function saveTrustFile(file: TrustFile): void {
	const path = trustFilePath();
	ensureTrustDir(path);
	const serialized = `${JSON.stringify(file, null, 2)}\n`;
	writeTextFileAtomic(path, serialized, {
		encoding: "utf-8",
		mode: PRIVATE_FILE_MODE,
	});
}

/**
 * Has the user previously approved this exact skill prompt body?
 *
 * Keying is on `contentSha`. Re-running with the same body returns
 * true; any change to the body changes the SHA and returns false until
 * the user re-approves.
 */
export function isPromptApproved(contentSha: string): boolean {
	if (!contentSha) return false;
	const file = loadTrustFile();
	return file.skills.some((entry) => entry.contentSha === contentSha);
}

/**
 * Record an explicit approval for a skill prompt body. Idempotent — a
 * duplicate `(name, contentSha)` overwrites the prior entry's
 * `approvedAt` rather than appending.
 */
export function recordPromptApproval(entry: {
	name: string;
	contentSha: string;
	sourceType: SkillTrustEntry["sourceType"];
}): void {
	if (!entry.contentSha) return;
	const file = loadTrustFile();
	const without = file.skills.filter(
		(existing) => existing.contentSha !== entry.contentSha,
	);
	without.push({
		name: entry.name,
		contentSha: entry.contentSha,
		sourceType: entry.sourceType,
		approvedAt: new Date().toISOString(),
	});
	saveTrustFile({ version: TRUST_FILE_VERSION, skills: without });
}

/**
 * Forget a single approval (by SHA). Useful for "I no longer trust
 * this prompt version" workflows and for tests.
 */
export function revokePromptApproval(contentSha: string): boolean {
	const file = loadTrustFile();
	const filtered = file.skills.filter(
		(entry) => entry.contentSha !== contentSha,
	);
	if (filtered.length === file.skills.length) {
		return false;
	}
	saveTrustFile({ version: TRUST_FILE_VERSION, skills: filtered });
	return true;
}

/** Test helper — return every entry in the cache. */
export function listApprovedSkillsForTests(): SkillTrustEntry[] {
	return [...loadTrustFile().skills];
}

/** Test helper — wipe the cache on disk. */
export function resetTrustCacheForTests(): void {
	saveTrustFile({ version: TRUST_FILE_VERSION, skills: [] });
}
