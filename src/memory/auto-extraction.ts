import { createHash } from "node:crypto";
import { getLastAssistantMessage } from "../agent/index.js";
import type { Agent, Api, Model, TextContent } from "../agent/index.js";
import { buildSessionMemoryContent } from "../session/session-memory.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { getDurableMemoryBackend } from "./backend.js";
import { upsertDurableMemory } from "./store.js";

const logger = createLogger("memory:auto-extraction");

const EXTRACTION_DEBOUNCE_MS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_EXTRACTION_DEBOUNCE_MS || "1500",
		10,
	) || 1500;
const MIN_ASSISTANT_TURNS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_EXTRACTION_MIN_ASSISTANT_TURNS || "1",
		10,
	) || 1;
const MIN_CONTENT_CHARS =
	Number.parseInt(
		process.env.MAESTRO_MEMORY_EXTRACTION_MIN_CONTENT_CHARS || "220",
		10,
	) || 220;
const MAX_EXTRACTED_MEMORIES =
	Number.parseInt(process.env.MAESTRO_MEMORY_EXTRACTION_MAX_ITEMS || "8", 10) ||
	8;

const MEMORY_EXTRACTION_SYSTEM_PROMPT = `
You extract durable cross-session memory from a session summary.

Only keep information that is likely to matter in future sessions:
- stable user or project preferences
- durable conventions, constraints, or workflows
- ongoing project state that will still matter later
- recurring setup facts that are expensive to rediscover

Do not keep:
- transient next steps
- one-off debugging output
- temporary status updates
- generic facts already obvious from the repository

Output ONLY valid JSON with this shape:
{"memories":[{"topic":"lowercase-topic","content":"concise standalone sentence","tags":["tag"]}]}

Rules:
- Return {"memories":[]} when nothing qualifies.
- Use lowercase kebab-case topics.
- Keep content concise and specific.
- Do not duplicate the same idea with different wording.
- Do not wrap the JSON in Markdown.
`.trim();

interface ExtractedMemoryCandidate {
	topic: string;
	content: string;
	tags?: string[];
}

interface ExtractionPayload {
	memories: ExtractedMemoryCandidate[];
}

export interface AutomaticMemoryExtractionCoordinator {
	schedule(sessionPath?: string | null): void;
	flush(): Promise<void>;
}

interface AutomaticMemoryExtractionOptions {
	createAgent: () => Promise<Agent>;
	getModel: () => Model<Api>;
	onProcessed?: () => void;
	sessionManager: {
		getSessionFile(): string | null | undefined;
		flush(): Promise<void>;
		saveSessionMemoryExtractionHash(hash: string, sessionPath?: string): void;
	};
}

function buildExtractionPrompt(sessionMemory: string): string {
	return [
		"Extract durable cross-session memories from this session snapshot.",
		`Return at most ${MAX_EXTRACTED_MEMORIES} memories.`,
		"",
		"Session snapshot:",
		"```text",
		sessionMemory,
		"```",
	].join("\n");
}

function hashSessionMemory(content: string): string {
	const stableContent = content
		.split("\n")
		.filter((line) => !line.startsWith("- Updated: "))
		.join("\n");
	return createHash("sha256").update(stableContent).digest("hex");
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) {
		return trimmed;
	}
	return trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
}

function extractJsonDocument(text: string): string {
	const stripped = stripCodeFence(text);
	if (stripped.startsWith("{") && stripped.endsWith("}")) {
		return stripped;
	}
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return stripped.slice(start, end + 1);
	}
	return stripped;
}

function isExtractedMemoryCandidate(
	value: unknown,
): value is ExtractedMemoryCandidate {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.topic === "string" &&
		typeof candidate.content === "string" &&
		(candidate.tags === undefined ||
			(Array.isArray(candidate.tags) &&
				candidate.tags.every((tag) => typeof tag === "string")))
	);
}

function isExtractionPayload(value: unknown): value is ExtractionPayload {
	if (!value || typeof value !== "object") {
		return false;
	}
	const payload = value as Record<string, unknown>;
	return (
		Array.isArray(payload.memories) &&
		payload.memories.every((candidate) => isExtractedMemoryCandidate(candidate))
	);
}

