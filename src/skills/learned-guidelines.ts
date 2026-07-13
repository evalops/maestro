/**
 * Learned guidelines for skills
 *
 * A skill can accumulate durable, plain-text guidance across runs — for
 * example, incident-triage learning which tools and interfaces a given alert
 * type needs. Learnings are stored as markdown at
 * `<userSkillsDir>/<skill>/guidelines.md` (default `~/.maestro/skills`), so a
 * later run of the same skill can load what earlier runs discovered.
 *
 * The file is markdown, not settings, and every function takes the skills root
 * as a parameter (defaulting to the sanctioned PATHS.MAESTRO_HOME), so this
 * module reads no environment directly and writes atomically.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { PATHS } from "../config/constants.js";
import { isProcessAlive } from "../tools/process-tree.js";
import { writeTextFileAtomic } from "../utils/fs.js";

const GUIDELINES_FILENAME = "guidelines.md";
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GUIDELINES_LOCK_RETRY_MS = 25;
const GUIDELINES_LOCK_STALE_MS = 30_000;
const GUIDELINES_LOCK_TIMEOUT_MS =
	GUIDELINES_LOCK_STALE_MS + GUIDELINES_LOCK_RETRY_MS;
const GUIDELINES_LOCK_OWNER_FILE = "owner.json";
const MAX_GUIDELINES_BYTES = 64 * 1024;
const GUIDELINE_ENTRY_SEPARATOR = "\n\n---\n\n";
const GUIDELINE_ENTRY_MARKER = "<!-- maestro-learned-guideline-entry -->";
const GUIDELINE_ENTRY_JSON_MARKER =
	"<!-- maestro-learned-guideline-entry-json -->";
const GUIDELINE_TRUNCATION_NOTICE =
	"\n\n[learned guideline truncated to fit byte cap]";
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

interface GuidelinesLockOwner {
	pid: number;
	token: string;
	createdAt: string;
}

/** Default per-user skills root (`~/.maestro/skills`). */
export function defaultUserSkillsDir(): string {
	return join(PATHS.MAESTRO_HOME, "skills");
}

function validateSkillName(skillName: string): string {
	if (!SKILL_NAME_PATTERN.test(skillName)) {
		throw new Error(`Invalid skill name for learned guidelines: ${skillName}`);
	}
	return skillName;
}

/** Absolute path to a skill's learned-guidelines file. */
export function getLearnedGuidelinesPath(
	skillName: string,
	userSkillsDir: string = defaultUserSkillsDir(),
): string {
	return join(
		resolveSkillDirectory(skillName, userSkillsDir),
		GUIDELINES_FILENAME,
	);
}

/**
 * Load a skill's learned guidelines, or null when none have been recorded.
 */
export function loadLearnedGuidelines(
	skillName: string,
	userSkillsDir: string = defaultUserSkillsDir(),
): string | null {
	const content = formatGuidelineEntries(
		loadDisplayGuidelineEntries(skillName, userSkillsDir, MAX_GUIDELINES_BYTES),
	);
	return content.length > 0 ? content : null;
}

/**
 * Render a skill's learned guidelines as a prompt-ready block, or null when
 * there are none. Suitable for injection alongside the skill's own content.
 */
export function formatLearnedGuidelinesForPrompt(
	skillName: string,
	userSkillsDir: string = defaultUserSkillsDir(),
): string | null {
	const promptPrefix = learnedGuidelinesPromptPrefix(skillName);
	const content = formatGuidelineEntries(
		loadDisplayGuidelineEntries(
			skillName,
			userSkillsDir,
			MAX_GUIDELINES_BYTES - byteLength(promptPrefix),
		),
	);
	if (!content) {
		return null;
	}
	return `${promptPrefix}${content}`;
}

/**
 * Append a learned-guideline entry to a skill's guidelines file, creating it on
 * first use. Entries are separated by a horizontal rule so the file stays a
 * readable, append-only log.
 */
