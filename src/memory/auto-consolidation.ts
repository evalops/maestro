import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getLastAssistantMessage } from "../agent/index.js";
import type { Agent, Api, Model, TextContent } from "../agent/index.js";
import { PATHS } from "../config/constants.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import {
	applyAutoMemoryConsolidation,
	listAutoDurableMemories,
} from "./store.js";

const logger = createLogger("memory:auto-consolidation");

const MEMORY_DIR = join(PATHS.MAESTRO_HOME, "memory");
const CONSOLIDATION_STATE_FILE = join(MEMORY_DIR, "consolidation-state.json");
const CONSOLIDATION_LOCK_FILE = join(MEMORY_DIR, "consolidation.lock");
const CONSOLIDATION_DEBOUNCE_MS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_CONSOLIDATION_DEBOUNCE_MS || "5000",
		10,
	) || 5000;
const MIN_AUTO_MEMORIES =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_MEMORIES || "5",
		10,
	) || 5;
const MIN_HOURS_BETWEEN_RUNS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS || "24",
		10,
	) || 24;
const LOCK_STALE_MS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_CONSOLIDATION_LOCK_STALE_MS ||
			`${30 * 60 * 1000}`,
		10,
	) || 30 * 60 * 1000;
const MAX_INPUT_MEMORIES =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MAX_INPUTS || "48",
		10,
	) || 48;
const MAX_UPSERTS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MAX_UPSERTS || "16",
		10,
	) || 16;

interface ConsolidationState {
	lastConsolidatedAt?: number;
	lastSourceHash?: string;
}

interface ConsolidationPlan {
	removeIds: string[];
	upserts: Array<{
		topic: string;
		content: string;
		tags?: string[];
	}>;
}

interface ConsolidationPayload {
	removeIds: string[];
	upserts: ConsolidationPlan["upserts"];
}

export interface AutomaticMemoryConsolidationCoordinator {
	schedule(): void;
	flush(): Promise<void>;
}

interface AutomaticMemoryConsolidationOptions {
	createAgent: () => Promise<Agent>;
	getModel: () => Model<Api>;
}

const MEMORY_CONSOLIDATION_SYSTEM_PROMPT = `
You consolidate automatic durable memories into a smaller canonical set.

You will receive the current automatic durable memories with stable ids.
Merge duplicates, fold overlapping memories together, and remove obsolete or
redundant items. Preserve distinct useful facts.

Output ONLY valid JSON with this shape:
{"removeIds":["mem_1"],"upserts":[{"topic":"lowercase-topic","content":"concise standalone sentence","tags":["tag"]}]}

Rules:
- removeIds must refer only to the provided ids.
- Use removeIds for entries that should disappear after consolidation.
- Upserts are the canonical memories that should remain or be added.
- Use lowercase kebab-case topics.
- Keep content concise, specific, and standalone.
- Return {"removeIds":[],"upserts":[]} when no consolidation is needed.
- Do not wrap the JSON in Markdown.
`.trim();

function ensureMemoryDir(): void {
	if (!existsSync(MEMORY_DIR)) {
		mkdirSync(MEMORY_DIR, { recursive: true });
	}
}

