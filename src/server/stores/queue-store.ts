import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config/constants.js";
import { tryParseJson } from "../../utils/json.js";

type QueueMode = "one" | "all";

export interface QueuedPrompt {
	id: number;
	text?: string;
	createdAt?: number;
}

export interface QueueSessionState {
	mode: QueueMode;
	pending: QueuedPrompt[];
}

interface QueueStateFile {
	sessions: Record<string, QueueSessionState>;
}

const QUEUE_STATE_PATH =
	process.env.COMPOSER_QUEUE_STATE ?? join(getAgentDir(), "queue-state.json");

const MAX_SESSIONS = 200;
const MAX_AGE_MS =
	Number.parseInt(
		process.env.COMPOSER_QUEUE_MAX_AGE_MS || `${7 * 24 * 60 * 60 * 1000}`,
		10,
	) || 7 * 24 * 60 * 60 * 1000;
const KEY_REGEX = /^[A-Za-z0-9._-]+$/;

function sanitizeKey(key: string): string | null {
	if (!KEY_REGEX.test(key)) return null;
	return key;
}

function normalizeState(raw: unknown): QueueStateFile {
	if (!raw || typeof raw !== "object" || !("sessions" in raw)) {
		return { sessions: {} };
	}
	const sessions = (raw as { sessions?: unknown }).sessions;
	if (!sessions || typeof sessions !== "object") return { sessions: {} };
	const result: Record<string, QueueSessionState> = {};
	for (const [k, v] of Object.entries(sessions as Record<string, unknown>)) {
		const key = sanitizeKey(k);
		if (!key) continue;
		const state = v as Partial<QueueSessionState>;
		const mode =
			state.mode === "one" || state.mode === "all" ? state.mode : "all";
		const pending: QueuedPrompt[] = [];
		if (Array.isArray(state.pending)) {
			for (const p of state.pending) {
				const id =
					typeof (p as { id?: unknown }).id === "number"
						? (p as { id: number }).id
						: null;
				if (id === null) continue;
				pending.push({
					id,
					text:
						typeof (p as { text?: unknown }).text === "string"
							? (p as { text: string }).text
							: undefined,
					createdAt:
						typeof (p as { createdAt?: unknown }).createdAt === "number"
							? (p as { createdAt: number }).createdAt
							: undefined,
				});
			}
		}
		result[key] = { mode, pending };
	}
	const entries = Object.entries(result);
	if (entries.length > MAX_SESSIONS) {
		entries.splice(0, entries.length - MAX_SESSIONS);
		return { sessions: Object.fromEntries(entries) };
	}
	return { sessions: result };
}

export function loadQueueState(): QueueStateFile {
	if (!existsSync(QUEUE_STATE_PATH)) return { sessions: {} };
	const raw = tryParseJson(readFileSync(QUEUE_STATE_PATH, "utf-8"));
	return normalizeState(raw);
}

export function saveQueueState(state: QueueStateFile): void {
	const normalized = normalizeState(state);
	// Prune old pending items
	const now = Date.now();
	for (const session of Object.values(normalized.sessions)) {
		if (!Array.isArray(session.pending)) continue;
		session.pending = session.pending.filter((p) => {
			if (!p.createdAt) return true;
			return now - p.createdAt <= MAX_AGE_MS;
		});
	}
	mkdirSync(dirname(QUEUE_STATE_PATH), { recursive: true });
	writeFileSync(QUEUE_STATE_PATH, JSON.stringify(normalized, null, 2), "utf-8");
}

export function getSessionQueue(
	state: QueueStateFile,
	sessionId: string,
	defaultMode: QueueMode,
): QueueSessionState {
	const key = sanitizeKey(sessionId);
	if (!key) {
		throw new Error("Invalid sessionId format");
	}
	if (!state.sessions[key]) {
		state.sessions[key] = { mode: defaultMode, pending: [] };
	}
	return state.sessions[key];
}
