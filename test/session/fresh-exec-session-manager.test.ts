import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentEvent,
	AgentState,
	AppMessage,
} from "../../src/agent/types.js";
import type { PromptMetadata } from "../../src/prompts/types.js";
import { FreshExecSessionManager } from "../../src/session/fresh-exec-session-manager.js";
import { SessionManager } from "../../src/session/manager.js";
import { createRuntimeSessionSummaryUpdater } from "../../src/session/runtime-summary-updater.js";
import type { CompactionEntry, SessionEntry } from "../../src/session/types.js";
import type { SharedMemoryUpdate } from "../../src/shared-memory/client.js";

const sharedMemoryUpdates = vi.hoisted(() => [] as SharedMemoryUpdate[]);
const queueSharedMemoryUpdateMock = vi.hoisted(() =>
	vi.fn((update: SharedMemoryUpdate) => {
		sharedMemoryUpdates.push(update);
	}),
);
const recordPromptVariantSelectedMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/shared-memory/client.js", () => ({
	queueSharedMemoryUpdate: queueSharedMemoryUpdateMock,
}));

vi.mock("../../src/telemetry/maestro-event-bus.js", () => ({
	recordMaestroPromptVariantSelected: recordPromptVariantSelectedMock,
}));

function createMockState(): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages: [],
		systemPrompt: "test system prompt",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			contextWindow: 200000,
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com/v1/messages",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 0.003,
				output: 0.015,
				cacheRead: 0.0003,
				cacheWrite: 0.00375,
			},
			maxTokens: 8192,
		},
		tools: [],
		thinkingLevel: "off",
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

function createPromptMetadata(): PromptMetadata {
	return {
		name: "maestro-agent-system",
		label: "Maestro Agent System",
		surface: "cli",
		version: 7,
		versionId: "prompt-version-7",
		hash: "sha256:test-prompt-hash",
		source: "bundled",
	};
}

function userMessage(text: string): AppMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantMessage(text: string): AppMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function toolBatchSummaryEvent(
	status: string,
): Extract<AgentEvent, { type: "status" }> {
	return {
		type: "status",
		status,
		details: { kind: "tool_batch_summary" },
	};
}

function readEntries(filePath: string): SessionEntry[] {
	return readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
}