function loadState(): ConsolidationState {
	ensureMemoryDir();
	if (!existsSync(CONSOLIDATION_STATE_FILE)) {
		return {};
	}
	try {
		return JSON.parse(
			readFileSync(CONSOLIDATION_STATE_FILE, "utf8"),
		) as ConsolidationState;
	} catch (error) {
		logger.warn("Failed to load memory consolidation state", {
			error: error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}

function saveState(state: ConsolidationState): void {
	ensureMemoryDir();
	writeFileSync(
		CONSOLIDATION_STATE_FILE,
		JSON.stringify(state, null, 2),
		"utf8",
	);
}

function tryAcquireLock(): boolean {
	ensureMemoryDir();
	try {
		if (existsSync(CONSOLIDATION_LOCK_FILE)) {
			const ageMs = Date.now() - statSync(CONSOLIDATION_LOCK_FILE).mtimeMs;
			if (ageMs < LOCK_STALE_MS) {
				return false;
			}
			unlinkSync(CONSOLIDATION_LOCK_FILE);
		}
		writeFileSync(
			CONSOLIDATION_LOCK_FILE,
			JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
			{
				encoding: "utf8",
				flag: "wx",
			},
		);
		return true;
	} catch {
		return false;
	}
}

function releaseLock(): void {
	try {
		if (existsSync(CONSOLIDATION_LOCK_FILE)) {
			unlinkSync(CONSOLIDATION_LOCK_FILE);
		}
	} catch (error) {
		logger.warn("Failed to release memory consolidation lock", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function computeSourceHash(
	memories: Array<{
		topic: string;
		content: string;
		tags?: string[];
	}>,
): string {
	const normalized = memories
		.map((memory) => ({
			topic: memory.topic.trim().toLowerCase(),
			content: memory.content.replace(/\s+/g, " ").trim().toLowerCase(),
			tags: (memory.tags ?? [])
				.map((tag) => tag.trim().toLowerCase())
				.filter(Boolean)
				.sort(),
		}))
		.sort((left, right) =>
			`${left.topic}\u0000${left.content}\u0000${left.tags.join(",")}`.localeCompare(
				`${right.topic}\u0000${right.content}\u0000${right.tags.join(",")}`,
			),
		);
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function buildConsolidationPrompt(
	memories: ReturnType<typeof listAutoDurableMemories>,
): string {
	const lines = [
		"Consolidate these automatic durable memories into a smaller canonical set.",
		`Review ${memories.length} memories.`,
		"",
		"Memories:",
	];
	for (const memory of memories) {
		lines.push(
			JSON.stringify({
				id: memory.id,
				topic: memory.topic,
				content: memory.content,
				tags: memory.tags ?? [],
			}),
		);
	}
	return lines.join("\n");
}

function extractAssistantText(agent: Agent): string {
	const assistant = getLastAssistantMessage(agent.state.messages);
	if (!assistant) {
		return "";
	}
	return assistant.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function extractJsonDocument(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return trimmed;
	}
	if (trimmed.startsWith("```")) {
		return trimmed
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return trimmed.slice(start, end + 1);
	}
	return trimmed;
}

function isConsolidationPayload(value: unknown): value is ConsolidationPayload {
	if (!value || typeof value !== "object") {
		return false;
	}
	const payload = value as Record<string, unknown>;
	const removeIdsValid =
		Array.isArray(payload.removeIds) &&
		payload.removeIds.every((id) => typeof id === "string");
	const upsertsValid =
		Array.isArray(payload.upserts) &&
		payload.upserts.every((entry) => {
			if (!entry || typeof entry !== "object") {
				return false;
			}
			const candidate = entry as Record<string, unknown>;
			return (
				typeof candidate.topic === "string" &&
				typeof candidate.content === "string" &&
				(candidate.tags === undefined ||
					(Array.isArray(candidate.tags) &&
						candidate.tags.every((tag) => typeof tag === "string")))
			);
		});
	return removeIdsValid && upsertsValid;
}

function normalizePlan(
	payload: ConsolidationPayload,
	eligibleIds: Set<string>,
): ConsolidationPlan {
	const removeIds = Array.from(
		new Set(payload.removeIds.filter((id) => eligibleIds.has(id))),
	);
	const upserts = payload.upserts
		.map((upsert) => ({
			topic: upsert.topic.trim().toLowerCase(),
			content: upsert.content.replace(/\s+/g, " ").trim(),
			tags: upsert.tags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
		}))
		.filter((upsert) => upsert.topic && upsert.content)
		.slice(0, MAX_UPSERTS);
	return { removeIds, upserts };
}

async function consolidateMemories(params: {
	createAgent: () => Promise<Agent>;
	memories: ReturnType<typeof listAutoDurableMemories>;
}): Promise<ConsolidationPlan> {
	const agent = await params.createAgent();
	await agent.prompt(buildConsolidationPrompt(params.memories));
	const raw = extractAssistantText(agent);
	if (!raw) {
		throw new Error("Memory consolidator returned no assistant text");
	}
	const parsed = safeJsonParse<unknown>(
		extractJsonDocument(raw),
		"automatic durable memory consolidation",
	);
	if (!parsed.success || !isConsolidationPayload(parsed.data)) {
		throw new Error("Memory consolidator returned invalid JSON payload");
	}
	const eligibleIds = new Set(params.memories.map((memory) => memory.id));
	return normalizePlan(parsed.data, eligibleIds);
}

export function createAutomaticMemoryConsolidationCoordinator(
	options: AutomaticMemoryConsolidationOptions,
): AutomaticMemoryConsolidationCoordinator {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let scheduled = false;
	let running: Promise<void> | null = null;

	const runPending = async (): Promise<void> => {
		if (running) {
			return running;
		}
		running = (async () => {
			while (scheduled) {
				scheduled = false;
				const state = loadState();
				const now = Date.now();
				if (
					state.lastConsolidatedAt &&
					now - state.lastConsolidatedAt <
						MIN_HOURS_BETWEEN_RUNS * 60 * 60 * 1000
				) {
					continue;
				}

				const memories = listAutoDurableMemories().slice(0, MAX_INPUT_MEMORIES);
				if (memories.length < MIN_AUTO_MEMORIES) {
					continue;
				}
				const sourceHash = computeSourceHash(memories);
				if (state.lastSourceHash === sourceHash) {
					continue;
				}
				if (!tryAcquireLock()) {
					continue;
				}

				try {
					const plan = await consolidateMemories({
						createAgent: options.createAgent,
						memories,
					});
					const result = applyAutoMemoryConsolidation(plan);
					const finalizedHash = computeSourceHash(listAutoDurableMemories());
					saveState({
						lastConsolidatedAt: now,
						lastSourceHash: finalizedHash,
					});
					logger.info("Consolidated automatic durable memories", {
						model: options.getModel().id,
						sourceCount: memories.length,
						removed: result.removed,
						added: result.added,
						updated: result.updated,
					});
				} catch (error) {
					logger.warn("Automatic durable memory consolidation failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					releaseLock();
				}
			}
		})().finally(() => {
			running = null;
		});
		return running;
	};

	const schedule = (): void => {
		scheduled = true;
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			void runPending();
		}, CONSOLIDATION_DEBOUNCE_MS);
		if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
			timer.unref();
		}
	};

	const flush = async (): Promise<void> => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (scheduled) {
			await runPending();
		} else if (running) {
			await running;
		}
	};

	return { schedule, flush };
}

export function getMemoryConsolidationSystemPrompt(): string {
	return MEMORY_CONSOLIDATION_SYSTEM_PROMPT;
}