export function appendLearnedGuideline(
	skillName: string,
	entry: string,
	userSkillsDir: string = defaultUserSkillsDir(),
): string {
	const trimmed = entry.trim();
	if (trimmed.length === 0) {
		throw new Error("appendLearnedGuideline requires a non-empty entry");
	}
	const path = getLearnedGuidelinesPath(skillName, userSkillsDir);
	return withLearnedGuidelinesLock(path, () => {
		const existing = existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
		const next = buildGuidelinesContent(existing, trimmed);
		writeTextFileAtomic(path, next, { createDirs: true });
		return path;
	});
}

function buildGuidelinesContent(existing: string, entry: string): string {
	const entries = parseGuidelineEntries(existing);
	if (byteLength(serializeGuidelineEntries([entry])) > MAX_GUIDELINES_BYTES) {
		throw new Error(
			`learned guideline entry exceeds ${MAX_GUIDELINES_BYTES} bytes`,
		);
	}
	entries.push(entry);
	return formatGuidelinesContent(pruneGuidelineEntries(entries));
}

function loadDisplayGuidelineEntries(
	skillName: string,
	userSkillsDir: string,
	maxBytes: number,
): string[] {
	const path = getLearnedGuidelinesPath(skillName, userSkillsDir);
	if (!existsSync(path)) {
		return [];
	}
	return fitGuidelineEntriesForDisplay(
		parseGuidelineEntries(readFileSync(path, "utf-8")),
		maxBytes,
	);
}

function pruneGuidelineEntries(entries: string[]): string[] {
	while (
		entries.length > 0 &&
		byteLength(serializeGuidelineEntries(entries)) > MAX_GUIDELINES_BYTES
	) {
		entries.shift();
	}
	return entries;
}

function formatGuidelinesContent(entries: string[]): string {
	const content = serializeGuidelineEntries(entries);
	return content.length > 0 ? `${content}\n` : "";
}

function formatGuidelineEntries(entries: string[]): string {
	return normalizeGuidelineEntries(entries).join(GUIDELINE_ENTRY_SEPARATOR);
}

function parseGuidelineEntries(content: string): string[] {
	const trimmed = content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (trimmed.length === 0) {
		return [];
	}
	if (trimmed.startsWith(GUIDELINE_ENTRY_JSON_MARKER)) {
		return parseJsonGuidelineEntries(trimmed);
	}
	if (!trimmed.startsWith(GUIDELINE_ENTRY_MARKER)) {
		return normalizeGuidelineEntries(trimmed.split(GUIDELINE_ENTRY_SEPARATOR));
	}
	const markerLine = `${GUIDELINE_ENTRY_MARKER}\n`;
	return normalizeGuidelineEntries(
		trimmed
			.slice(markerLine.length)
			.split(`${GUIDELINE_ENTRY_SEPARATOR}${markerLine}`),
	);
}

function parseJsonGuidelineEntries(content: string): string[] {
	const markerLine = `${GUIDELINE_ENTRY_JSON_MARKER}\n`;
	return normalizeGuidelineEntries(
		content
			.slice(markerLine.length)
			.split(`${GUIDELINE_ENTRY_SEPARATOR}${markerLine}`)
			.map((entry) => {
				try {
					const parsed = JSON.parse(entry) as unknown;
					return typeof parsed === "string" ? parsed : "";
				} catch {
					return "";
				}
			}),
	);
}

function serializeGuidelineEntries(entries: string[]): string {
	return normalizeGuidelineEntries(entries)
		.map((entry) => `${GUIDELINE_ENTRY_JSON_MARKER}\n${JSON.stringify(entry)}`)
		.join(GUIDELINE_ENTRY_SEPARATOR);
}

function normalizeGuidelineEntries(entries: string[]): string[] {
	return entries.map((entry) => entry.trim()).filter(Boolean);
}

function fitGuidelineEntriesForDisplay(
	entries: string[],
	maxBytes: number,
): string[] {
	const fitted = normalizeGuidelineEntries(entries);
	while (
		fitted.length > 0 &&
		byteLength(formatGuidelineEntries(fitted)) > maxBytes
	) {
		if (fitted.length === 1) {
			const truncated = truncateEntryToBytes(fitted[0] ?? "", maxBytes);
			return truncated ? [truncated] : [];
		}
		fitted.shift();
	}
	return fitted;
}

