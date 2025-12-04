import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
	process.env.COMPOSER_QUEUE_STATE ??
	join(homedir(), ".composer", "agent", "queue-state.json");

const MAX_SESSIONS = 200;
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
		const pending = Array.isArray(state.pending)
			? state.pending
					.map((p) => ({
						id:
							typeof (p as { id?: unknown }).id === "number"
								? (p as { id: number }).id
								: undefined,
						text:
							typeof (p as { text?: unknown }).text === "string"
								? (p as { text: string }).text
								: undefined,
						createdAt:
							typeof (p as { createdAt?: unknown }).createdAt === "number"
								? (p as { createdAt: number }).createdAt
								: undefined,
					}))
					.filter((p) => typeof p.id === "number")
			: [];
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
	try {
		const raw = JSON.parse(readFileSync(QUEUE_STATE_PATH, "utf-8")) as unknown;
		return normalizeState(raw);
	} catch {
		return { sessions: {} };
	}
}

export function saveQueueState(state: QueueStateFile): void {
	const normalized = normalizeState(state);
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