function normalizeCandidate(
	candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate | null {
	const topic = candidate.topic.trim().toLowerCase();
	const content = candidate.content.replace(/\s+/g, " ").trim();
	const tags = candidate.tags
		?.map((tag) => tag.trim().toLowerCase())
		.filter(Boolean);
	if (!topic || !content) {
		return null;
	}
	return {
		topic,
		content,
		tags: tags?.length ? Array.from(new Set(tags)).sort() : undefined,
	};
}

function dedupeCandidates(
	candidates: ExtractedMemoryCandidate[],
): ExtractedMemoryCandidate[] {
	const seen = new Set<string>();
	const deduped: ExtractedMemoryCandidate[] = [];
	for (const candidate of candidates) {
		const normalized = normalizeCandidate(candidate);
		if (!normalized) {
			continue;
		}
		const key = `${normalized.topic}\u0000${normalized.content.toLowerCase()}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(normalized);
		if (deduped.length >= MAX_EXTRACTED_MEMORIES) {
			break;
		}
	}
	return deduped;
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

async function extractDurableMemories(params: {
	createAgent: () => Promise<Agent>;
	sessionMemory: string;
}): Promise<ExtractedMemoryCandidate[]> {
	const agent = await params.createAgent();
	const prompt = buildExtractionPrompt(params.sessionMemory);
	await agent.prompt(prompt);

	const raw = extractAssistantText(agent);
	if (!raw) {
		throw new Error("Memory extractor returned no assistant text");
	}
	const parsed = safeJsonParse<unknown>(
		extractJsonDocument(raw),
		"automatic durable memory extraction",
	);
	if (!parsed.success || !isExtractionPayload(parsed.data)) {
		throw new Error("Memory extractor returned invalid JSON payload");
	}
	return dedupeCandidates(parsed.data.memories);
}

export function createAutomaticMemoryExtractionCoordinator(
	options: AutomaticMemoryExtractionOptions,
): AutomaticMemoryExtractionCoordinator {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let queuedSessionPath: string | null = null;
	let running: Promise<void> | null = null;

	const runPending = async (): Promise<void> => {
		if (running) {
			return running;
		}
		running = (async () => {
			while (queuedSessionPath) {
				const sessionPath = queuedSessionPath;
				queuedSessionPath = null;
				try {
					await options.sessionManager.flush();
					const snapshot = buildSessionMemoryContent(sessionPath);
					if (!snapshot) {
						continue;
					}
					if (snapshot.assistantTurnCount < MIN_ASSISTANT_TURNS) {
						continue;
					}
					if (snapshot.content.length < MIN_CONTENT_CHARS) {
						continue;
					}

					const extractionHash = hashSessionMemory(snapshot.content);
					if (snapshot.memoryExtractionHash === extractionHash) {
						continue;
					}
					const memories = await extractDurableMemories({
						createAgent: options.createAgent,
						sessionMemory: snapshot.content,
					});
					let added = 0;
					let updated = 0;
					let remoteAdded = 0;
					let remoteUpdated = 0;
					const durableMemoryBackend = getDurableMemoryBackend();
					for (const memory of memories) {
						try {
							const remoteResult =
								await durableMemoryBackend.upsertDurableMemory(
									memory.topic,
									memory.content,
									{
										tags: ["auto", "durable", ...(memory.tags ?? [])],
										cwd: snapshot.cwd,
									},
								);
							if (remoteResult?.created) {
								remoteAdded += 1;
							} else if (remoteResult?.updated) {
								remoteUpdated += 1;
							}
						} catch (error) {
							logger.warn("Failed to mirror durable memory to remote service", {
								sessionId: snapshot.sessionId,
								topic: memory.topic,
								error: error instanceof Error ? error.message : String(error),
							});
						}
						const result = upsertDurableMemory(memory.topic, memory.content, {
							tags: ["auto", "durable", ...(memory.tags ?? [])],
							cwd: snapshot.cwd,
						});
						if (result.created) {
							added += 1;
						} else if (result.updated) {
							updated += 1;
						}
					}
					options.sessionManager.saveSessionMemoryExtractionHash(
						extractionHash,
						sessionPath,
					);
					options.onProcessed?.();
					logger.info("Updated durable memories from session", {
						sessionId: snapshot.sessionId,
						model: options.getModel().id,
						added,
						updated,
						extracted: memories.length,
						remoteAdded,
						remoteUpdated,
					});
				} catch (error) {
					logger.warn("Automatic durable memory extraction failed", {
						sessionPath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		})().finally(() => {
			running = null;
		});
		return running;
	};

	const schedule = (sessionPath?: string | null): void => {
		const target = sessionPath ?? options.sessionManager.getSessionFile();
		if (!target) {
			return;
		}
		queuedSessionPath = target;
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			void runPending();
		}, EXTRACTION_DEBOUNCE_MS);
		if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
			timer.unref();
		}
	};

	const flush = async (): Promise<void> => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (queuedSessionPath) {
			await runPending();
		} else if (running) {
			await running;
		}
	};

	return { schedule, flush };
}

export function getMemoryExtractionSystemPrompt(): string {
	return MEMORY_EXTRACTION_SYSTEM_PROMPT;
}