function writeSessionFile(
	sessionDir: string,
	fileName: string,
	entries: SessionEntry[],
	mtime?: Date,
): string {
	const filePath = join(sessionDir, fileName);
	writeFileSync(
		filePath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	if (mtime) {
		utimesSync(filePath, mtime, mtime);
	}
	return filePath;
}

describe("FreshExecSessionManager", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;
	let originalCwd: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `maestro-fresh-exec-session-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		originalAgentDir = process.env.MAESTRO_AGENT_DIR;
		originalCwd = process.cwd();
		originalMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_AGENT_DIR = join(tempDir, ".maestro-agent");
		process.env.MAESTRO_HOME = join(tempDir, ".maestro-home");
		process.chdir(tempDir);
		sharedMemoryUpdates.length = 0;
		queueSharedMemoryUpdateMock.mockClear();
		recordPromptVariantSelectedMock.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalAgentDir;
		}
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists compaction entries for fresh exec sessions", async () => {
		const manager = new FreshExecSessionManager({
			sessionDir: join(tempDir, "sessions"),
		});

		manager.startSession(createMockState());
		manager.saveMessage(userMessage("Summarize release notes"));
		manager.saveMessage(assistantMessage("Release notes summarized."));

		const beforeCompaction = manager.buildSessionContext();
		const firstKeptEntryId = beforeCompaction.messageEntries[1]?.id;

		manager.saveCompaction("Earlier release-note request compacted.", 1, 1234, {
			auto: true,
			firstKeptEntryId,
		});
		await manager.flush();

		const afterCompaction = manager.buildSessionContext();
		expect(afterCompaction.messageEntries.length).toBeGreaterThan(0);

		const entries = readEntries(manager.getSessionFile());
		const compaction = entries.find(
			(entry): entry is CompactionEntry => entry.type === "compaction",
		);
		expect(compaction).toMatchObject({
			summary: "Earlier release-note request compacted.",
			firstKeptEntryId,
			tokensBefore: 1234,
			auto: true,
		});
	});

	it("publishes shared-memory updates for session, message, and summary state", async () => {
		const manager = new FreshExecSessionManager({
			sessionDir: join(tempDir, "sessions"),
		});

		manager.startSession(createMockState());
		manager.saveMessage(userMessage("Summarize release notes"));
		manager.saveSessionSummary("Release notes were summarized.");

		await vi.waitFor(() => {
			expect(queueSharedMemoryUpdateMock).toHaveBeenCalledTimes(3);
		});

		expect(sharedMemoryUpdates.map((update) => update.event?.type)).toEqual([
			"maestro.session.started",
			"maestro.message.saved",
			"maestro.session.summary",
		]);
		expect(sharedMemoryUpdates).toEqual([
			expect.objectContaining({
				sessionId: manager.getSessionId(),
				state: expect.objectContaining({
					sessionId: manager.getSessionId(),
					cwd: expect.any(String),
					model: "anthropic/claude-sonnet-4",
					source: "maestro",
				}),
				event: expect.objectContaining({
					type: "maestro.session.started",
				}),
			}),
			expect.objectContaining({
				sessionId: manager.getSessionId(),
				state: expect.objectContaining({
					sessionId: manager.getSessionId(),
					lastMessageRole: "user",
					source: "maestro",
				}),
				event: expect.objectContaining({
					type: "maestro.message.saved",
					payload: expect.objectContaining({
						sessionId: manager.getSessionId(),
						role: "user",
					}),
				}),
			}),
			expect.objectContaining({
				sessionId: manager.getSessionId(),
				state: expect.objectContaining({
					sessionId: manager.getSessionId(),
					summary: "Release notes were summarized.",
					source: "maestro",
				}),
				event: expect.objectContaining({
					type: "maestro.session.summary",
					payload: expect.objectContaining({
						sessionId: manager.getSessionId(),
						length: "Release notes were summarized.".length,
					}),
				}),
			}),
		]);
	});

	it("records prompt variant telemetry when prompt metadata is present", async () => {
		const manager = new FreshExecSessionManager({
			sessionDir: join(tempDir, "sessions"),
		});
		const promptMetadata = createPromptMetadata();
		const state = {
			...createMockState(),
			promptMetadata,
		};

		manager.startSession(state);

		await vi.waitFor(() => {
			expect(recordPromptVariantSelectedMock).toHaveBeenCalledTimes(1);
		});

		const header = manager.getHeader();
		expect(recordPromptVariantSelectedMock).toHaveBeenCalledWith({
			prompt_metadata: promptMetadata,
			correlation: {
				session_id: manager.getSessionId(),
			},
			selected_at: header?.timestamp,
		});
	});

	it("persists memory extraction hashes for fresh exec sessions", async () => {
		const manager = new FreshExecSessionManager({
			sessionDir: join(tempDir, "sessions"),
		});

		manager.startSession(createMockState());
		manager.saveMessage(userMessage("Extract durable memory"));
		manager.saveSessionMemoryExtractionHash("sha256:fresh-exec-memory-hash");
		await manager.flush();

		const entries = readEntries(manager.getSessionFile());
		expect(
			entries.find(
				(entry) =>
					entry.type === "session_meta" &&
					entry.memoryExtractionHash === "sha256:fresh-exec-memory-hash",
			),
		).toMatchObject({
			type: "session_meta",
			memoryExtractionHash: "sha256:fresh-exec-memory-hash",
		});
	});

	it("syncs fresh exec summaries into session memory", async () => {
		const { getTopicMemories } = await import("../../src/memory/index.js");
		const manager = new FreshExecSessionManager({
			sessionDir: join(tempDir, "sessions"),
		});

		manager.startSession(createMockState());
		manager.saveMessage(userMessage("Capture fresh exec session memory"));
		manager.saveSessionSummary("Fresh exec summary should be indexed.");

		await vi.waitFor(() => {
			const entries = getTopicMemories("session-memory", {
				sessionId: manager.getSessionId(),
			});
			expect(entries).toHaveLength(1);
			expect(entries[0]?.content).toContain(
				"Fresh exec summary should be indexed.",
			);
			expect(entries[0]?.content).toContain(
				"Capture fresh exec session memory",
			);
		});
	});

	it("persists runtime resume summaries for fresh exec sessions", async () => {
		const { getTopicMemories } = await import("../../src/memory/index.js");
		const manager = new FreshExecSessionManager({
			sessionDir: join(tempDir, "sessions"),
		});
		const updateSummary = createRuntimeSessionSummaryUpdater(manager);

		manager.startSession(createMockState());
		manager.saveMessage(userMessage("Run the tool batch"));
		updateSummary(toolBatchSummaryEvent("Read 2 files, ran tests"));

		const entries = readEntries(manager.getSessionFile());
		expect(
			entries.find(
				(entry) =>
					entry.type === "session_meta" &&
					entry.summary === "Read 2 files, ran tests",
			),
		).toMatchObject({
			type: "session_meta",
			summary: "Read 2 files, ran tests",
		});
		expect(
			entries.find(
				(entry) =>
					entry.type === "session_meta" &&
					entry.resumeSummary === "Read 2 files, ran tests",
			),
		).toMatchObject({
			type: "session_meta",
			resumeSummary: "Read 2 files, ran tests",
		});

		await vi.waitFor(() => {
			const memories = getTopicMemories("session-memory", {
				sessionId: manager.getSessionId(),
			});
			expect(memories).toHaveLength(1);
			expect(memories[0]?.content).toContain("## Current State");
			expect(memories[0]?.content).toContain("Read 2 files, ran tests");
		});
	});

	it("schedules retention pruning for fresh exec sessions", () => {
		let pruneCallback: (() => void) | undefined;
		const unref = vi.fn();
		const setTimeoutSpy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((
				handler: Parameters<typeof setTimeout>[0],
				_timeout?: Parameters<typeof setTimeout>[1],
				..._args: unknown[]
			) => {
				if (typeof handler === "function") {
					pruneCallback = () => {
						handler(..._args);
					};
				}
				return { unref } as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);

		try {
			const manager = new FreshExecSessionManager({
				sessionDir: join(tempDir, "sessions"),
			});
			const sessionDir = dirname(manager.getSessionFile());
			const oldMtime = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
			const oldSession = writeSessionFile(
				sessionDir,
				"old-session.jsonl",
				[
					{
						type: "session",
						id: "old-session",
						timestamp: oldMtime.toISOString(),
						cwd: tempDir,
					},
				],
				oldMtime,
			);
			const favoriteSession = writeSessionFile(
				sessionDir,
				"favorite-session.jsonl",
				[
					{
						type: "session",
						id: "favorite-session",
						timestamp: oldMtime.toISOString(),
						cwd: tempDir,
					},
					{
						type: "session_meta",
						timestamp: oldMtime.toISOString(),
						favorite: true,
					},
				],
				oldMtime,
			);

			manager.startSession(createMockState());

			expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
			expect(unref).toHaveBeenCalled();
			expect(pruneCallback).toBeTypeOf("function");

			pruneCallback?.();

			expect(existsSync(oldSession)).toBe(false);
			expect(existsSync(favoriteSession)).toBe(true);
			expect(existsSync(manager.getSessionFile())).toBe(true);
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it("leaves resume and history-only session helpers on the full manager", () => {
		const fullManager = new SessionManager(false, undefined, {
			sessionDir: join(tempDir, "sessions"),
		});

		expect(typeof fullManager.buildSessionContext).toBe("function");
		expect(typeof fullManager.saveCompaction).toBe("function");
		expect(typeof fullManager.saveSessionMemoryExtractionHash).toBe("function");
	});
});