function truncateEntryToBytes(entry: string, maxBytes: number): string {
	if (maxBytes <= byteLength(GUIDELINE_TRUNCATION_NOTICE)) {
		return "";
	}
	let truncated = "";
	for (const char of Array.from(entry)) {
		const next = `${truncated}${char}`;
		if (byteLength(`${next}${GUIDELINE_TRUNCATION_NOTICE}`) > maxBytes) {
			break;
		}
		truncated = next;
	}
	return `${truncated}${GUIDELINE_TRUNCATION_NOTICE}`.trim();
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf-8");
}

function learnedGuidelinesPromptPrefix(skillName: string): string {
	return `# Learned guidelines (${skillName})\n\nAccumulated from earlier runs of this skill. Treat as priors to verify, not as ground truth.\n\n`;
}

function resolveSkillDirectory(
	skillName: string,
	userSkillsDir: string,
): string {
	const validatedSkillName = validateSkillName(skillName);
	const skillDirectory = resolve(userSkillsDir, validatedSkillName);
	if (!isPathWithinDirectory(skillDirectory, userSkillsDir)) {
		throw new Error(`Invalid skill name for learned guidelines: ${skillName}`);
	}
	return skillDirectory;
}

function isPathWithinDirectory(
	candidatePath: string,
	directoryPath: string,
): boolean {
	const normalizedDir = `${resolve(directoryPath)}${sep}`;
	const normalizedCandidate = resolve(candidatePath);
	return normalizedCandidate.startsWith(normalizedDir);
}

function withLearnedGuidelinesLock<T>(path: string, operation: () => T): T {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const ownerToken = randomUUID();
	const startedAt = Date.now();
	while (true) {
		try {
			mkdirSync(lockPath);
			writeGuidelinesLockOwner(lockPath, ownerToken);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (recoverStaleGuidelinesLock(lockPath)) continue;
			if (Date.now() - startedAt > GUIDELINES_LOCK_TIMEOUT_MS) {
				throw new Error(
					`timed out waiting for learned guidelines lock: ${path}`,
				);
			}
			sleepSync(GUIDELINES_LOCK_RETRY_MS);
		}
	}
	try {
		return operation();
	} finally {
		releaseGuidelinesLock(lockPath, ownerToken);
	}
}

function writeGuidelinesLockOwner(lockPath: string, ownerToken: string): void {
	const owner: GuidelinesLockOwner = {
		pid: process.pid,
		token: ownerToken,
		createdAt: new Date().toISOString(),
	};
	try {
		writeTextFileAtomic(
			join(lockPath, GUIDELINES_LOCK_OWNER_FILE),
			`${JSON.stringify(owner)}\n`,
			{ createDirs: true },
		);
	} catch (error) {
		rmSync(lockPath, { recursive: true, force: true });
		throw error;
	}
}

function releaseGuidelinesLock(lockPath: string, ownerToken: string): void {
	const owner = readGuidelinesLockOwner(lockPath);
	if (owner?.token === ownerToken) {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function recoverStaleGuidelinesLock(lockPath: string): boolean {
	try {
		const stats = statSync(lockPath);
		if (Date.now() - stats.mtimeMs <= GUIDELINES_LOCK_STALE_MS) {
			return false;
		}
		const owner = readGuidelinesLockOwner(lockPath);
		if (typeof owner?.pid === "number" && isProcessAlive(owner.pid)) {
			return false;
		}
		rmSync(lockPath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function readGuidelinesLockOwner(lockPath: string): GuidelinesLockOwner | null {
	try {
		const raw = readFileSync(
			join(lockPath, GUIDELINES_LOCK_OWNER_FILE),
			"utf-8",
		);
		const parsed = JSON.parse(raw) as Partial<GuidelinesLockOwner>;
		if (
			typeof parsed.pid === "number" &&
			typeof parsed.token === "string" &&
			typeof parsed.createdAt === "string"
		) {
			return {
				pid: parsed.pid,
				token: parsed.token,
				createdAt: parsed.createdAt,
			};
		}
	} catch {
		// Missing or malformed ownership metadata is treated as unowned.
	}
	return null;
}

function sleepSync(ms: number): void {
	Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}
